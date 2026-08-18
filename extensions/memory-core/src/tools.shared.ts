// Memory Core plugin module implements tools.shared behavior.
import { optionalFiniteNumberSchema, stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  listMemoryCorpusSupplements,
  resolveMemorySearchConfig,
  resolveSessionAgentIds,
  type MemoryCorpusSearchResult,
  type AnyAgentTool,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import type { MemoryCoreAcquireLocalService } from "./memory/embedding-local-service.js";
type MemorySearchManagerResult = Awaited<
  ReturnType<(typeof import("./memory/index.js"))["getMemorySearchManager"]>
>;
type MemoryCorpusSupplementRegistration = ReturnType<typeof listMemoryCorpusSupplements>[number];
type MemoryCorpusGetResult = NonNullable<
  Awaited<ReturnType<MemoryCorpusSupplementRegistration["supplement"]["get"]>>
>;
type MemoryToolOptions = {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  oneShotCliRun?: boolean;
  acquireLocalService?: MemoryCoreAcquireLocalService;
};

export const loadMemoryToolRuntime = createLazyRuntimeModule(() => import("./tools.runtime.js"));

export const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
  minScore: optionalFiniteNumberSchema(),
  corpus: Type.Optional(stringEnum(["memory", "wiki", "all", "sessions"])),
});

export const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Integer()),
  lines: Type.Optional(Type.Integer()),
  corpus: Type.Optional(stringEnum(["memory", "wiki", "all"])),
});

function resolveMemoryToolAgentContext(options: MemoryToolOptions) {
  const cfg = options.getConfig ? options.getConfig() : options.config;
  if (!cfg) {
    return null;
  }
  const { sessionAgentId: agentId } = resolveSessionAgentIds({
    sessionKey: options.agentSessionKey,
    config: cfg,
    agentId: options.agentId,
  });
  return { cfg, agentId };
}

function resolveMemoryToolContext(options: MemoryToolOptions) {
  const context = resolveMemoryToolAgentContext(options);
  return context && resolveMemorySearchConfig(context.cfg, context.agentId) ? context : null;
}

export async function getMemoryManagerContextWithPurpose(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status" | "cli";
  acquireLocalService?: MemoryCoreAcquireLocalService;
}): Promise<
  | {
      manager: NonNullable<MemorySearchManagerResult["manager"]>;
      debug?: NonNullable<MemorySearchManagerResult["debug"]>;
    }
  | {
      error: string | undefined;
    }
> {
  const { getMemorySearchManager } = await loadMemoryToolRuntime();
  const startedAt = Date.now();
  const { manager, debug, error } = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
    purpose: params.purpose,
    ...(params.acquireLocalService ? { acquireLocalService: params.acquireLocalService } : {}),
  });
  return manager
    ? {
        manager,
        debug: {
          backend: debug?.backend ?? "builtin",
          purpose: debug?.purpose ?? params.purpose ?? "default",
          managerMs: debug?.managerMs ?? Math.max(0, Date.now() - startedAt),
        },
      }
    : { error };
}

export function createMemoryTool(params: {
  options: MemoryToolOptions;
  label: string;
  name: string;
  description: (ctx: { cfg: OpenClawConfig; agentId: string }) => string;
  parameters: typeof MemorySearchSchema | typeof MemoryGetSchema;
  execute: (ctx: { cfg: OpenClawConfig; agentId: string }) => AnyAgentTool["execute"];
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(params.options);
  if (!ctx) {
    return null;
  }
  return {
    label: params.label,
    name: params.name,
    get description() {
      return params.description(resolveMemoryToolAgentContext(params.options) ?? ctx);
    },
    parameters: params.parameters,
    execute: async (toolCallId, toolParams, signal, onUpdate) => {
      const latestCtx = params.options.getConfig ? resolveMemoryToolContext(params.options) : ctx;
      // A live getter makes missing or disabled current config a revocation.
      // The captured context is valid only for fixed-snapshot callers.
      if (!latestCtx) {
        throw new Error(
          "Memory is disabled for this agent. Enable memory search for this agent, then retry.",
        );
      }
      return await params.execute(latestCtx)(toolCallId, toolParams, signal, onUpdate);
    },
  };
}

export function buildMemorySearchUnavailableResult(
  error: string | undefined,
  overrides?: {
    warning?: string;
    action?: string;
  },
) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
  const normalizedReason = normalizeLowercaseStringOrEmpty(reason);
  const isQuotaError = /insufficient_quota|quota|429/.test(normalizedReason);
  const isMissingNodeSqlite = /missing node:sqlite|no such built-?in module: node:sqlite/.test(
    normalizedReason,
  );
  const warning =
    overrides?.warning ??
    (isQuotaError
      ? "Memory search is unavailable because the embedding provider quota is exhausted."
      : isMissingNodeSqlite
        ? "Memory search is unavailable because this OpenClaw Node runtime does not provide SQLite support."
        : "Memory search is unavailable due to an embedding/provider error.");
  const action =
    overrides?.action ??
    (isQuotaError
      ? "Top up or switch embedding provider, then retry memory_search."
      : isMissingNodeSqlite
        ? "Run OpenClaw with a Node runtime that includes node:sqlite, then retry memory_search."
        : "Check embedding provider configuration and retry memory_search.");
  return {
    results: [],
    disabled: true,
    unavailable: true,
    error: reason,
    warning,
    action,
    debug: {
      warning,
      action,
      error: reason,
    },
  };
}

