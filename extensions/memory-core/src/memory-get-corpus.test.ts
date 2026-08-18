import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetMemoryToolMockState,
  setMemoryReadFileImpl,
  type MemoryReadParams,
} from "./memory-tool-manager.test-mocks.js";
import { createMemoryGetTool } from "./tools.js";
import { asOpenClawConfig, createMemoryGetToolOrThrow } from "./tools.test-helpers.js";

beforeEach(() => {
  clearMemoryPluginState();
  resetMemoryToolMockState();
});

describe("memory_get corpus outcomes", () => {
  it("returns surviving wiki content with primary failure provenance", async () => {
    setMemoryReadFileImpl(async () => {
      throw new Error("path required");
    });
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => ({
        corpus: "wiki",
        path: "entities/alpha.md",
        title: "Alpha",
        kind: "entity",
        content: "Alpha wiki entry",
        fromLine: 3,
        lineCount: 5,
      }),
    });

    const result = await createMemoryGetToolOrThrow().execute("call_get_all_fallback", {
      path: "entities/alpha.md",
      from: 3,
      lines: 5,
      corpus: "all",
    });

    expect(result.details).toEqual({
      corpus: "wiki",
      path: "entities/alpha.md",
      title: "Alpha",
      kind: "entity",
      text: "Alpha wiki entry",
      fromLine: 3,
      lineCount: 5,
      corpora: [
        { corpus: "memory", outcome: "unavailable", error: "path required" },
        { corpus: "wiki", outcome: "ok" },
      ],
      warning: "Memory corpus unavailable: path required",
      error: "path required",
    });
  });

  it("reports an unregistered wiki corpus without claiming the page is missing", async () => {
    const result = await createMemoryGetToolOrThrow().execute("call_get_wiki_not_registered", {
      path: "entities/missing.md",
      corpus: "wiki",
    });

    expect(result.details).toEqual({
      path: "entities/missing.md",
      text: "",
      corpora: [{ corpus: "wiki", outcome: "not-registered" }],
      warning: "Wiki corpus is not registered; results do not cover that requested corpus.",
    });
  });

  it("returns not found when a registered wiki corpus has no matching page", async () => {
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => null,
    });
    const result = await createMemoryGetToolOrThrow().execute("call_get_wiki_missing", {
      path: "entities/missing.md",
      corpus: "wiki",
    });

    expect(result.details).toEqual({
      path: "entities/missing.md",
      text: "",
      status: "not_found",
      corpora: [{ corpus: "wiki", outcome: "ok" }],
    });
  });

  it.each(["wiki", "all"] as const)(
    "forwards effective agent context to memory_get corpus=%s supplements",
    async (corpus) => {
      if (corpus === "all") {
        setMemoryReadFileImpl(async () => {
          throw new Error("memory path missing");
        });
      }
      const get = vi.fn(async () => ({
        corpus: "wiki" as const,
        path: "entities/alpha.md",
        content: "Alpha wiki entry",
        fromLine: 2,
        lineCount: 4,
      }));
      registerMemoryCorpusSupplement("memory-wiki", { search: async () => [], get });
      const config = asOpenClawConfig({
        agents: { list: [{ id: "marketing-agent", default: true }] },
      });
      const tool = createMemoryGetTool({
        config,
        agentId: " Marketing Agent ",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
      });
      if (!tool) {
        throw new Error("expected memory_get tool");
      }

      await tool.execute(`call_get_${corpus}`, {
        path: "entities/alpha.md",
        from: 2,
        lines: 4,
        corpus,
      });

      expect(get).toHaveBeenCalledWith({
        lookup: "entities/alpha.md",
        fromLine: 2,
        lineCount: 4,
        agentId: "marketing-agent",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
        corpus,
      });
    },
  );

  it("falls through from a memory miss to wiki content", async () => {
    setMemoryReadFileImpl(async (params: MemoryReadParams) => ({
      text: "",
      path: params.relPath,
      status: "not_found",
    }));
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => ({
        corpus: "wiki",
        path: "memory/entities/alpha.md",
        title: "Alpha",
        kind: "entity",
        content: "Alpha wiki entry after empty miss",
        fromLine: 3,
        lineCount: 5,
      }),
    });

    const result = await createMemoryGetToolOrThrow().execute("call_get_all_empty_miss_fallback", {
      path: "memory/entities/alpha.md",
      from: 3,
      lines: 5,
      corpus: "all",
    });

    expect(result.details).toEqual({
      corpus: "wiki",
      path: "memory/entities/alpha.md",
      title: "Alpha",
      kind: "entity",
      text: "Alpha wiki entry after empty miss",
      fromLine: 3,
      lineCount: 5,
      corpora: [
        { corpus: "memory", outcome: "ok" },
        { corpus: "wiki", outcome: "ok" },
      ],
    });
  });

  it("preserves a memory miss while reporting an unavailable wiki corpus", async () => {
    setMemoryReadFileImpl(async (params: MemoryReadParams) => ({
      text: "",
      path: params.relPath,
      status: "not_found",
    }));
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => {
        throw new Error("wiki database unavailable");
      },
    });

    const result = await createMemoryGetToolOrThrow().execute("call_get_all_partial_miss", {
      path: "entities/missing.md",
      corpus: "all",
    });

    expect(result.details).toEqual({
      path: "entities/missing.md",
      text: "",
      status: "not_found",
      corpora: [
        { corpus: "memory", outcome: "ok" },
        { corpus: "wiki", outcome: "unavailable", error: "wiki database unavailable" },
      ],
      warning: "Wiki corpus unavailable: wiki database unavailable",
      error: "wiki database unavailable",
    });
  });

  it("uses deterministic surviving wiki content when another supplement fails", async () => {
    registerMemoryCorpusSupplement("z-wiki", {
      search: async () => [],
      get: async () => ({
        corpus: "wiki",
        path: "entities/alpha.md",
        content: "Zeta entry",
        fromLine: 1,
        lineCount: 1,
      }),
    });
    registerMemoryCorpusSupplement("m-broken", {
      search: async () => [],
      get: async () => {
        throw new Error("broken wiki");
      },
    });
    registerMemoryCorpusSupplement("a-wiki", {
      search: async () => [],
      get: async () => ({
        corpus: "wiki",
        path: "entities/alpha.md",
        content: "Alpha entry",
        fromLine: 1,
        lineCount: 1,
      }),
    });

    const result = await createMemoryGetToolOrThrow().execute("call_get_wiki_partial", {
      path: "entities/alpha.md",
      corpus: "wiki",
    });

    expect(result.details).toEqual({
      corpus: "wiki",
      path: "entities/alpha.md",
      text: "Alpha entry",
      fromLine: 1,
      lineCount: 1,
      corpora: [{ corpus: "wiki", outcome: "unavailable", error: "broken wiki" }],
      warning: "Wiki corpus unavailable: broken wiki",
      error: "broken wiki",
    });
  });

  it("preserves an empty in-file range for memory_get corpus=all", async () => {
    setMemoryReadFileImpl(async (params: MemoryReadParams) => ({
      text: "",
      path: params.relPath,
      from: params.from ?? 1,
      lines: 0,
    }));
    const get = vi.fn(async () => ({
      corpus: "wiki" as const,
      path: "memory/entities/alpha.md",
      content: "Alpha wiki entry",
      fromLine: 10,
      lineCount: 5,
    }));
    registerMemoryCorpusSupplement("memory-wiki", { search: async () => [], get });

    const result = await createMemoryGetToolOrThrow().execute("call_get_all_empty_range", {
      path: "memory/entities/alpha.md",
      from: 10,
      lines: 5,
      corpus: "all",
    });

    expect(result.details).toEqual({
      text: "",
      path: "memory/entities/alpha.md",
      from: 10,
      lines: 0,
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("preserves and aggregates primary and wiki failures", async () => {
    setMemoryReadFileImpl(async () => {
      throw new Error("primary read failed");
    });
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => {
        throw new Error("supplement lookup failed");
      },
    });

    const result = await createMemoryGetToolOrThrow().execute("call_get_all_supplement_throws", {
      path: "entities/alpha.md",
      corpus: "all",
    });

    expect(result.details).toEqual({
      path: "entities/alpha.md",
      text: "",
      disabled: true,
      error: "primary read failed; supplement lookup failed",
      corpora: [
        { corpus: "memory", outcome: "unavailable", error: "primary read failed" },
        { corpus: "wiki", outcome: "unavailable", error: "supplement lookup failed" },
      ],
      warning:
        "Memory corpus unavailable: primary read failed Wiki corpus unavailable: supplement lookup failed",
    });
  });
});
