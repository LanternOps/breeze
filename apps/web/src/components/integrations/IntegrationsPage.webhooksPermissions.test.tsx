import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Web gate: the Webhooks entry requires `webhooks:read`. Without it the entry
 * is not listed, and a page whose default is Webhooks opens on the first entry
 * the user can see instead. A deep link to `#webhooks` still opens the webhooks
 * panel, which renders its own access-denied state.
 */
type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({ permissions: [] as Perm[] | undefined }));

vi.mock("../../lib/permissions", () => ({
  usePermissions: () => ({
    permissions: state.permissions,
    can: (resource: string, action: string) =>
      (state.permissions ?? []).some((p) => p.resource === resource && p.action === action),
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

// Stub every heavy panel; this suite only asserts which tab opens.
vi.mock("../webhooks/WebhooksPage", () => ({ default: () => <div data-testid="stub-webhooks" /> }));
vi.mock("./CommunicationIntegrations", () => ({ default: () => <div data-testid="stub-notifications" /> }));
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
vi.mock("./AccountingConnectionPanel", () => ({
  default: ({ provider }: { provider: string }) => <div data-testid={`stub-${provider}`} />,
}));

import IntegrationsPage from "./IntegrationsPage";
import { fetchWithAuth } from "../../stores/auth";

// Entries in the page's navigation list.
const tabLabels = () =>
  within(screen.getByTestId("integrations-nav")).getAllByRole("link")
    .map((link) => (link.textContent ?? "").trim());

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [];
  window.history.replaceState({}, "", "/integrations");
  vi.mocked(fetchWithAuth).mockImplementation(async () =>
    new Response(JSON.stringify({ data: [], activeConnection: null }), { status: 200 }),
  );
});

describe("IntegrationsPage webhooks:read gate", () => {
  it("hides the Webhooks entry and leaves a Webhooks default for the first visible entry without webhooks:read", () => {
    state.permissions = [{ resource: "organizations", action: "read" }];

    render(<IntegrationsPage initialTab="webhooks" />);

    expect(screen.queryByTestId("stub-webhooks")).toBeNull();
    expect(screen.getByTestId("connection-health-loading")).toBeTruthy();
    expect(tabLabels().some((label) => /webhook/i.test(label))).toBe(false);
  });

  it("lists the Webhooks entry with webhooks:read, without making it the landing view", () => {
    state.permissions = [{ resource: "webhooks", action: "read" }];

    render(<IntegrationsPage />);

    expect(screen.queryByTestId("stub-webhooks")).toBeNull();
    expect(tabLabels().some((label) => /webhook/i.test(label))).toBe(true);
  });

  it("keeps a #webhooks deep link on the webhooks panel (which shows access denied) without the grant", () => {
    state.permissions = [{ resource: "organizations", action: "read" }];
    window.history.replaceState({}, "", "/integrations#webhooks");

    render(<IntegrationsPage />);

    expect(screen.getByTestId("stub-webhooks")).toBeTruthy();
    expect(screen.queryByTestId("stub-notifications")).toBeNull();
    expect(tabLabels().some((label) => /webhook/i.test(label))).toBe(false);
  });

  it("does not switch away from Webhooks while permissions are still loading", () => {
    state.permissions = undefined;

    render(<IntegrationsPage initialTab="webhooks" />);

    expect(screen.getByTestId("stub-webhooks")).toBeTruthy();
    expect(screen.queryByTestId("stub-notifications")).toBeNull();
  });
});
