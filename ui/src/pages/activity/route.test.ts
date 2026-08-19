// @vitest-environment node
import type { RouteLoaderOptions, RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { page } from "./route.ts";
import { resolveActivityRouteData, type ActivityRouteData } from "./run-inspector-model.ts";

function loadRoute(search: string): ActivityRouteData {
  if (!page.loader) {
    throw new Error("activity route has no loader");
  }
  const location: RouteLocation = { pathname: "/activity", search, hash: "" };
  const loaded = page.loader({} as ApplicationContext, {
    signal: new AbortController().signal,
    shouldRun: () => true,
    revalidating: false,
    location,
    deps: search,
    cause: "navigation",
  } satisfies RouteLoaderOptions);
  return resolveActivityRouteData(typeof loaded === "string" ? loaded : "");
}

describe("resolveActivityRouteData", () => {
  it("opens the session feed by default and decodes its linkable filters", () => {
    expect(loadRoute("")).toEqual({
      mode: "sessions",
      filters: { personId: null, query: "", time: "7d" },
      selector: null,
    });
    expect(loadRoute("?view=other&run=ignored")).toEqual({
      mode: "sessions",
      filters: { personId: null, query: "", time: "7d" },
      selector: null,
    });
    expect(loadRoute("?person=alice&time=30d&q=release")).toEqual({
      mode: "sessions",
      filters: { personId: "alice", query: "release", time: "30d" },
      selector: null,
    });
  });

  it("keeps the browser-local tool feed behind its explicit mode", () => {
    expect(loadRoute("?view=live")).toEqual({ mode: "live", selector: null });
  });

  it("decodes one run-inspector query reference without narrowing it", () => {
    const runId = "run:a/b % lobster";
    expect(loadRoute(`?view=run&run=${encodeURIComponent(runId)}`)).toEqual({
      mode: "run",
      selector: { kind: "run", id: runId },
      receiptId: null,
      decisionCursor: null,
    });
  });

  it("selects one exact execution without also sending the run selector", () => {
    const executionId = "execution:a/b % lobster";
    expect(
      loadRoute(`?view=run&run=ambiguous&execution=${encodeURIComponent(executionId)}`),
    ).toEqual({
      mode: "run",
      selector: { kind: "execution", id: executionId },
      receiptId: null,
      decisionCursor: null,
    });
  });

  it("keeps a run view with an empty selection explicit", () => {
    expect(loadRoute("?view=run")).toEqual({
      mode: "run",
      selector: null,
      receiptId: null,
      decisionCursor: null,
    });
    expect(loadRoute("?view=run&run=%20%20")).toEqual({
      mode: "run",
      selector: null,
      receiptId: null,
      decisionCursor: null,
    });
  });

  it.each([
    ["run", "run:a/b % lobster"],
    ["execution", "execution:a/b % lobster"],
  ] as const)("loads a %s receipt deep link with its bounded-page cursor", (kind, id) => {
    expect(
      loadRoute(
        `?view=run&${kind}=${encodeURIComponent(id)}&receipt=receipt%3A2&decision=a%3A10%3A2`,
      ),
    ).toEqual({
      mode: "run",
      selector: { kind, id },
      receiptId: "receipt:2",
      decisionCursor: "a:10:2",
    });
  });

  it("retains a decision cursor only with a non-empty receipt", () => {
    expect(loadRoute("?view=run&run=run-1&decision=a%3A10%3A2")).toMatchObject({
      receiptId: null,
      decisionCursor: null,
    });
    expect(loadRoute("?view=run&run=run-1&receipt=%20%20&decision=a%3A10%3A2")).toMatchObject({
      receiptId: null,
      decisionCursor: null,
    });
  });
});
