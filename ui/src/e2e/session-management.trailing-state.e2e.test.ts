import { expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import {
  actionOpacity,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("keeps text width stable and active state visible while title actions show", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.now()),
          sessionRow(
            "agent:main:hover-actions",
            "A deliberately long action-only sidebar title",
            Date.now() - 1,
          ),
          sessionRow("agent:main:hover-active", "Hover active", Date.now() - 1, {
            hasActiveRun: true,
            status: "running",
          }),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const actionOnlyRow = page.locator('[data-session-key="agent:main:hover-actions"]');
      await actionOnlyRow.waitFor({ state: "visible", timeout: 10_000 });
      const actionOnlyText = actionOnlyRow.locator(".sidebar-recent-session__text");
      const actionOnlyLink = actionOnlyRow.locator(".sidebar-recent-session__link");
      const actionOnlyTitleRow = actionOnlyRow.locator(".sidebar-recent-session__title-row");
      const actionOnlyPin = actionOnlyRow.getByRole("button", { name: "Pin session" });
      await expect
        .poll(() => actionOnlyLink.evaluate((element) => getComputedStyle(element).paddingRight))
        .toBe("4px");
      const restingTextBounds = await actionOnlyText.boundingBox();

      await actionOnlyRow.hover();
      await expect.poll(() => actionOpacity(actionOnlyPin)).toBe("1");
      // The title line, not the second row, reserves the action width.
      await expect
        .poll(() =>
          actionOnlyTitleRow.evaluate((element) => getComputedStyle(element).paddingRight),
        )
        .toBe("52px");
      const hoveredTextBounds = await actionOnlyText.boundingBox();

      await page.mouse.move(0, 0);
      await actionOnlyPin.focus();
      await expect.poll(() => actionOpacity(actionOnlyPin)).toBe("1");
      await expect
        .poll(() =>
          actionOnlyTitleRow.evaluate((element) => getComputedStyle(element).paddingRight),
        )
        .toBe("52px");
      const focusedTextBounds = await actionOnlyText.boundingBox();
      if (!restingTextBounds || !hoveredTextBounds || !focusedTextBounds) {
        throw new Error("Expected visible action-only text geometry");
      }
      expect(hoveredTextBounds.width).toBeCloseTo(restingTextBounds.width, 1);
      expect(focusedTextBounds.width).toBeCloseTo(restingTextBounds.width, 1);

      const row = page.locator('[data-session-key="agent:main:hover-active"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const state = row.locator(".session-row-state");
      const pin = row.getByRole("button", { name: "Pin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect.poll(() => state.locator(".session-run-spinner").isVisible()).toBe(true);
      await expect.poll(() => actionOpacity(state)).toBe("1");

      await row.hover();
      // Actions no longer occupy the state's cell, so running state stays lit.
      await expect.poll(() => actionOpacity(state)).toBe("1");
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await expect.poll(() => actionOpacity(menu)).toBe("1");

      const [nameBounds, pinBounds, menuBounds, stateBounds] = await Promise.all([
        row.locator(".sidebar-recent-session__name").boundingBox(),
        pin.boundingBox(),
        menu.boundingBox(),
        state.boundingBox(),
      ]);
      if (!nameBounds || !pinBounds || !menuBounds || !stateBounds) {
        throw new Error("Expected visible hovered action geometry");
      }
      expect(pinBounds.y + pinBounds.height / 2).toBeCloseTo(
        nameBounds.y + nameBounds.height / 2,
        0,
      );
      expect(pinBounds.y + pinBounds.height / 2).toBeLessThan(
        stateBounds.y + stateBounds.height / 2,
      );
      expect(pinBounds.x + pinBounds.width).toBeLessThanOrEqual(menuBounds.x);

      await page.mouse.move(0, 0);
      await pin.focus();
      await expect.poll(() => actionOpacity(state)).toBe("1");
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await expect.poll(() => actionOpacity(menu)).toBe("1");

      const [focusedNameBounds, focusedPinBounds, focusedMenuBounds] = await Promise.all([
        row.locator(".sidebar-recent-session__name").boundingBox(),
        pin.boundingBox(),
        menu.boundingBox(),
      ]);
      if (!focusedNameBounds || !focusedPinBounds || !focusedMenuBounds) {
        throw new Error("Expected visible focused action geometry");
      }
      expect(focusedPinBounds.y + focusedPinBounds.height / 2).toBeCloseTo(
        focusedNameBounds.y + focusedNameBounds.height / 2,
        0,
      );
      expect(focusedPinBounds.x + focusedPinBounds.width).toBeLessThanOrEqual(focusedMenuBounds.x);
    } finally {
      await context.close();
    }
  });

  it("keeps fork provenance in the title above always-visible touch actions", async () => {
    const context = await suite.browser.newContext({
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.now()),
          sessionRow(
            "agent:main:touch-forked",
            "A deliberately long non-running touch session title that must not overlap controls",
            Date.now() - 1,
            {
              forkSource: { sessionKey: "agent:main:main", sessionId: "source-session" },
              hasActiveRun: false,
              status: "done",
            },
          ),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator('[data-session-key="agent:main:touch-forked"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const fork = row.locator(".sidebar-recent-session__name .sidebar-session-fork-indicator");
      const pin = row.getByRole("button", { name: "Pin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect.poll(() => fork.isVisible()).toBe(true);
      await expect.poll(() => row.locator(".session-row-state").count()).toBe(0);

      const [nameBounds, forkBounds, pinBounds, menuBounds] = await Promise.all([
        row.locator(".sidebar-recent-session__name").boundingBox(),
        fork.boundingBox(),
        pin.boundingBox(),
        menu.boundingBox(),
      ]);
      if (!nameBounds || !forkBounds || !pinBounds || !menuBounds) {
        throw new Error("Expected visible fork and touch action geometry");
      }
      expect(
        Math.abs(forkBounds.y + forkBounds.height / 2 - (nameBounds.y + nameBounds.height / 2)),
      ).toBeLessThanOrEqual(2);
      // Touch keeps the actions up, so the clipped title ends before them on the
      // same line instead of running underneath.
      expect(pinBounds.y + pinBounds.height / 2).toBeCloseTo(
        nameBounds.y + nameBounds.height / 2,
        0,
      );
      expect(nameBounds.x + nameBounds.width).toBeLessThanOrEqual(pinBounds.x + 1);
      expect(pinBounds.x + pinBounds.width).toBeLessThanOrEqual(menuBounds.x);
    } finally {
      await context.close();
    }
  });

  it("keeps semantic state below always-visible touch actions", async () => {
    const context = await suite.browser.newContext({
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.now()),
          sessionRow("agent:main:touch-active", "Touch active", Date.now() - 1, {
            hasActiveRun: true,
            status: "running",
          }),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator('[data-session-key="agent:main:touch-active"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const state = row.locator(".session-row-state");
      const pin = row.getByRole("button", { name: "Pin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect.poll(() => state.locator(".session-run-spinner").isVisible()).toBe(true);
      await expect.poll(() => actionOpacity(state)).toBe("1");
      await expect.poll(() => pin.isVisible()).toBe(true);
      await expect.poll(() => menu.isVisible()).toBe(true);

      const [stateBounds, pinBounds] = await Promise.all([state.boundingBox(), pin.boundingBox()]);
      if (!stateBounds || !pinBounds) {
        throw new Error("Expected visible touch state and action geometry");
      }
      // Separate lines, so state keeps its full second-row width under the
      // always-visible touch actions rather than being pushed aside by them.
      expect(stateBounds.y).toBeGreaterThanOrEqual(pinBounds.y + pinBounds.height / 2);
    } finally {
      await context.close();
    }
  });

  it("keeps desktop session text and trailing state stable under title actions", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.patch",
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.now()),
          sessionRow(
            "agent:main:combined-state",
            "Combined state with a deliberately long resting sidebar title",
            Date.now() - 1,
            {
              forkSource: { sessionKey: "agent:main:main", sessionId: "source-session" },
              hasActiveRun: true,
              status: "running",
              unread: true,
              worktree: {
                id: "combined-state-worktree",
                branch: "fix/combined-state",
                repoRoot: "/tmp/openclaw",
              },
            },
          ),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const codingToggle = page.locator(
        '[data-session-section="work"] .sidebar-session-group-toggle',
      );
      await codingToggle.waitFor({ state: "visible" });
      await codingToggle.click();
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
          return requests.some((request) => {
            const sessionKeys = requireRecord(request.params).sessionKeys;
            return Array.isArray(sessionKeys) && sessionKeys.includes("agent:main:combined-state");
          });
        })
        .toBe(true);
      await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
        sessions: {
          "agent:main:combined-state": {
            pullRequests: [
              {
                branch: "fix/combined-state",
                number: 1,
                owner: "openclaw",
                repo: "openclaw",
                state: "open",
                title: "Combined state fix",
                url: "https://example.test/openclaw/openclaw/pull/1",
              },
            ],
            rateLimited: false,
            status: "ready",
          },
        },
      });

      const row = page.locator('[data-session-key="agent:main:combined-state"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      const state = row.locator(".session-row-state");
      await expect
        .poll(() =>
          row.locator(".sidebar-recent-session__name .sidebar-session-fork-indicator").isVisible(),
        )
        .toBe(true);
      await expect.poll(() => state.locator('[aria-label="Forked session"]').count()).toBe(0);
      await expect
        .poll(() => state.locator("[data-session-pr-state='open']").isVisible())
        .toBe(true);
      await expect.poll(() => state.locator(".session-run-spinner").isVisible()).toBe(true);
      await expect.poll(() => state.locator(".session-unread-dot").isVisible()).toBe(true);
      const [endcapBounds, openPullRequestBounds, spinnerBounds, unreadBounds] = await Promise.all([
        row.locator(".sidebar-recent-session__details-endcap").boundingBox(),
        state.locator("[data-session-pr-state='open'] svg").boundingBox(),
        state.locator(".session-run-spinner").boundingBox(),
        state.locator(".session-unread-dot").boundingBox(),
      ]);
      if (!endcapBounds || !openPullRequestBounds || !spinnerBounds || !unreadBounds) {
        throw new Error("Expected visible combined session state geometry");
      }
      for (const iconBounds of [openPullRequestBounds, spinnerBounds, unreadBounds]) {
        expect(iconBounds.x).toBeGreaterThanOrEqual(endcapBounds.x);
        expect(iconBounds.x + iconBounds.width).toBeLessThanOrEqual(
          endcapBounds.x + endcapBounds.width,
        );
      }
      const link = row.locator(".sidebar-recent-session__link");
      const titleRow = row.locator(".sidebar-recent-session__title-row");
      const pin = row.getByRole("button", { name: "Pin session" });
      const menu = row.getByRole("button", { name: "Open session menu" });
      await expect
        .poll(() => link.evaluate((element) => getComputedStyle(element).paddingRight))
        .toBe("4px");

      const [restingTextBounds, restingStateBounds, restingPinBounds, restingMenuBounds] =
        await Promise.all([
          row.locator(".sidebar-recent-session__text").boundingBox(),
          state.boundingBox(),
          pin.boundingBox(),
          menu.boundingBox(),
        ]);
      if (!restingTextBounds || !restingStateBounds || !restingPinBounds || !restingMenuBounds) {
        throw new Error("Expected visible resting session state geometry");
      }
      const actionSurfaceWidth = restingMenuBounds.x + restingMenuBounds.width - restingPinBounds.x;
      expect(restingTextBounds.x + restingTextBounds.width).toBeGreaterThan(
        restingStateBounds.x - actionSurfaceWidth,
      );
      const restingNameBounds = await row.locator(".sidebar-recent-session__name").boundingBox();
      if (!restingNameBounds) {
        throw new Error("Expected visible resting session title geometry");
      }
      expect(restingNameBounds.y + restingNameBounds.height / 2).toBeLessThan(
        restingStateBounds.y + restingStateBounds.height / 2,
      );
      await row.hover();
      // Combined state (PR chip, spinner, unread dot) shares the second row with
      // the subtitle and keeps its width while the actions sit on the title.
      await expect.poll(() => actionOpacity(state)).toBe("1");
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await expect.poll(() => actionOpacity(menu)).toBe("1");
      await expect
        .poll(() => titleRow.evaluate((element) => getComputedStyle(element).paddingRight))
        .toBe("52px");

      const [textBounds, nameBounds, pinBounds, menuBounds] = await Promise.all([
        row.locator(".sidebar-recent-session__text").boundingBox(),
        row.locator(".sidebar-recent-session__name").boundingBox(),
        pin.boundingBox(),
        menu.boundingBox(),
      ]);
      if (!textBounds || !nameBounds || !pinBounds || !menuBounds) {
        throw new Error("Expected visible combined session action geometry");
      }
      expect(textBounds.width).toBeCloseTo(restingTextBounds.width, 1);
      expect(pinBounds.y + pinBounds.height / 2).toBeCloseTo(
        nameBounds.y + nameBounds.height / 2,
        0,
      );
      expect(nameBounds.x + nameBounds.width).toBeLessThanOrEqual(pinBounds.x + 1);
      expect(pinBounds.x + pinBounds.width).toBeLessThanOrEqual(menuBounds.x);
      await page.mouse.move(0, 0);
      await pin.focus();
      await expect.poll(() => actionOpacity(state)).toBe("1");
      await expect.poll(() => actionOpacity(pin)).toBe("1");
      await expect.poll(() => actionOpacity(menu)).toBe("1");
      await expect
        .poll(() => titleRow.evaluate((element) => getComputedStyle(element).paddingRight))
        .toBe("52px");

      const [focusedTextBounds, focusedNameBounds, focusedPinBounds, focusedMenuBounds] =
        await Promise.all([
          row.locator(".sidebar-recent-session__text").boundingBox(),
          row.locator(".sidebar-recent-session__name").boundingBox(),
          pin.boundingBox(),
          menu.boundingBox(),
        ]);
      if (!focusedTextBounds || !focusedNameBounds || !focusedPinBounds || !focusedMenuBounds) {
        throw new Error("Expected visible focused session action geometry");
      }
      expect(focusedTextBounds.width).toBeCloseTo(restingTextBounds.width, 1);
      expect(focusedPinBounds.y + focusedPinBounds.height / 2).toBeCloseTo(
        focusedNameBounds.y + focusedNameBounds.height / 2,
        0,
      );
      expect(focusedPinBounds.x + focusedPinBounds.width).toBeLessThanOrEqual(focusedMenuBounds.x);
    } finally {
      await context.close();
    }
  });
});
