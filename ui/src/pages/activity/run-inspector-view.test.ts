/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import type { RunInspectorState } from "./run-inspector-model.ts";
import { renderRunInspector } from "./run-inspector-view.ts";

const hmacRef = `hmac-sha256:v1:${"a".repeat(32)}:${"b".repeat(64)}`;

function presentResult(): AuditRunInspectResult {
  return {
    schemaVersion: 1,
    run: { runId: "run-1", executionId: "execution-1", status: "known" },
    identity: {
      state: "present",
      context: {
        schemaVersion: 1,
        contextId: "context-1",
        executionId: "execution-1",
        runId: "run-1",
        createdAt: 1,
        trustDomain: { kind: "gateway-cell", domainRef: hmacRef, state: "present" },
        invoker: { state: "absent" },
        ingress: {
          kind: "local-cli",
          boundary: "agent-command.local",
          sourceRef: hmacRef,
          state: "present",
        },
        agentPrincipal: {
          kind: "agent",
          domainRef: hmacRef,
          principalRef: "main",
          displayLabel: "Primary agent",
        },
        agentDefinition: { definitionRef: "main", state: "unknown" },
        runtimeInstance: { runtimeRef: hmacRef, kind: "embedded", state: "unsupported" },
        representedSubject: {
          principal: { kind: "person", domainRef: hmacRef, principalRef: hmacRef },
          state: "unknown",
        },
        sponsor: {
          principal: { kind: "service", domainRef: hmacRef, principalRef: hmacRef },
          state: "unsupported",
        },
        applicableGrants: [{ grantRef: hmacRef, state: "absent" }],
        assurance: [
          { kind: "runtime-binding", evidenceRef: hmacRef, strength: "boundary-verified" },
        ],
        lineage: { parentRunId: "parent-run", depth: 1 },
        coverageState: "unattributed",
        missingEvidence: ["invoker.principal"],
      },
    },
    decisions: [
      {
        schemaVersion: 1,
        receiptId: "receipt-1",
        contextId: "context-1",
        executionId: "execution-1",
        runId: "run-1",
        occurredAt: 1,
        action: {
          family: "run",
          operation: "admission",
          summary: "Run admission was recorded without identity-aware evaluation.",
        },
        decision: { outcome: "not-applicable", reasonCode: "identity_not_evaluated" },
        enforcement: {
          coverageState: "unattributed",
          policyRefs: [],
          grantRefs: [],
          contextFieldsUsed: [],
        },
        source: {
          owner: "agent-command",
          recordRef: "context-1",
          decisionBoundary: "agent-command.run-admission",
        },
        missingEvidence: ["invoker.principal"],
        remediation: [
          { code: "no_identity_enforcement_claimed", text: "Do not treat this as authorization." },
        ],
      },
    ],
    coverage: { state: "unattributed", missingEvidence: ["invoker.principal"] },
    nextDecisionCursor: "1",
  };
}

function unavailableResult(
  state: "unknown" | "unsupported",
  reasonCode: string,
  remediation: Array<{ code: string; text: string }> = [],
): AuditRunInspectResult {
  return {
    schemaVersion: 1,
    run: { runId: "run-1", status: state === "unknown" ? "unknown" : "known" },
    identity: {
      state,
      reasonCode,
      missingEvidence: ["identity.context"],
      remediation,
    },
    decisions: [],
    coverage: { state, missingEvidence: ["identity.context"] },
  };
}

function renderState(state: RunInspectorState, onLoadMoreExecutions = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  render(
    renderRunInspector({
      basePath: "/operator",
      state,
      selector: { kind: "execution", id: "execution-1" },
      receiptId: null,
      onLoadMoreDecisions: vi.fn(),
      onLoadMoreExecutions,
      onRestart: vi.fn(),
      onRetry: vi.fn(),
    }),
    container,
  );
  return container;
}

