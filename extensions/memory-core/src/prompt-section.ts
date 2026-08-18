// Memory Core plugin module owns model-visible memory contract text.
import {
  resolveMemorySearchConfig,
  type MemoryPromptSectionBuilder,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
const MAX_RENDERED_EXTRA_PATHS = 4;
const MAX_EXTRA_PATH_LABEL_CHARS = 80;

type MemorySourceContract = {
  files: string;
  search: string;
};

function boundedPathLabel(value: string): string {
  const characters = Array.from(value.trim());
  return characters.length <= MAX_EXTRA_PATH_LABEL_CHARS
    ? characters.join("")
    : `${characters.slice(0, MAX_EXTRA_PATH_LABEL_CHARS - 1).join("")}…`;
}

/** Resolve the exact configured source families once for every model-visible description. */
export function resolveMemorySourceContract(
  cfg: OpenClawConfig,
  agentId: string,
): MemorySourceContract {
  const settings = resolveMemorySearchConfig(cfg, agentId);
  const extraPathLabels = Array.from(
    new Set(
      (settings?.extraPaths ?? []).map((entry) => {
        const configuredPath = typeof entry === "string" ? entry : entry.path;
        const pathLabel = boundedPathLabel(configuredPath);
        const pattern = typeof entry === "string" ? "" : entry.pattern?.trim() || "";
        return pattern ? `${pathLabel} [${boundedPathLabel(pattern)}]` : pathLabel;
      }),
    ),
  ).toSorted((left, right) => left.localeCompare(right));
  const visibleExtraPaths = extraPathLabels.slice(0, MAX_RENDERED_EXTRA_PATHS);
  const hiddenExtraPathCount = extraPathLabels.length - visibleExtraPaths.length;
  const fileSources = ["MEMORY.md", "USER.md", "memory/*.md"];
  if (visibleExtraPaths.length > 0) {
    const overflow = hiddenExtraPathCount > 0 ? `, +${hiddenExtraPathCount} more` : "";
    fileSources.push(`configured extra paths (${visibleExtraPaths.join(", ")}${overflow})`);
  }
  const files = fileSources.join(", ");
  const search = settings?.searchSources.includes("sessions")
    ? `${files}, indexed session transcripts`
    : files;
  return { files, search };
}

export function buildMemorySearchDescription(sources: MemorySourceContract): string {
  return `Mandatory recall step: semantically search ${sources.search} before answering questions about prior work, decisions, dates, people, preferences, or todos. Optional \`corpus=wiki\` or \`corpus=all\` also searches registered compiled-wiki supplements. \`corpus=memory\` restricts hits to indexed memory files (excludes session transcript chunks from ranking). \`corpus=sessions\` restricts hits to indexed session transcripts (same visibility rules as session history tools). Corpus warnings mean the returned results are partial and must be surfaced to the user. If response has disabled=true or stale=true, tell the user and include the warning/action guidance.`;
}

export function buildMemoryGetDescription(sources: MemorySourceContract): string {
  return `Safe exact excerpt read from ${sources.files}. Defaults to a bounded excerpt when lines are omitted, includes truncation/continuation info when more content exists, and \`corpus=wiki\` reads from registered compiled-wiki supplements. A response with status=not_found means the requested file does not exist in every requested corpus that was available; corpus warnings mean coverage is partial and must be surfaced to the user.`;
}

export const buildPromptSection = (({
  availableTools,
  citationsMode,
  sourceContract = {
    files: "MEMORY.md, USER.md, memory/*.md",
    search: "MEMORY.md, USER.md, memory/*.md",
  },
}: Parameters<MemoryPromptSectionBuilder>[0] & { sourceContract?: MemorySourceContract }) => {
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");

  if (!hasMemorySearch && !hasMemoryGet) {
    return [];
  }

  let toolGuidance: string;
  if (hasMemorySearch && hasMemoryGet) {
    toolGuidance = `Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on ${sourceContract.search}; then use memory_get to pull only the needed lines. If memory_get returns status=not_found, the file is absent from every requested corpus that was available; surface any corpus warning because coverage is partial. If low confidence after search, say you checked.`;
  } else if (hasMemorySearch) {
    toolGuidance = `Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on ${sourceContract.search} and answer from the matching results. If low confidence after search, say you checked.`;
  } else {
    toolGuidance = `Before answering anything about prior work, decisions, dates, people, preferences, or todos that already point to a specific memory file or note in ${sourceContract.files}: run memory_get to pull only the needed lines. If it returns status=not_found, the file is absent from every requested corpus that was available; surface any corpus warning because coverage is partial. If low confidence after reading, say you checked.`;
  }

  const lines = ["## Memory Recall", toolGuidance];
  if (citationsMode === "off") {
    lines.push(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  } else {
    lines.push(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  }
  lines.push("");
  return lines;
}) satisfies MemoryPromptSectionBuilder;
