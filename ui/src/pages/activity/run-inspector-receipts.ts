import { html, nothing, type TemplateResult } from "lit";
import type {
  AuditRunInspectResult,
  DecisionReceiptV1,
} from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import { pathForRoute } from "../../app-route-paths.ts";
import { t } from "../../i18n/index.ts";
import type { RunInspectorSelector, RunInspectorState } from "./run-inspector-model.ts";

export function coverageKey(
  state: AuditRunInspectResult["coverage"]["state"],
): "enforced" | "attributionOnly" | "unattributed" | "unknown" | "unsupported" {
  return state === "attribution-only" ? "attributionOnly" : state;
}

export function coverageLabel(state: AuditRunInspectResult["coverage"]["state"]): string {
  return t(`activity.runInspector.coverage.${coverageKey(state)}.label`);
}

export function renderSafeRef(value: string | number, mono = false, href?: string) {
  const content = html`<bdi
    class=${mono ? "run-inspector__ref mono" : "run-inspector__ref"}
    dir="ltr"
    >${value}</bdi
  >`;
  return href ? html`<a href=${href}>${content}</a>` : content;
}

export function renderMissingEvidence(values: readonly string[]) {
  return html`
    <section class="run-inspector__section" aria-labelledby="run-inspector-missing-heading">
      <h3 id="run-inspector-missing-heading">
        ${t("activity.runInspector.missingEvidenceHeading")}
      </h3>
      ${values.length === 0
        ? html`<p>${t("activity.runInspector.noMissingEvidence")}</p>`
        : html`<ul class="run-inspector__code-list">
            ${values.map((value) => html`<li>${renderSafeRef(value, true)}</li>`)}
          </ul>`}
    </section>
  `;
}

export function renderRemediation(
  remediation: readonly { code: string; text: string }[],
): TemplateResult | typeof nothing {
  if (remediation.length === 0) {
    return nothing;
  }
  return html`
    <section
      class="run-inspector__section"
      aria-label=${t("activity.runInspector.nextStepsHeading")}
    >
      <h3>${t("activity.runInspector.nextStepsHeading")}</h3>
      <ul class="run-inspector__remediation-list">
        ${remediation.map(
          (item) => html`<li><span>${item.text}</span> ${renderSafeRef(item.code, true)}</li>`,
        )}
      </ul>
    </section>
  `;
}

function receiptInspectorHref(
  selector: RunInspectorSelector,
  receiptId: string,
  decisionCursor: string | undefined,
  basePath: string,
): string {
  const search = new URLSearchParams({
    view: "run",
    [selector.kind]: selector.id,
    receipt: receiptId,
  });
  if (decisionCursor) {
    search.set("decision", decisionCursor);
  }
  return `${pathForRoute("activity", basePath)}?${search.toString()}`;
}

function selectorInspectorHref(selector: RunInspectorSelector, basePath: string): string {
  const search = new URLSearchParams({ view: "run", [selector.kind]: selector.id });
  return `${pathForRoute("activity", basePath)}?${search.toString()}`;
}

function decisionOutcomeLabel(outcome: DecisionReceiptV1["decision"]["outcome"]): string {
  return t(
    `activity.runInspector.decisions.outcomes.${outcome === "not-applicable" ? "notApplicable" : outcome}`,
  );
}

function renderReceiptCodes(values: readonly string[], emptyCopy: string) {
  return values.length === 0
    ? html`<p class="run-inspector__reason">${emptyCopy}</p>`
    : html`<ul class="run-inspector__code-list">
        ${values.map((value) => html`<li>${renderSafeRef(value, true)}</li>`)}
      </ul>`;
}

