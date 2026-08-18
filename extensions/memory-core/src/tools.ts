// Memory Core plugin module implements tools behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveMemorySearchStaleness,
  stripMemoryAnnotationCarriers,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  asToolParamsRecord,
  jsonResult,
  readFiniteNumberParam,
  readPositiveIntegerParam,
  readStringParam,
  resolveMemoryDreamingPluginConfig,
  resolveMemorySearchConfig,
  type MemoryCorpusSearchResult,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  resolveMemoryDreamingConfig,
  resolveMemoryDeepDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { executeMemoryReadResult, executeWikiMemoryReadResult } from "./memory-read-tool.js";
import {
  buildPausedMemoryIndexUnavailableResult,
  executeMemorySearchToolQuery,
} from "./memory-search-tool-query.js";
import type { MemoryCoreAcquireLocalService } from "./memory/embedding-local-service.js";
import {
  DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
  resolveMemorySearchAbortError,
  runMemorySearchWithDeadline,
} from "./memory/search-deadline.js";
import {
  buildMemoryGetDescription,
  buildMemorySearchDescription,
  resolveMemorySourceContract,
} from "./prompt-section.js";
import { recordShortTermRecalls } from "./short-term-promotion.js";
import {
  decorateCitations,
  resolveMemoryCitationsMode,
  shouldIncludeCitations,
} from "./tools.citations.js";
import {
  buildMemoryCorpusWarning,
  buildMemorySearchUnavailableResult,
  createMemoryTool,
  getMemoryManagerContextWithPurpose,
  loadMemoryToolRuntime,
  MemoryGetSchema,
  MemorySearchSchema,
  searchMemoryCorpusSupplements,
  supplementCorpusOutcome,
  type MemoryCorpusOutcome,
} from "./tools.shared.js";

type MemorySearchToolResult =
  | (MemorySearchResult & { corpus: MemorySource })
  | MemoryCorpusSearchResult;
type MemoryManagerContext = Awaited<ReturnType<typeof getMemoryManagerContextWithPurpose>>;
type ActiveMemoryManagerContext = Extract<MemoryManagerContext, { manager: unknown }>;
type MemorySearchToolQueryDebug = NonNullable<
  Awaited<ReturnType<typeof executeMemorySearchToolQuery>>["debug"]
>;

const MEMORY_SEARCH_TOOL_COOLDOWN_MS = 60_000;

const memorySearchToolCooldowns = new Map<string, { until: number; error: string }>();

/**
 * Validate the model-authored corpus argument against the tool's closed enum.
 * Provider tool schemas do not guarantee enum enforcement; an unknown corpus
 * must fail closed instead of falling through to an unrestricted search that
 * could surface recall-only indexed transcripts.
 */
function readCorpusParam<T extends string>(
  rawParams: Record<string, unknown>,
  allowed: readonly T[],
): T | undefined {
  const raw = readStringParam(rawParams, "corpus");
  if (raw === undefined) {
    return undefined;
  }
  if ((allowed as readonly string[]).includes(raw)) {
    return raw as T;
  }
  throw new Error(`corpus must be one of: ${allowed.join(", ")}`);
}

function resolveMemorySearchToolCooldownKey(options: {
  agentId?: string;
  agentSessionKey?: string;
}): string {
  return options.agentId ?? options.agentSessionKey ?? "default";
}

function readMemorySearchToolCooldown(key: string): { error: string } | undefined {
  const entry = memorySearchToolCooldowns.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.until <= Date.now()) {
    memorySearchToolCooldowns.delete(key);
    return undefined;
  }
  return { error: entry.error };
}

function recordMemorySearchToolCooldown(key: string, error: string): void {
  memorySearchToolCooldowns.set(key, {
    until: Date.now() + MEMORY_SEARCH_TOOL_COOLDOWN_MS,
    error,
  });
}

export const testing = {
  resetMemorySearchToolCooldowns() {
    memorySearchToolCooldowns.clear();
  },
} as const;

function isActiveMemoryManagerContext(
  context: MemoryManagerContext | null,
): context is ActiveMemoryManagerContext {
  return context !== null && "manager" in context;
}

