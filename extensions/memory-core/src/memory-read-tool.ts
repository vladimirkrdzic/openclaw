// Memory Core plugin module owns exact read outcomes and supplement fallback.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MemoryReadResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { jsonResult } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  buildMemoryCorpusWarning,
  readMemoryCorpusSupplements,
  supplementCorpusOutcome,
  type MemoryCorpusOutcome,
} from "./tools.shared.js";

type MemoryReadRequest = {
  requestedCorpus?: "memory" | "wiki" | "all";
  relPath: string;
  from?: number;
  lines?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
};

async function readWikiMemoryResult(params: MemoryReadRequest) {
  const supplement = await readMemoryCorpusSupplements({
    lookup: params.relPath,
    fromLine: params.from,
    lineCount: params.lines,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
    corpus: params.requestedCorpus,
  });
  return { supplement, outcome: supplementCorpusOutcome(supplement) };
}

function withCorpusOutcomes<T extends object>(result: T, outcomes: MemoryCorpusOutcome[]) {
  const warnings = outcomes.flatMap((outcome) => {
    const warning = buildMemoryCorpusWarning(outcome);
    return warning ? [warning] : [];
  });
  const errors = outcomes.flatMap((outcome) =>
    outcome.outcome === "unavailable" ? [outcome.error] : [],
  );
  return {
    ...result,
    corpora: outcomes,
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

export async function executeWikiMemoryReadResult(params: MemoryReadRequest) {
  const wiki = await readWikiMemoryResult(params);
  const result =
    wiki.supplement.result ??
    (wiki.supplement.outcome === "ok"
      ? { path: params.relPath, text: "", status: "not_found" as const }
      : { path: params.relPath, text: "" });
  return jsonResult(withCorpusOutcomes(result, [wiki.outcome]));
}

async function resolveMemoryReadFailureResult(params: MemoryReadRequest & { error: unknown }) {
  const error = formatErrorMessage(params.error);
  if (params.requestedCorpus === "all") {
    const wiki = await readWikiMemoryResult(params);
    const result = wiki.supplement.result ?? {
      path: params.relPath,
      text: "",
      disabled: true,
    };
    return jsonResult(
      withCorpusOutcomes(result, [
        { corpus: "memory", outcome: "unavailable", error },
        wiki.outcome,
      ]),
    );
  }
  return jsonResult({
    path: params.relPath,
    text: "",
    disabled: true,
    error,
  });
}

export async function executeMemoryReadResult(
  params: MemoryReadRequest & { read: () => Promise<MemoryReadResult> },
) {
  let result: MemoryReadResult;
  try {
    result = await params.read();
  } catch (error) {
    return await resolveMemoryReadFailureResult({ ...params, error });
  }
  if (params.requestedCorpus === "all" && result.status === "not_found") {
    const wiki = await readWikiMemoryResult(params);
    return jsonResult(
      withCorpusOutcomes(wiki.supplement.result ?? result, [
        { corpus: "memory", outcome: "ok" },
        wiki.outcome,
      ]),
    );
  }
  return jsonResult(result);
}