function renderReceiptDetail(receipt: DecisionReceiptV1) {
  const coverage = receipt.enforcement.coverageState;
  return html`
    <article class="run-inspector__receipt-detail" aria-labelledby="run-inspector-receipt-detail">
      <h4 id="run-inspector-receipt-detail">
        ${t("activity.runInspector.decisions.detailHeading")}
      </h4>
      <section aria-labelledby="run-inspector-receipt-requested">
        <h5 id="run-inspector-receipt-requested">
          ${t("activity.runInspector.decisions.requestedHeading")}
        </h5>
        ${receipt.action.summary ? html`<p>${receipt.action.summary}</p>` : nothing}
        <dl class="run-inspector__values">
          <div>
            <dt>${t("activity.runInspector.values.kind")}</dt>
            <dd>${renderSafeRef(receipt.action.family)}</dd>
          </div>
          <div>
            <dt>${t("activity.runInspector.values.operation")}</dt>
            <dd>${renderSafeRef(receipt.action.operation)}</dd>
          </div>
        </dl>
      </section>
      <section aria-labelledby="run-inspector-receipt-outcome">
        <h5 id="run-inspector-receipt-outcome">
          ${t("activity.runInspector.decisions.outcomeHeading")}
        </h5>
        <div class="run-inspector__receipt-badges">
          <span
            class="run-inspector__receipt-badge run-inspector__receipt-badge--${receipt.decision
              .outcome}"
            aria-label=${`${t("activity.runInspector.decisions.outcomeLabel")}: ${decisionOutcomeLabel(
              receipt.decision.outcome,
            )}`}
          >
            ${decisionOutcomeLabel(receipt.decision.outcome)}
          </span>
          <span
            class="run-inspector__receipt-badge run-inspector__receipt-badge--${coverage}"
            aria-label=${`${t("activity.runInspector.decisions.classificationLabel")}: ${coverageLabel(
              coverage,
            )}`}
          >
            ${coverageLabel(coverage)}
          </span>
        </div>
        <p class="run-inspector__reason">
          ${t(`activity.runInspector.coverage.${coverageKey(coverage)}.description`)}
        </p>
        <dl class="run-inspector__values">
          <div>
            <dt>${t("activity.runInspector.decisions.reasonLabel")}</dt>
            <dd>${renderSafeRef(receipt.decision.reasonCode, true)}</dd>
          </div>
          <div>
            <dt>${t("activity.runInspector.decisions.occurredAtLabel")}</dt>
            <dd>${new Date(receipt.occurredAt).toLocaleString()}</dd>
          </div>
        </dl>
      </section>
      <section aria-labelledby="run-inspector-receipt-owner">
        <h5 id="run-inspector-receipt-owner">
          ${t("activity.runInspector.decisions.ownerHeading")}
        </h5>
        <dl class="run-inspector__values">
          <div>
            <dt>${t("activity.runInspector.decisions.durableOwnerLabel")}</dt>
            <dd>${renderSafeRef(receipt.source.owner)}</dd>
          </div>
          <div>
            <dt>${t("activity.runInspector.decisions.boundaryLabel")}</dt>
            <dd>${renderSafeRef(receipt.source.decisionBoundary)}</dd>
          </div>
        </dl>
        <p class="run-inspector__reason">${t("activity.runInspector.decisions.ownerNote")}</p>
      </section>
      <section aria-labelledby="run-inspector-receipt-evidence">
        <h5 id="run-inspector-receipt-evidence">
          ${t("activity.runInspector.decisions.evidenceHeading")}
        </h5>
        <dl class="run-inspector__values">
          <div>
            <dt>${t("activity.runInspector.decisions.policyCountLabel")}</dt>
            <dd>${receipt.enforcement.policyRefs.length}</dd>
          </div>
          <div>
            <dt>${t("activity.runInspector.decisions.grantCountLabel")}</dt>
            <dd>${receipt.enforcement.grantRefs.length}</dd>
          </div>
        </dl>
        <h6>${t("activity.runInspector.decisions.contextFieldsLabel")}</h6>
        ${renderReceiptCodes(
          receipt.enforcement.contextFieldsUsed,
          t("activity.runInspector.decisions.noContextFields"),
        )}
        ${renderMissingEvidence(receipt.missingEvidence)}
      </section>
      ${renderRemediation(receipt.remediation)}
    </article>
  `;
}