async function closeMemoryManagers(
  managers: Iterable<ActiveMemoryManagerContext["manager"]>,
  parentSignal?: AbortSignal,
): Promise<void> {
  const pending = Array.from(managers, async (manager) => await manager.close?.());
  if (pending.length === 0) {
    return;
  }
  try {
    await runMemorySearchWithDeadline({
      timeoutMs: DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
      parentSignal,
      run: async () => {
        await Promise.allSettled(pending);
      },
    });
  } catch {
    // Search results should not be hidden by best-effort transient cleanup.
  }
}

function mergeRankedMemorySearchToolStreams(
  memoryResults: MemorySearchToolResult[],
  supplementResults: MemorySearchToolResult[],
): MemorySearchToolResult[] {
  const merged: MemorySearchToolResult[] = [];
  let memoryIndex = 0;
  let supplementIndex = 0;
  // Each backend owns its ranking. Memory scores intentionally omit some
  // precedence facts, so compare only stream heads and never reorder a stream.
  while (memoryIndex < memoryResults.length && supplementIndex < supplementResults.length) {
    const memory = memoryResults[memoryIndex];
    const supplement = supplementResults[supplementIndex];
    if ((memory?.score ?? 0) >= (supplement?.score ?? 0)) {
      if (memory) {
        merged.push(memory);
      }
      memoryIndex += 1;
    } else {
      if (supplement) {
        merged.push(supplement);
      }
      supplementIndex += 1;
    }
  }
  merged.push(...memoryResults.slice(memoryIndex), ...supplementResults.slice(supplementIndex));
  return merged;
}

function mergeMemorySearchCorpusResults(params: {
  memoryResults: MemorySearchToolResult[];
  supplementResults: MemorySearchToolResult[];
  maxResults: number;
  balanceCorpora: boolean;
}): MemorySearchToolResult[] {
  const memoryResults = params.memoryResults;
  const supplementResults = params.supplementResults;
  if (!params.balanceCorpora || memoryResults.length === 0 || supplementResults.length === 0) {
    return mergeRankedMemorySearchToolStreams(memoryResults, supplementResults).slice(
      0,
      params.maxResults,
    );
  }

  const perCorpusCap = Math.ceil(params.maxResults / 2);
  let memoryTake = Math.min(perCorpusCap, memoryResults.length);
  let supplementTake = Math.min(perCorpusCap, supplementResults.length);
  while (memoryTake + supplementTake < params.maxResults) {
    const memory = memoryResults[memoryTake];
    const supplement = supplementResults[supplementTake];
    if (!memory && !supplement) {
      break;
    }
    if (!supplement || (memory && memory.score >= supplement.score)) {
      memoryTake += 1;
    } else {
      supplementTake += 1;
    }
  }

  return mergeRankedMemorySearchToolStreams(
    memoryResults.slice(0, memoryTake),
    supplementResults.slice(0, supplementTake),
  ).slice(0, params.maxResults);
}

function buildRecallKey(
  result: Pick<MemorySearchResult, "source" | "path" | "startLine" | "endLine">,
): string {
  return `${result.source}:${result.path}:${result.startLine}:${result.endLine}`;
}

function resolveRecallTrackingResults(
  rawResults: MemorySearchResult[],
  surfacedResults: MemorySearchResult[],
): MemorySearchResult[] {
  if (surfacedResults.length === 0 || rawResults.length === 0) {
    return surfacedResults;
  }
  const rawByKey = new Map<string, MemorySearchResult>();
  for (const raw of rawResults) {
    const key = buildRecallKey(raw);
    if (!rawByKey.has(key)) {
      rawByKey.set(key, raw);
    }
  }
  return surfacedResults.map((surfaced) => rawByKey.get(buildRecallKey(surfaced)) ?? surfaced);
}