type MemorySupplementSearchOutcome =
  | { outcome: "ok"; results: MemoryCorpusSearchResult[] }
  | { outcome: "not-registered"; results: [] }
  | { outcome: "unavailable"; results: MemoryCorpusSearchResult[]; error: string };

type MemorySupplementReadOutcome =
  | { outcome: "ok"; result: (Omit<MemoryCorpusGetResult, "content"> & { text: string }) | null }
  | { outcome: "not-registered"; result: null }
  | {
      outcome: "unavailable";
      result: (Omit<MemoryCorpusGetResult, "content"> & { text: string }) | null;
      error: string;
    };

export type MemoryCorpusOutcome =
  | { corpus: "memory" | "wiki"; outcome: "ok" }
  | { corpus: "memory" | "wiki"; outcome: "not-registered" }
  | { corpus: "memory" | "wiki"; outcome: "unavailable"; error: string };

export function buildMemoryCorpusWarning(outcome: MemoryCorpusOutcome): string | undefined {
  if (outcome.outcome === "ok") {
    return undefined;
  }
  const label = outcome.corpus === "memory" ? "Memory" : "Wiki";
  return outcome.outcome === "not-registered"
    ? `${label} corpus is not registered; results do not cover that requested corpus.`
    : `${label} corpus unavailable: ${outcome.error}`;
}

export function supplementCorpusOutcome(
  result:
    | { outcome: "ok" }
    | { outcome: "not-registered" }
    | { outcome: "unavailable"; error: string },
): MemoryCorpusOutcome {
  if (result.outcome === "unavailable") {
    return { corpus: "wiki", outcome: "unavailable", error: result.error };
  }
  return { corpus: "wiki", outcome: result.outcome };
}

type MemorySupplementFailure = { pluginId: string; error: string };

function formatMemorySupplementFailures(failures: MemorySupplementFailure[]): string {
  return failures.length === 1
    ? failures[0]!.error
    : failures.map((entry) => `${entry.pluginId}: ${entry.error}`).join("; ");
}

export async function searchMemoryCorpusSupplements(params: {
  query: string;
  maxResults?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  corpus?: "memory" | "wiki" | "all" | "sessions";
  runSearch?: <T>(task: () => Promise<T>) => Promise<T>;
}): Promise<MemorySupplementSearchOutcome> {
  if (params.corpus === "memory" || params.corpus === "sessions") {
    return { outcome: "ok", results: [] };
  }
  const supplements = listMemoryCorpusSupplements().toSorted((left, right) =>
    left.pluginId.localeCompare(right.pluginId),
  );
  if (supplements.length === 0) {
    return { outcome: "not-registered", results: [] };
  }
  const { runSearch, ...searchParams } = params;
  const settled: Array<
    { pluginId: string; results: MemoryCorpusSearchResult[] } | { pluginId: string; error: string }
  > = await Promise.all(
    supplements.map(async (registration) => {
      try {
        const search = async () => await registration.supplement.search(searchParams);
        return {
          pluginId: registration.pluginId,
          results: runSearch ? await runSearch(search) : await search(),
        };
      } catch (error) {
        return { pluginId: registration.pluginId, error: formatErrorMessage(error) };
      }
    }),
  );
  const results = settled
    .flatMap((entry) => ("results" in entry ? entry.results : []))
    .toSorted((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.path.localeCompare(right.path);
    })
    .slice(0, Math.max(1, params.maxResults ?? 10));
  const failures = settled.filter((entry): entry is MemorySupplementFailure => "error" in entry);
  if (failures.length === 0) {
    return { outcome: "ok", results };
  }
  return { outcome: "unavailable", results, error: formatMemorySupplementFailures(failures) };
}

export async function readMemoryCorpusSupplements(params: {
  lookup: string;
  fromLine?: number;
  lineCount?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  corpus?: "memory" | "wiki" | "all" | "sessions";
}): Promise<MemorySupplementReadOutcome> {
  if (params.corpus === "memory" || params.corpus === "sessions") {
    return { outcome: "ok", result: null };
  }
  const supplements = listMemoryCorpusSupplements().toSorted((left, right) =>
    left.pluginId.localeCompare(right.pluginId),
  );
  if (supplements.length === 0) {
    return { outcome: "not-registered", result: null };
  }
  const settled = await Promise.all(
    supplements.map(async (registration) => {
      try {
        const result = await registration.supplement.get(params);
        if (!result) {
          return { pluginId: registration.pluginId, result: null };
        }
        const { content, ...rest } = result;
        return { pluginId: registration.pluginId, result: { ...rest, text: content } };
      } catch (error) {
        return { pluginId: registration.pluginId, error: formatErrorMessage(error) };
      }
    }),
  );
  const result = settled.find(
    (
      entry,
    ): entry is { pluginId: string; result: NonNullable<MemorySupplementReadOutcome["result"]> } =>
      "result" in entry && entry.result !== null,
  )?.result;
  const failures = settled.filter((entry): entry is MemorySupplementFailure => "error" in entry);
  if (failures.length === 0) {
    return { outcome: "ok", result: result ?? null };
  }
  return {
    outcome: "unavailable",
    result: result ?? null,
    error: formatMemorySupplementFailures(failures),
  };
}
