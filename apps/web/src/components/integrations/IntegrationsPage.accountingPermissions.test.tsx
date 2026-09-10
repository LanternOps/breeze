import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SEC-2026-09-05-057 web gate: the QuickBooks sub-tab entry and its panel are
 * gated on the dedicated `accounting:read` capability. Without it the sub-tab
 * button is not rendered and the panel shows the standard permission-denied
 * state (`AccessDenied`) rather than a screen of 403s. The Stripe payments
 * sub-tab is a separate integration and stays reachable either way.
 *
 * The sibling IntegrationsPage.test.tsx holds the grant throughout and covers
 * the positive tab/sub-tab wiring; this suite covers the NEGATIVE branch.
 */
type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));

vi.mock("../../lib/permissions", () => ({
  usePermissions: () => ({
    permissions: state.permissions,
    can: (resource: string, action: string) =>
      state.permissions.some((p) => p.resource === resource && p.action === action),
  }),
}));

vi.mock("../../lib/authScope", () => ({
  getJwtClaims: () => ({ scope: "partner", orgId: null, partnerId: "partner-1" }),
  loginPathWithNext: () => "/login",
}));
vi.mock("../../stores/orgStore", () => ({
  useOrgStore: (selector: (value: { currentOrgId: string | null }) => unknown) =>
    selector({ currentOrgId: null }),
}));
vi.mock("../../stores/helpStore", () => ({
  useHelpStore: { getState: () => ({ open: vi.fn() }) },
  rebaseDocsUrl: (url: string) => url,
}));
vi.mock("../../stores/auth", async (importActual) => ({
  ...(await importActual<typeof import("../../stores/auth")>()),
  fetchWithAuth: vi.fn(),
}));

// Stub every heavy panel; this suite only asserts the accounting gate.
vi.mock("../webhooks/WebhooksPage", () => ({ default: () => <div /> }));
vi.mock("./CommunicationIntegrations", () => ({ default: () => <div /> }));
vi.mock("../psa/PsaConnectionsPage", () => ({ default: () => <div /> }));
vi.mock("./SecurityIntegration", () => ({ default: () => <div /> }));
vi.mock("./HuntressIntegration", () => ({ default: () => <div /> }));
vi.mock("./MonitoringIntegration", () => ({ default: () => <div /> }));
vi.mock("./GoogleWorkspaceIntegration", () => ({ default: () => <div /> }));
vi.mock("./M365Integration", () => ({ default: () => <div /> }));
vi.mock("./M365CustomerGraphReadCard", () => ({
  M365_CUSTOMER_GRAPH_READ_CALLBACK_RESULTS: [],
  default: () => <div />,
}));
vi.mock("./M365CustomerGraphActionsCard", () => ({
  M365_CUSTOMER_GRAPH_ACTIONS_CALLBACK_RESULTS: [],
  default: () => <div />,
}));
vi.mock("./Pax8Integration", () => ({ default: () => <div /> }));
vi.mock("../settings/TdSynnexCatalogPanel", () => ({ default: () => <div /> }));
vi.mock("../settings/TdSynnexEcExpressPanel", () => ({ default: () => <div /> }));
vi.mock("../settings/TdSynnexSftpPanel", () => ({ default: () => <div /> }));
vi.mock("./UnifiIntegration", () => ({ default: () => <div /> }));
vi.mock("./StripePaymentsIntegration", () => ({
  default: () => <div data-testid="stub-stripe-payments" />,
}));
vi.mock("./QuickbooksIntegration", () => ({
  default: () => <div data-testid="stub-quickbooks" />,
}));

import IntegrationsPage from "./IntegrationsPage";

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [];
  window.history.replaceState({}, "", "/integrations#quickbooks");
});

describe("IntegrationsPage QuickBooks accounting:read gate", () => {
  it("hides the QuickBooks sub-tab and renders AccessDenied without accounting:read", () => {
    render(<IntegrationsPage />);

    expect(screen.queryByTestId("stub-quickbooks")).toBeNull();
    expect(screen.getByTestId("accounting-quickbooks-denied")).toBeTruthy();
    // The sub-tab entry itself is gone; Stripe payments stays available.
    const buttons = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(buttons.some((label) => /quickbooks/i.test(label))).toBe(false);
    expect(buttons.some((label) => /payment/i.test(label))).toBe(true);
  });

  it("renders the QuickBooks panel and sub-tab once accounting:read is granted", () => {
    state.permissions = [{ resource: "accounting", action: "read" }];

    render(<IntegrationsPage />);

    expect(screen.getByTestId("stub-quickbooks")).toBeTruthy();
    expect(screen.queryByTestId("accounting-quickbooks-denied")).toBeNull();
    const buttons = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(buttons.some((label) => /quickbooks/i.test(label))).toBe(true);
  });

  it("does not let an unrelated grant (invoices:write) unlock QuickBooks", () => {
    state.permissions = [{ resource: "invoices", action: "write" }];

    render(<IntegrationsPage />);

    expect(screen.queryByTestId("stub-quickbooks")).toBeNull();
    expect(screen.getByTestId("accounting-quickbooks-denied")).toBeTruthy();
  });
});