function queueShortTermRecallTracking(params: {
  workspaceDir?: string;
  query: string;
  rawResults: MemorySearchResult[];
  surfacedResults: MemorySearchResult[];
  timezone?: string;
}): void {
  const trackingResults = resolveRecallTrackingResults(params.rawResults, params.surfacedResults);
  void recordShortTermRecalls({
    workspaceDir: params.workspaceDir,
    query: params.query,
    results: trackingResults,
    timezone: params.timezone,
  }).catch(() => {
    // Gateway tool calls are latency-sensitive and live in a long-running
    // process, so background best-effort tracking is safe here unlike in the CLI.
  });
}

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  oneShotCliRun?: boolean;
  conversationRecall?: OpenClawPluginToolContext["conversationRecall"];
  activeProjectKeys?: readonly string[];
  acquireLocalService?: MemoryCoreAcquireLocalService;
}) {
  return createMemoryTool({
    options,
    label: "Memory Search",
    name: "memory_search",
    description: ({ cfg, agentId }) =>
      buildMemorySearchDescription(resolveMemorySourceContract(cfg, agentId)),
    parameters: MemorySearchSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params, callerSignal) => {
        const rawParams = asToolParamsRecord(params);
        if (callerSignal?.aborted) {
          throw resolveMemorySearchAbortError(callerSignal);
        }
        const query = readStringParam(rawParams, "query", { required: true });
        const maxResults = readPositiveIntegerParam(rawParams, "maxResults");
        const minScore = readFiniteNumberParam(rawParams, "minScore");
        const modelRequestedCorpus = readCorpusParam(rawParams, [
          "memory",
          "wiki",
          "all",
          "sessions",
        ]);
        // The trusted runtime chooses the recall corpus; model-authored arguments cannot broaden it.
        const requestedCorpus =
          options.conversationRecall?.corpus === "sessions" ? "sessions" : modelRequestedCorpus;
        const cooldownKey = resolveMemorySearchToolCooldownKey({
          agentId,
          agentSessionKey: options.agentSessionKey,
        });
        const cooldown =
          requestedCorpus === "wiki" ? undefined : readMemorySearchToolCooldown(cooldownKey);
        const runWithDefaultDeadline = async <T>(
          task: (signal: AbortSignal) => Promise<T>,
        ): Promise<T> =>
          await runMemorySearchWithDeadline({
            timeoutMs: DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
            parentSignal: callerSignal,
            run: task,
          });
        const runMemorySearchTool = async () => {
          const toolStartedAt = Date.now();
          const shouldQuerySupplements = requestedCorpus === "wiki" || requestedCorpus === "all";
          const shouldQueryMemory = requestedCorpus !== "wiki";
          const memoryManagerPurpose = options.oneShotCliRun ? "cli" : undefined;
          const memoryManagersToClose = new Set<ActiveMemoryManagerContext["manager"]>();
          let cleanupStarted = false;
          const trackMemoryManager = (context: MemoryManagerContext): MemoryManagerContext => {
            if (memoryManagerPurpose === "cli" && isActiveMemoryManagerContext(context)) {
              if (cleanupStarted) {
                // Setup can settle after its deadline. Close that late transient
                // manager instead of leaking it after the tool has returned.
                void closeMemoryManagers([context.manager]);
              } else {
                memoryManagersToClose.add(context.manager);
              }
            }
            return context;
          };
          try {
            const citationsMode = resolveMemoryCitationsMode(cfg);
            const includeCitations = shouldIncludeCitations({
              mode: citationsMode,
              sessionKey: options.agentSessionKey,
            });
            const pluginConfig = resolveMemoryDreamingPluginConfig(cfg);
            const dreamingEnabled = resolveMemoryDreamingConfig({
              pluginConfig,
              cfg,
            }).enabled;
            const dreaming = resolveMemoryDeepDreamingConfig({
              pluginConfig,
              cfg,
            });
            let rawResults: MemorySearchResult[] = [];
            let surfacedMemoryResults: Array<MemorySearchResult & { corpus: MemorySource }> = [];
            let provider: string | undefined, model: string | undefined;
            let fallback: unknown;
            let searchMode: string | undefined, pausedIndexIdentityReason: string | undefined;
            let pausedUnavailableResult: ReturnType<
              typeof buildPausedMemoryIndexUnavailableResult
            > | null = null;
            let memoryOutcome: MemoryCorpusOutcome | undefined;
            let staleness:
              | Exclude<ReturnType<typeof resolveMemorySearchStaleness>, null>
              | undefined;
            let searchDebug:
              | (MemorySearchToolQueryDebug & { toolMs?: number; outsideSearchMs?: number })
              | undefined;
            if (shouldQueryMemory) {
              if (cooldown) {
                memoryOutcome = {
                  corpus: "memory",
                  outcome: "unavailable",
                  error: cooldown.error,
                };
              } else {
                try {
                  const memory = await runWithDefaultDeadline(async () =>
                    trackMemoryManager(
                      await getMemoryManagerContextWithPurpose({
                        cfg,
                        agentId,
                        purpose: memoryManagerPurpose,
                        acquireLocalService: options.acquireLocalService,
                      }),
                    ),
                  );
                  if ("error" in memory) {
                    const error = memory.error ?? "memory search unavailable";
                    recordMemorySearchToolCooldown(cooldownKey, error);
                    memoryOutcome = { corpus: "memory", outcome: "unavailable", error };
                  } else {
                    const memorySearchConfig = resolveMemorySearchConfig(cfg, agentId);
                    const defaultSearchSources = memorySearchConfig?.searchSources;
                    const explicitSearchSources: MemorySource[] | undefined =
                      requestedCorpus === "sessions" &&
                      (options.conversationRecall || defaultSearchSources?.includes("sessions"))
                        ? (["sessions"] as MemorySource[])
                        : requestedCorpus === "memory"
                          ? (["memory"] as MemorySource[])
                          : undefined;
                    const resultLimit = maxResults ?? memorySearchConfig?.query.maxResults ?? 10;
                    const executed = await executeMemorySearchToolQuery({
                      initialManager: {
                        manager: memory.manager,
                        managerMs: memory.debug?.managerMs,
                      },
                      refreshManager: async () => {
                        const refreshed = await runWithDefaultDeadline(async () =>
                          trackMemoryManager(
                            await getMemoryManagerContextWithPurpose({
                              cfg,
                              agentId,
                              purpose: memoryManagerPurpose,
                              acquireLocalService: options.acquireLocalService,
                            }),
                          ),
                        );
                        if ("error" in refreshed) {
                          return null;
                        }
                        return {
                          manager: refreshed.manager,
                          managerMs: refreshed.debug?.managerMs,
                        };
                      },
                      query: {
                        text: query,
                        resultLimit,
                        minScore,
                        explicitSources: explicitSearchSources,
                        defaultSources: defaultSearchSources,
                        indexedSources: memorySearchConfig?.sources,
                        requestedCorpus,
                        sessionKey: options.agentSessionKey,
                        activeProjectKeys: options.activeProjectKeys,
                        conversationRecall: options.conversationRecall,
                      },
                      visibility: {
                        cfg,
                        agentId,
                        sandboxed: options.sandboxed === true,
                      },
                      runWithDeadline: runWithDefaultDeadline,
                    });
                    pausedIndexIdentityReason = executed.pausedIndexIdentityReason;
                    if (pausedIndexIdentityReason) {
                      pausedUnavailableResult =
                        buildPausedMemoryIndexUnavailableResult(pausedIndexIdentityReason);
                      memoryOutcome = {
                        corpus: "memory",
                        outcome: "unavailable",
                        error: pausedIndexIdentityReason,
                      };
                    } else {
                      rawResults = executed.rawResults;
                      const status = executed.status;
                      staleness = resolveMemorySearchStaleness(status, agentId) ?? undefined;
                      const payloadResults = rawResults.map((result) => ({
                        ...result,
                        snippet: stripMemoryAnnotationCarriers(result.snippet),
                      }));
                      const decorated = decorateCitations(payloadResults, includeCitations);
                      const memoryResults = decorated;
                      surfacedMemoryResults = memoryResults.map((result) => ({
                        ...result,
                        corpus: result.source,
                      }));
                      if (dreamingEnabled) {
                        queueShortTermRecallTracking({
                          workspaceDir: status.workspaceDir,
                          query,
                          rawResults,
                          surfacedResults: memoryResults,
                          timezone: dreaming.timezone,
                        });
                      }
                      provider = status.provider;
                      model = status.model;
                      fallback = status.fallback;
                      searchMode = executed.searchMode;
                      searchDebug = executed.debug;
                      memoryOutcome = { corpus: "memory", outcome: "ok" };
                    }
                  }
                } catch (error) {
                  if (callerSignal?.aborted) {
                    throw resolveMemorySearchAbortError(callerSignal);
                  }
                  const message = formatErrorMessage(error);
                  recordMemorySearchToolCooldown(cooldownKey, message);
                  memoryOutcome = { corpus: "memory", outcome: "unavailable", error: message };
                }
              }
            }
            if (
              shouldQueryMemory &&
              !shouldQuerySupplements &&
              memoryOutcome?.outcome === "unavailable"
            ) {
              return jsonResult(
                pausedUnavailableResult ?? buildMemorySearchUnavailableResult(memoryOutcome.error),
              );
            }

            const supplementOutcome = shouldQuerySupplements
              ? await searchMemoryCorpusSupplements({
                  query,
                  maxResults,
                  agentId,
                  agentSessionKey: options.agentSessionKey,
                  sandboxed: options.sandboxed,
                  corpus: requestedCorpus,
                  runSearch: async (task) => await runWithDefaultDeadline(async () => await task()),
                })
              : null;
            if (callerSignal?.aborted) {
              throw resolveMemorySearchAbortError(callerSignal);
            }
            // Wiki and memory scores use incomparable scales, so corpus=all first
            // balances candidate selection and then backfills any unused slots.
            const effectiveMax = Math.max(1, maxResults ?? 10);
            const results = mergeMemorySearchCorpusResults({
              memoryResults: surfacedMemoryResults,
              supplementResults: supplementOutcome?.results ?? [],
              maxResults: effectiveMax,
              balanceCorpora: requestedCorpus === "all",
            });
            if (searchDebug) {
              const finalToolMs = Math.max(0, Date.now() - toolStartedAt);
              searchDebug = {
                ...searchDebug,
                toolMs: finalToolMs,
                outsideSearchMs: Math.max(0, finalToolMs - searchDebug.searchMs),
              };
            }
            const corpusOutcomes: MemoryCorpusOutcome[] = [];
            if (requestedCorpus === "all" && memoryOutcome) {
              corpusOutcomes.push(memoryOutcome);
            }
            if (supplementOutcome) {
              corpusOutcomes.push(supplementCorpusOutcome(supplementOutcome));
            }
            const warnings = corpusOutcomes.flatMap((outcome) => {
              const warning = buildMemoryCorpusWarning(outcome);
              return warning ? [warning] : [];
            });
            if (staleness?.warning) {
              warnings.push(staleness.warning);
            }
            return jsonResult({
              results,
              provider,
              model,
              fallback,
              citations: citationsMode,
              mode: searchMode,
              ...(corpusOutcomes.length > 0 ? { corpora: corpusOutcomes } : {}),
              ...staleness,
              ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
              debug: searchDebug,
            });
          } finally {
            cleanupStarted = true;
            await closeMemoryManagers(memoryManagersToClose, callerSignal);
          }
        };
        try {
          const result = await runMemorySearchTool();
          if (callerSignal?.aborted) {
            throw resolveMemorySearchAbortError(callerSignal);
          }
          return result;
        } catch (error) {
          if (callerSignal?.aborted) {
            throw resolveMemorySearchAbortError(callerSignal);
          }
          const message = formatErrorMessage(error);
          if (requestedCorpus !== "wiki" && requestedCorpus !== "all") {
            recordMemorySearchToolCooldown(cooldownKey, message);
          }
          return jsonResult(buildMemorySearchUnavailableResult(message));
        }
      },
  });
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  acquireLocalService?: MemoryCoreAcquireLocalService;
}) {
  return createMemoryTool({
    options,
    label: "Memory Get",
    name: "memory_get",
    description: ({ cfg, agentId }) =>
      buildMemoryGetDescription(resolveMemorySourceContract(cfg, agentId)),
    parameters: MemoryGetSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const rawParams = asToolParamsRecord(params);
        const relPath = readStringParam(rawParams, "path", { required: true });
        const from = readPositiveIntegerParam(rawParams, "from");
        const lines = readPositiveIntegerParam(rawParams, "lines");
        const requestedCorpus = readCorpusParam(rawParams, ["memory", "wiki", "all"]);
        const { readAgentMemoryFile } = await loadMemoryToolRuntime();
        if (requestedCorpus === "wiki") {
          return await executeWikiMemoryReadResult({
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
            agentId,
            agentSessionKey: options.agentSessionKey,
            sandboxed: options.sandboxed,
            requestedCorpus,
          });
        }
        return await executeMemoryReadResult({
          read: async () =>
            await readAgentMemoryFile({
              cfg,
              agentId,
              relPath,
              from: from ?? undefined,
              lines: lines ?? undefined,
            }),
          requestedCorpus,
          relPath,
          from: from ?? undefined,
          lines: lines ?? undefined,
          agentId,
          agentSessionKey: options.agentSessionKey,
          sandboxed: options.sandboxed,
        });
      },
  });
}