describe("renderRunInspector", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders every identity dimension with explicit text states and safe refs", () => {
    const result = presentResult();
    const container = renderState({
      status: "ready",
      result,
      receiptPageCursors: new Map(
        result.decisions.map((receipt) => [receipt.receiptId, undefined]),
      ),
    });

    expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
      "Inspection coverage: Unattributed",
    );
    const text = container.textContent ?? "";
    for (const label of [
      "Trust domain",
      "Ingress",
      "Invoker",
      "Represented subject",
      "Sponsor",
      "Agent principal",
      "Agent definition",
      "Runtime instance",
      "Applicable grant 1",
      "Assurance evidence 1",
      "Lineage",
    ]) {
      expect(text).toContain(label);
    }
    for (const state of ["Present", "Absent", "Unknown", "Unsupported"]) {
      expect(text).toContain(state);
      expect(container.querySelector(`[aria-label="Evidence state: ${state}"]`)).not.toBeNull();
    }
    expect(text).toContain(hmacRef);
    expect(text).not.toContain("receipt-1");
    expect(text).not.toContain("context-1");
    expect(text).not.toContain("execution-1");
    expect(text).toContain("Additional decision receipts are available");
    expect(text).toContain("Run admission was recorded without identity-aware evaluation.");
    expect(text).toContain("Not applicable");
    expect(text).toContain("Unattributed");
    expect(text).toContain("identity_not_evaluated");
    expect(text).toContain("Durable record owner");
    expect(text).toContain("agent-command");
    expect(text).toContain("Do not treat this as authorization.");
    expect(text).toContain("Best-effort audit warning");
    expect(text).not.toContain("raw-sender-id-42");
    expect(
      container.querySelector<HTMLAnchorElement>('a[href*="view=run"]')?.getAttribute("href"),
    ).toBe("/operator/activity?view=run&run=parent-run");
  });

  it.each([
    [{ status: "empty" } satisfies RunInspectorState, "No run selected"],
    [
      { status: "loading", waitingForGateway: false } satisfies RunInspectorState,
      "Loading run inspection",
    ],
    [
      { status: "loading", waitingForGateway: true } satisfies RunInspectorState,
      "Waiting for the Gateway",
    ],
    [{ status: "disconnected" } satisfies RunInspectorState, "Gateway disconnected"],
    [{ status: "unauthorized" } satisfies RunInspectorState, "Operator read access required"],
    [{ status: "unsupported" } satisfies RunInspectorState, "Run inspection unsupported"],
    [{ status: "error", recovery: "retry" } satisfies RunInspectorState, "Run inspection failed"],
  ])("renders the explicit panel state", (state, expected) => {
    expect(renderState(state).textContent).toContain(expected);
  });

  it.each([
    [unavailableResult("unknown", "run_not_found"), "Run not found"],
    [
      unavailableResult("unsupported", "identity_context_unavailable", [
        { code: "run_again_after_expiry", text: "Run it again." },
      ]),
      "Identity evidence expired",
    ],
    [unavailableResult("unknown", "identity_context_corrupt"), "Identity evidence is corrupt"],
    [
      unavailableResult("unsupported", "identity_context_unavailable"),
      "Identity evidence unsupported",
    ],
  ])("renders the Gateway's typed diagnostic state", (result, expected) => {
    expect(
      renderState({ status: "ready", result, receiptPageCursors: new Map() }).textContent,
    ).toContain(expected);
  });

  it("links an ambiguous run candidate to exact execution inspection", () => {
    const result: AuditRunInspectResult = {
      schemaVersion: 1,
      run: { runId: "ambiguous-run", status: "known" },
      identity: {
        state: "ambiguous",
        reasonCode: "execution_selection_required",
        candidates: [
          { executionId: "execution:a/b", contextId: "candidate-context", createdAt: 1 },
        ],
        missingEvidence: ["execution.selection"],
        remediation: [],
      },
      decisions: [],
      coverage: { state: "unknown", missingEvidence: ["execution.selection"] },
      nextExecutionCursor: "opaque-cursor",
    };

    const onLoadMoreExecutions = vi.fn();
    const container = renderState(
      { status: "ready", result, receiptPageCursors: new Map() },
      onLoadMoreExecutions,
    );
    const link = container.querySelector<HTMLAnchorElement>('a[href*="execution="]');
    expect(link?.textContent).toContain("execution:a/b");
    expect(link?.getAttribute("href")).toBe(
      "/operator/activity?view=run&execution=execution%3Aa%2Fb",
    );
    const loadMore = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Load more executions"),
    );
    loadMore?.click();
    expect(onLoadMoreExecutions).toHaveBeenCalledOnce();

    const loading = renderState({
      status: "ready",
      result,
      executionPageStatus: "loading",
      receiptPageCursors: new Map(),
    });
    expect(loading.querySelector("button")?.disabled).toBe(true);
    expect(loading.textContent).toContain("Loading executions…");

    const failed = renderState({
      status: "ready",
      result,
      executionPageStatus: "error",
      receiptPageCursors: new Map(),
    });
    expect(failed.querySelector('[role="alert"]')?.textContent).toContain(
      "More executions could not be loaded",
    );
  });

  it("deep-links a receipt page without exposing receipt or source identifiers as text", () => {
    const result = presentResult();
    const receipt = result.decisions[0]!;
    receipt.action.resourceRef = "raw-resource-id";
    receipt.action.targetRef = "raw-target-id";
    receipt.actionId = "raw-action-id";
    receipt.enforcement.evaluatorRef = "raw-evaluator-id";
    receipt.enforcement.policyRefs = ["raw-policy-id"];
    receipt.enforcement.grantRefs = ["raw-grant-id"];
    receipt.source.recordRef = "raw-record-id";
    Object.assign(receipt, {
      command: "rm -rf /private/path",
      arguments: { token: "credential-value" },
      payload: "raw-payload",
    });
    const onLoadMoreDecisions = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderRunInspector({
        basePath: "/operator",
        state: {
          status: "ready",
          result,
          receiptPageCursors: new Map([[receipt.receiptId, "a:10:2"]]),
        },
        selector: { kind: "execution", id: "execution-1" },
        receiptId: receipt.receiptId,
        onLoadMoreDecisions,
        onLoadMoreExecutions: vi.fn(),
        onRestart: vi.fn(),
        onRetry: vi.fn(),
      }),
      container,
    );

    const receiptLink = container.querySelector<HTMLAnchorElement>(
      '.run-inspector__receipt-list a[aria-current="true"]',
    );
    expect(receiptLink?.getAttribute("href")).toBe(
      "/operator/activity?view=run&execution=execution-1&receipt=receipt-1&decision=a%3A10%3A2",
    );
    const text = container.textContent ?? "";
    for (const hidden of [
      "receipt-1",
      "context-1",
      "execution-1",
      "raw-resource-id",
      "raw-target-id",
      "raw-action-id",
      "raw-evaluator-id",
      "raw-policy-id",
      "raw-grant-id",
      "raw-record-id",
      "rm -rf",
      "/private/path",
      "credential-value",
      "raw-payload",
    ]) {
      expect(text).not.toContain(hidden);
    }
    const receiptValues = [
      ...container.querySelectorAll(".run-inspector__receipt-detail dl > div"),
    ];
    const countFor = (label: string) =>
      receiptValues
        .find((row) => row.querySelector("dt")?.textContent === label)
        ?.querySelector("dd")?.textContent;
    expect(countFor("Policy references used")).toBe("1");
    expect(countFor("Grant references used")).toBe("1");

    const loadMore = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Load more receipts"),
    );
    loadMore?.click();
    expect(onLoadMoreDecisions).toHaveBeenCalledOnce();
  });

  it("renders receipt selection and pagination failures as explicit non-destructive states", () => {
    const result = presentResult();
    const notFound = renderState({
      status: "ready",
      result,
      receiptPageCursors: new Map(),
      decisionPageStatus: "error",
    });
    render(
      renderRunInspector({
        basePath: "/operator",
        state: {
          status: "ready",
          result,
          receiptPageCursors: new Map(),
          decisionPageStatus: "error",
        },
        selector: { kind: "execution", id: "execution-1" },
        receiptId: "missing-receipt",
        onLoadMoreDecisions: vi.fn(),
        onLoadMoreExecutions: vi.fn(),
        onRestart: vi.fn(),
        onRetry: vi.fn(),
      }),
      notFound,
    );
    expect(notFound.textContent).toContain("Receipt not found on this page");
    expect(notFound.querySelector('[role="alert"]')?.textContent).toContain(
      "More receipts could not be loaded",
    );
    expect(notFound.textContent).not.toContain("missing-receipt");
  });

  it("uses unique labelled receipt sections without skipping from h5 to h3", () => {
    const result = presentResult();
    const container = renderState({
      status: "ready",
      result,
      receiptPageCursors: new Map(),
    });

    const ids = [...container.querySelectorAll<HTMLElement>("[id]")].map((node) => node.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    for (const labelled of container.querySelectorAll<HTMLElement>("[aria-labelledby]")) {
      for (const id of labelled.getAttribute("aria-labelledby")?.split(/\s+/) ?? []) {
        expect(
          ids.filter((candidate) => candidate === id),
          id,
        ).toHaveLength(1);
      }
    }

    expect(container.querySelector("#run-inspector-missing-heading")?.tagName).toBe("H3");
    expect(container.querySelector("#run-inspector-receipt-missing-heading")?.tagName).toBe("H6");
    expect(container.querySelector("#run-inspector-receipt-remediation-heading")?.tagName).toBe(
      "H6",
    );
    expect(container.querySelector(".run-inspector__receipt-detail h3")).toBeNull();

    const unavailable = renderState({
      status: "ready",
      result: unavailableResult("unsupported", "identity_context_unavailable", [
        { code: "run_again_after_expiry", text: "Run it again." },
      ]),
      receiptPageCursors: new Map(),
    });
    expect(unavailable.querySelector("#run-inspector-remediation-heading")?.tagName).toBe("H3");
  });

  it("renders restart only for stale-cursor recovery and Retry for retryable failures", () => {
    const renderError = (
      recovery: "restart" | "retry",
      callbacks: {
        onRestart: () => void;
        onRetry: () => void;
      },
    ) => {
      const container = document.createElement("div");
      document.body.append(container);
      render(
        renderRunInspector({
          basePath: "/operator",
          state: { status: "error", recovery },
          selector: { kind: "run", id: "run-private" },
          receiptId: "receipt-private",
          onLoadMoreDecisions: vi.fn(),
          onLoadMoreExecutions: vi.fn(),
          onRestart: callbacks.onRestart,
          onRetry: callbacks.onRetry,
        }),
        container,
      );
      return container;
    };
    const onRestart = vi.fn();
    const stale = renderError("restart", { onRestart, onRetry: vi.fn() });
    const restart = [...stale.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Restart inspection",
    );
    restart?.click();
    expect(onRestart).toHaveBeenCalledOnce();
    expect(stale.textContent).not.toContain("Retry inspection");
    expect(stale.textContent).not.toContain("receipt-private");

    const onRetry = vi.fn();
    const retryable = renderError("retry", { onRestart: vi.fn(), onRetry });
    const retry = [...retryable.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Retry inspection",
    );
    retry?.click();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(retryable.textContent).not.toContain("Restart inspection");
  });
});
