import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Xero W01 review: an accounting provider the instance no longer has configured
 * (e.g. its QBO env vars were removed) can still hold the partner's connection.
 * The API keeps status + disconnect working in that state (ruling R8), so the
 * page must keep rendering that provider's card and the REAL connection panel —
 * otherwise the only way out of the connection is gone. An unconfigured provider
 * that is not the active connection stays hidden.
 *
 * Unlike IntegrationsPage.test.tsx this suite does NOT stub
 * AccountingConnectionPanel: the assertion is on the panel's own Disconnect
 * control.
 */
vi.mock("../../lib/permissions", () => ({
  usePermissions: () => ({
    permissions: [
      { resource: "accounting", action: "read" },
      { resource: "accounting", action: "manage" },
    ],
    can: () => true,
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
const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock("../../stores/auth", async (importActual) => ({
  ...(await importActual<typeof import("../../stores/auth")>()),
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
}));

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
vi.mock("./StripePaymentsIntegration", () => ({ default: () => <div /> }));
vi.mock("./BackupProvidersIntegration", () => ({ default: () => <div /> }));

import IntegrationsPage from "./IntegrationsPage";

const ALL_CAPS = { connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: true, paymentPush: true };
const connectedStatus = {
  status: "connected",
  environment: "production",
  pushMode: "auto",
  connectedAt: "2026-06-23T00:00:00Z",
  lastError: null,
  pullPayments: true,
  lastReconcileAt: null,
};

let providersBody: unknown;

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url === "/accounting/providers") {
      return new Response(JSON.stringify(providersBody), { status: 200 });
    }
    if (url === "/accounting/quickbooks") {
      return new Response(JSON.stringify(connectedStatus), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });
  window.history.replaceState({}, "", "/integrations#accounting");
});

describe("IntegrationsPage — connected provider the instance no longer configures", () => {
  it("renders its card and panel, with a working Disconnect control", async () => {
    providersBody = {
      data: [
        { id: "quickbooks", displayName: "QuickBooks", configured: false, capabilities: ALL_CAPS },
        { id: "xero", displayName: "Xero", configured: false, capabilities: ALL_CAPS },
      ],
      activeConnection: { provider: "quickbooks", status: "connected" },
    };
    render(<IntegrationsPage />);
    expect(await screen.findByTestId("accounting-provider-card-quickbooks")).toBeTruthy();
    const disconnect = await screen.findByTestId("quickbooks-disconnect");
    expect((disconnect as HTMLButtonElement).disabled).toBe(false);
    // Xero is neither configured nor connected: still hidden.
    expect(screen.queryByTestId("accounting-provider-card-xero")).toBeNull();
  });

  it("still hides an unconfigured provider that is not the active connection, even via its hash", async () => {
    providersBody = {
      data: [
        { id: "quickbooks", displayName: "QuickBooks", configured: true, capabilities: ALL_CAPS },
        { id: "xero", displayName: "Xero", configured: false, capabilities: ALL_CAPS },
      ],
      activeConnection: { provider: "quickbooks", status: "connected" },
    };
    window.history.replaceState({}, "", "/integrations#xero");
    render(<IntegrationsPage />);
    expect(await screen.findByTestId("accounting-provider-card-quickbooks")).toBeTruthy();
    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith("/accounting/providers"),
    );
    expect(screen.queryByTestId("accounting-provider-card-xero")).toBeNull();
    expect(screen.queryByTestId("xero-disconnect")).toBeNull();
    expect(screen.queryByTestId("xero-connect")).toBeNull();
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith("/accounting/xero");
  });
});