export function renderDecisions(
  state: Extract<RunInspectorState, { status: "ready" }>,
  selector: RunInspectorSelector | null,
  receiptId: string | null,
  basePath: string,
  onLoadMoreDecisions: () => void,
) {
  const result = state.result;
  const selectedReceipt = receiptId
    ? result.decisions.find((receipt) => receipt.receiptId === receiptId)
    : result.decisions[0];
  return html`
    <section class="run-inspector__section" aria-labelledby="run-inspector-decisions-heading">
      <h3 id="run-inspector-decisions-heading">${t("activity.runInspector.decisions.heading")}</h3>
      ${result.decisions.length === 0
        ? html`<p>${t("activity.runInspector.decisions.none")}</p>`
        : html`<p>
            ${t("activity.runInspector.decisions.returned", {
              count: String(result.decisions.length),
            })}
          </p>`}
      <div class="run-inspector__warning" role="note">
        ${t("activity.runInspector.decisions.readOnly")}
      </div>
      ${result.decisions.length > 0 && selector
        ? html`<ol
            class="run-inspector__receipt-list"
            aria-label=${t("activity.runInspector.decisions.listLabel")}
          >
            ${result.decisions.map((receipt) => {
              const selected = selectedReceipt?.receiptId === receipt.receiptId;
              return html`<li>
                <a
                  href=${receiptInspectorHref(
                    selector,
                    receipt.receiptId,
                    state.receiptPageCursors.get(receipt.receiptId),
                    basePath,
                  )}
                  aria-current=${selected ? "true" : nothing}
                  aria-label=${t("activity.runInspector.decisions.inspectLabel", {
                    summary:
                      receipt.action.summary ??
                      `${receipt.action.family} · ${receipt.action.operation}`,
                    outcome: decisionOutcomeLabel(receipt.decision.outcome),
                    classification: coverageLabel(receipt.enforcement.coverageState),
                  })}
                >
                  <span
                    >${receipt.action.summary ??
                    `${receipt.action.family} · ${receipt.action.operation}`}</span
                  >
                  <span class="run-inspector__receipt-badges" aria-hidden="true">
                    <span
                      class="run-inspector__receipt-badge run-inspector__receipt-badge--${receipt
                        .decision.outcome}"
                      >${decisionOutcomeLabel(receipt.decision.outcome)}</span
                    >
                    <span
                      class="run-inspector__receipt-badge run-inspector__receipt-badge--${receipt
                        .enforcement.coverageState}"
                      >${coverageLabel(receipt.enforcement.coverageState)}</span
                    >
                  </span>
                </a>
              </li>`;
            })}
          </ol>`
        : nothing}
      ${result.nextDecisionCursor
        ? html`<div class="run-inspector__pagination">
            <span>${t("activity.runInspector.decisions.more")}</span>
            <button
              type="button"
              class="btn"
              ?disabled=${state.decisionPageStatus === "loading"}
              @click=${onLoadMoreDecisions}
            >
              ${state.decisionPageStatus === "loading"
                ? t("activity.runInspector.decisions.loadingMore")
                : t("activity.runInspector.decisions.loadMore")}
            </button>
            ${state.decisionPageStatus === "error"
              ? html`<span role="alert">
                  ${t("activity.runInspector.decisions.loadMoreError")}
                </span>`
              : nothing}
          </div>`
        : html`<div class="run-inspector__pagination" role="note">
            ${t("activity.runInspector.decisions.bounded")}
          </div>`}
      ${receiptId && !selectedReceipt
        ? html`<div class="run-inspector__result-state" role="status">
            <h4>${t("activity.runInspector.decisions.notFoundTitle")}</h4>
            <p>${t("activity.runInspector.decisions.notFoundDescription")}</p>
            ${selector
              ? html`<a href=${selectorInspectorHref(selector, basePath)}>
                  ${t("activity.runInspector.decisions.heading")}
                </a>`
              : nothing}
          </div>`
        : selectedReceipt
          ? renderReceiptDetail(selectedReceipt)
          : nothing}
    </section>
  `;
}
