import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SEC-2026-09-05-057 web gate: every mutating QuickBooks control mirrors the
 * server's dedicated `accounting:manage` capability. A caller holding only
 * `accounting:read` (plus the pre-existing `invoices:write`) can still SEE the
 * panel but cannot operate connect, disconnect, refresh-settings, push mode,
 * payment sync or reconcile.
 *
 * The sibling QuickbooksIntegration.test.tsx grants everything except
 * `invoices:write`; this suite covers the accounting:manage branch.
 */
const fetchWithAuth = vi.fn();
const state = vi.hoisted(() => ({ canManage: false }));

vi.mock("../../lib/permissions", () => ({
  usePermissions: () => ({
    permissions: [],
    can: (resource: string, action: string) =>
      resource === "accounting" && action === "manage"
        ? state.canManage
        : true,
  }),
}));
vi.mock("../../stores/auth", () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));
vi.mock("../shared/Toast", () => ({ showToast: vi.fn() }));
vi.mock("@/lib/navigation", () => ({ navigateTo: vi.fn() }));
vi.mock("../../lib/authScope", () => ({
  loginPathWithNext: () => "/login?next=/integrations",
  getJwtClaims: () => ({ scope: "partner", orgId: null, partnerId: "partner-1" }),
}));

import QuickbooksIntegration from "./QuickbooksIntegration";

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const disconnected = {
  status: "disconnected",
  environment: null,
  pushMode: "auto",
  connectedAt: null,
  lastError: null,
};
const connected = {
  status: "connected",
  environment: "production",
  pushMode: "auto",
  connectedAt: "2026-06-23T00:00:00Z",
  lastError: null,
  pullPayments: true,
  lastReconcileAt: null,
};

function serve(status: unknown) {
  fetchWithAuth.mockImplementation(async (url: string) =>
    url === "/accounting/quickbooks" ? jsonResponse(status) : jsonResponse({}, 404),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.canManage = false;
  window.history.replaceState({}, "", "/integrations");
});

describe("QuickbooksIntegration accounting:manage gate", () => {
  it("disables Connect without accounting:manage", async () => {
    serve(disconnected);
    render(<QuickbooksIntegration />);
    const connect = await screen.findByTestId("quickbooks-connect");
    expect((connect as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables Connect once accounting:manage is granted", async () => {
    state.canManage = true;
    serve(disconnected);
    render(<QuickbooksIntegration />);
    const connect = await screen.findByTestId("quickbooks-connect");
    expect((connect as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables disconnect / refresh-settings and hides push-mode + reconcile without accounting:manage", async () => {
    serve(connected);
    render(<QuickbooksIntegration />);
    await screen.findByTestId("quickbooks-status-connected");

    expect((screen.getByTestId("quickbooks-disconnect") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("quickbooks-settings-refresh") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("quickbooks-pushmode-auto")).toBeNull();
    expect(screen.queryByTestId("quickbooks-pushmode-manual")).toBeNull();
    expect(screen.queryByTestId("quickbooks-reconcile-now")).toBeNull();
  });

  it("restores every control once accounting:manage is granted", async () => {
    state.canManage = true;
    serve(connected);
    render(<QuickbooksIntegration />);
    await screen.findByTestId("quickbooks-status-connected");

    expect((screen.getByTestId("quickbooks-disconnect") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("quickbooks-settings-refresh") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("quickbooks-pushmode-auto")).toBeTruthy();
    expect(screen.getByTestId("quickbooks-pushmode-manual")).toBeTruthy();
  });
});
