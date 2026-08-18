import { describe, expect, it } from "vitest";
// @vitest-environment node
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import {
  classifyRunInspection,
  mergeDecisionPage,
  resolveActivityRouteData,
} from "./run-inspector-model.ts";

function unavailable(
  state: "unknown" | "unsupported" | "ambiguous",
  reasonCode: string,
  remediation: Array<{ code: string; text: string }> = [],
): AuditRunInspectResult {
  return {
    schemaVersion: 1,
    run: { runId: "run-1", status: state === "unknown" ? "unknown" : "known" },
    identity:
      state === "ambiguous"
        ? {
            state,
            reasonCode,
            candidates: [],
            missingEvidence: ["execution.selection"],
            remediation,
          }
        : {
            state,
            reasonCode,
            missingEvidence: ["identity.context"],
            remediation,
          },
    decisions: [],
    coverage: { state: state === "ambiguous" ? "unknown" : state, missingEvidence: [] },
  };
}

describe("classifyRunInspection", () => {
  it.each([
    [unavailable("unknown", "run_not_found"), "not-found"],
    [unavailable("unknown", "identity_context_corrupt"), "corrupt"],
    [
      unavailable("unsupported", "identity_context_unavailable", [
        { code: "run_again_after_expiry", text: "Run again." },
      ]),
      "expired",
    ],
    [unavailable("unsupported", "identity_context_unavailable"), "unsupported"],
    [unavailable("unknown", "run_evidence_unreadable"), "unknown"],
    [unavailable("ambiguous", "execution_selection_required"), "ambiguous"],
  ] as const)("classifies the authoritative diagnostic result as %s", (result, expected) => {
    expect(classifyRunInspection(result)).toBe(expected);
  });
});

describe("receipt paging model", () => {
  it("parses stable receipt links and ignores a cursor without a receipt", () => {
    expect(
      resolveActivityRouteData(
        "?view=run&execution=execution-1&receipt=receipt-2&decision=a%3A10%3A2",
      ),
    ).toEqual({
      mode: "run",
      selector: { kind: "execution", id: "execution-1" },
      receiptId: "receipt-2",
      decisionCursor: "a:10:2",
    });
    expect(resolveActivityRouteData("?view=run&run=run-1&decision=a%3A10%3A2")).toEqual({
      mode: "run",
      selector: { kind: "run", id: "run-1" },
      receiptId: null,
      decisionCursor: null,
    });
  });

  it("appends a page only when the exact execution context still matches", () => {
    const first = unavailable("unknown", "run_not_found");
    expect(mergeDecisionPage(first, first)).toBeNull();

    const present = {
      ...first,
      run: { runId: "run-1", executionId: "execution-1", status: "known" as const },
      identity: {
        state: "present" as const,
        context: {
          schemaVersion: 1 as const,
          contextId: "context-1",
          executionId: "execution-1",
          runId: "run-1",
          createdAt: 1,
          trustDomain: {
            kind: "gateway-cell" as const,
            domainRef: "domain",
            state: "present" as const,
          },
          invoker: { state: "absent" as const },
          ingress: { kind: "local-cli" as const, boundary: "cli", state: "present" as const },
          agentPrincipal: { kind: "agent" as const, domainRef: "domain", principalRef: "main" },
          agentDefinition: { definitionRef: "main", state: "present" as const },
          runtimeInstance: {
            runtimeRef: "runtime",
            kind: "embedded" as const,
            state: "present" as const,
          },
          applicableGrants: [],
          assurance: [],
          coverageState: "attribution-only" as const,
          missingEvidence: [],
        },
      },
      decisions: [],
      coverage: { state: "attribution-only" as const, missingEvidence: [] },
    } satisfies AuditRunInspectResult;
    const page = { ...present, nextDecisionCursor: "g:10:2" };
    expect(mergeDecisionPage(present, page)?.nextDecisionCursor).toBe("g:10:2");
    expect(
      mergeDecisionPage(present, {
        ...page,
        run: { ...page.run, executionId: "execution-2" },
      }),
    ).toBeNull();
  });
});
