import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import M365TenantSection from "./M365TenantSection";
import { fetchWithAuth } from "../../stores/auth";
import { navigateTo } from "@/lib/navigation";

// Renders the REAL legacy card and both consent steps behind a URL-routed
// fetch mock, so the availability ordering is exercised against the envelopes
// the components actually parse rather than against stubs that report a
// pre-chewed summary.

const state = vi.hoisted(() => ({
  currentOrgId: "11111111-1111-4111-8111-111111111111" as string | null,
  organizations: [
    { id: "11111111-1111-4111-8111-111111111111", name: "Contoso Ltd" },
  ] as { id: string; name: string }[] | undefined,
}));

vi.mock("../../stores/auth", () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock("../../stores/orgStore", () => ({
  useOrgStore: vi.fn((selector: (value: unknown) => unknown) =>
    selector({ currentOrgId: state.currentOrgId, organizations: state.organizations }),
  ),
}));

vi.mock("../../lib/authScope", () => ({
  getJwtClaims: vi.fn(() => ({ scope: "partner", orgId: null, partnerId: null })),
}));

vi.mock("../../lib/permissions", () => ({
  usePermissions: vi.fn(() => ({
    permissions: [{ resource: "organizations", action: "write" }],
    can: (resource: string, action: string) =>
      resource === "organizations" && action === "write",
  })),
}));

vi.mock("../../lib/runAction", () => ({
  runAction: vi.fn(async (options: {
    request: () => Promise<Response>;
    parseSuccess?: (value: unknown) => unknown;
  }) => {
    const response = await options.request();
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new Error("request failed");
    return options.parseSuccess ? options.parseSuccess(value) : value;
  }),
  handleActionError: vi.fn(),
}));

vi.mock("@/lib/navigation", () => ({
  navigateTo: vi.fn(),
  navigateToMicrosoftLogin: vi.fn(),
}));

vi.mock("@/lib/dateTimeFormat", () => ({
  formatDateTime: vi.fn((value: string) => `formatted ${value}`),
  formatRelativeTime: vi.fn((value: string) => `relative ${value}`),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const navigateToMock = vi.mocked(navigateTo);

const ORG_A = "11111111-1111-4111-8111-111111111111";
const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
const READ_GRANTS = [
  ["9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30", "Application.Read.All"],
  ["b0afded3-3588-46d8-8b3d-9842eff778da", "AuditLog.Read.All"],
  ["5e1e9171-754d-478c-812c-f1755a9a4c2d", "AuditLogsQuery.Read.All"],
  ["7438b122-aefc-4978-80ed-43db9fcc7715", "Device.Read.All"],
  ["dc377aa6-52d8-4e23-b271-2a7ae04cedf3", "DeviceManagementConfiguration.Read.All"],
  ["2f51be20-0bb4-4fed-bf7b-db946066c75e", "DeviceManagementManagedDevices.Read.All"],
  ["5b567255-7703-4780-807c-7be8301ae99b", "Group.Read.All"],
  ["498476ce-e0fe-48b0-b801-37ba7e2685c6", "Organization.Read.All"],
  ["246dd0d5-5bd0-4def-940b-0421030a5b68", "Policy.Read.All"],
  ["483bed4a-2ad3-4361-a73b-c83ccdbdc53c", "RoleManagement.Read.Directory"],
  ["bf394140-e372-4bf9-a898-299cfc7564e5", "SecurityEvents.Read.All"],
  ["332a536c-c7ef-4017-ab91-336970924f0d", "Sites.Read.All"],
  ["df021288-bdef-4463-88db-98f22de89214", "User.Read.All"],
].map(([appRoleId, value]) => ({ resourceApplicationId: GRAPH_APP_ID, appRoleId, value }));
const ACTIONS_GRANTS = [
  ["204e0828-b5ca-4ad8-b9f3-f32a958e7cc4", "User.ReadWrite.All"],
  ["56760768-b641-451f-8906-e1b8ab31bca7", "User-PasswordProfile.ReadWrite.All"],
].map(([appRoleId, value]) => ({ resourceApplicationId: GRAPH_APP_ID, appRoleId, value }));

const TENANT_ID = "44444444-4444-4444-8444-444444444444";

function graphConnection(grants: typeof READ_GRANTS, manifestVersion: number, overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    tenantId: TENANT_ID,
    clientId: "55555555-5555-4555-8555-555555555555",
    displayName: "Northwind Traders",
    status: "active",
    grantHealth: "active",
    manifestVersion,
    currentManifestVersion: manifestVersion,
    observedGrants: grants,
    missingGrants: [],
    unexpectedGrants: [],
    grantsVerifiedAt: "2026-07-14T18:00:00.000Z",
    lastVerifiedAt: "2026-07-14T18:01:00.000Z",
    lastErrorCode: null,
    ...overrides,
  };
}

const readConnection = (overrides: Record<string, unknown> = {}) =>
  graphConnection(READ_GRANTS, 3, overrides);
const actionsConnection = (overrides: Record<string, unknown> = {}) =>
  graphConnection(ACTIONS_GRANTS, 1, { id: "66666666-6666-4666-8666-666666666666", ...overrides });

function readEnvelope(onboardingEnabled: boolean, connection: unknown = null) {
  return {
    profile: {
      id: "customer-graph-read",
      displayName: "Customer Graph Read",
      manifestVersion: 3,
      requiredGrants: READ_GRANTS,
    },
    onboardingEnabled,
    connection,
    syncEnabled: false,
    sync: null,
  };
}

function actionsEnvelope(onboardingEnabled: boolean, connection: unknown = null) {
  return {
    profile: {
      id: "customer-graph-actions",
      displayName: "Customer Graph Actions",
      manifestVersion: 1,
      requiredGrants: ACTIONS_GRANTS,
    },
    onboardingEnabled,
    connection,
  };
}

function makeResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  const body = JSON.stringify(payload);
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: vi.fn().mockResolvedValue(payload),
    text: vi.fn().mockResolvedValue(body),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

type Scenario = {
  consent: boolean;
  legacy: "none" | "connected";
  read?: unknown;
  actions?: unknown;
};

function mockScenario({ consent, legacy, read = null, actions = null }: Scenario) {
  fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0];
    if (path === "/m365/connection") {
      if (init?.method === "DELETE") return makeResponse({ connected: false });
      return makeResponse(
        legacy === "connected"
          ? {
              connected: true,
              tenantId: TENANT_ID,
              clientId: "77777777-7777-4777-8777-777777777777",
              displayName: "Northwind Traders",
              status: "active",
              lastVerifiedAt: "2026-07-10T10:00:00.000Z",
            }
          : { connected: false },
      );
    }
    if (path === "/m365/connections") return makeResponse(readEnvelope(consent, read));
    if (path === "/m365/customer-graph-actions/connections") {
      return makeResponse(actionsEnvelope(consent, actions));
    }
    if (path === "/m365/customer-graph-actions/connections/consent") {
      return makeResponse({
        adminConsentUrl: "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=server-owned",
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function renderSettled(props: Parameters<typeof M365TenantSection>[0] = {}) {
  const view = render(<M365TenantSection {...props} />);
  await waitFor(() =>
    expect(screen.queryByTestId("m365-tenant-loading")).not.toBeInTheDocument(),
  );
  return view;
}

function precedes(a: HTMLElement, b: HTMLElement): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe("M365TenantSection — availability ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.currentOrgId = ORG_A;
    state.organizations = [{ id: ORG_A, name: "Contoso Ltd" }];
  });

  it("shows a single loading placeholder until every connection has reported", async () => {
    mockScenario({ consent: true, legacy: "none" });
    render(<M365TenantSection />);
    expect(screen.getByTestId("m365-tenant-loading")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByTestId("m365-tenant-loading")).not.toBeInTheDocument(),
    );
  });

  describe("consent unavailable", () => {
    it("keeps the legacy card first and replaces both consent cards with one muted line (no legacy connection)", async () => {
      mockScenario({ consent: false, legacy: "none" });
      await renderSettled();

      const legacy = screen.getByTestId("m365-legacy");
      const line = screen.getByTestId("m365-consent-unavailable");
      expect(line).toHaveTextContent("Consent-based connection isn't available on this Breeze instance yet.");
      expect(precedes(legacy, line)).toBe(true);
      expect(screen.getAllByText("Consent-based connection isn't available on this Breeze instance yet.")).toHaveLength(1);
      expect(screen.getByTestId("m365-tenant-panel")).not.toBeVisible();
      expect(screen.queryByTestId("m365-legacy-disclosure")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Save & verify/i })).toBeVisible();
      expect(screen.queryByTestId("m365-legacy-badge")).not.toBeInTheDocument();
    });

    it("keeps a connected legacy card first and expanded with a Legacy badge but no precedence note", async () => {
      mockScenario({ consent: false, legacy: "connected" });
      await renderSettled();

      const legacy = screen.getByTestId("m365-legacy");
      expect(precedes(legacy, screen.getByTestId("m365-consent-unavailable"))).toBe(true);
      expect(screen.getByTestId("m365-legacy-badge")).toHaveTextContent("Legacy");
      expect(screen.getByRole("button", { name: /Update connection/i })).toBeVisible();
      expect(screen.queryByTestId("m365-legacy-disclosure")).not.toBeInTheDocument();
      expect(screen.queryByTestId("m365-legacy-precedence-note")).not.toBeInTheDocument();
    });
  });

  describe("consent available", () => {
    it("leads with the tenant panel and collapses the legacy card under an Advanced disclosure", async () => {
      mockScenario({ consent: true, legacy: "none" });
      await renderSettled();

      const panel = screen.getByTestId("m365-tenant-panel");
      const legacy = screen.getByTestId("m365-legacy");
      expect(panel).toBeVisible();
      expect(precedes(panel, legacy)).toBe(true);
      expect(screen.queryByTestId("m365-consent-unavailable")).not.toBeInTheDocument();

      const disclosure = screen.getByRole("button", {
        name: "Advanced: use your own app registration (legacy)",
      });
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByRole("button", { name: /Save & verify/i, hidden: true })).not.toBeVisible();

      fireEvent.click(disclosure);
      expect(disclosure).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("button", { name: /Save & verify/i })).toBeVisible();
    });

    it("renders a connected legacy card expanded, badged, and with the precedence note", async () => {
      mockScenario({ consent: true, legacy: "connected", read: readConnection() });
      await renderSettled();

      const panel = screen.getByTestId("m365-tenant-panel");
      const legacy = screen.getByTestId("m365-legacy");
      expect(precedes(panel, legacy)).toBe(true);
      expect(screen.queryByTestId("m365-legacy-disclosure")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Update connection/i })).toBeVisible();
      expect(screen.getByTestId("m365-legacy-badge")).toHaveTextContent("Legacy");
      expect(screen.getByTestId("m365-legacy-precedence-note")).toHaveTextContent(
        /legacy direct connection takes precedence over the consent-based connection/i,
      );
    });

    it("keeps the panel when onboarding is off but a consent connection already exists", async () => {
      mockScenario({ consent: false, legacy: "connected", read: readConnection() });
      await renderSettled();
      expect(screen.getByTestId("m365-tenant-panel")).toBeVisible();
      expect(screen.queryByTestId("m365-consent-unavailable")).not.toBeInTheDocument();
      expect(screen.getByTestId("m365-legacy-precedence-note")).toBeInTheDocument();
    });

    it("keeps the panel when a consent callback result is present even with onboarding off", async () => {
      mockScenario({ consent: false, legacy: "none" });
      await renderSettled({ readCallbackResult: "consent_cancelled", readCallbackRefreshKey: 1 });
      expect(screen.getByTestId("m365-tenant-panel")).toBeVisible();
      expect(screen.getByText("Microsoft consent was cancelled.")).toBeVisible();
    });
  });

  it("does not fold the panel back to the loading placeholder when a step reloads after an action", async () => {
    mockScenario({ consent: true, legacy: "none", read: readConnection() });
    await renderSettled();

    let releaseReload!: () => void;
    const reloadGate = new Promise<void>((resolve) => { releaseReload = resolve; });
    const settled = fetchWithAuthMock.getMockImplementation()!;
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0];
      if (path.endsWith("/retest")) return makeResponse({});
      if (path === "/m365/connections") await reloadGate;
      return settled(url, init);
    });

    const retest = screen.getByRole("button", { name: "Retest" });
    fireEvent.click(retest);
    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(expect.stringMatching(/\/retest\?/), { method: "POST" }),
    );
    // The Read step is reloading its envelope right now.
    await waitFor(() => expect(screen.getByLabelText("Loading Customer Graph Read connection.")).toBeInTheDocument());
    // Let the step's summary effect reach the section before asserting.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.queryByTestId("m365-tenant-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("m365-tenant-panel")).toBeVisible();

    releaseReload();
    expect(await screen.findByRole("button", { name: "Retest" })).toBeVisible();
  });

  it("consolidates the no-organization state into one line instead of two card messages", async () => {
    state.currentOrgId = null;
    mockScenario({ consent: true, legacy: "none" });
    await renderSettled();
    expect(screen.getByTestId("m365-consent-select-org")).toBeVisible();
    expect(screen.getByTestId("m365-tenant-panel")).not.toBeVisible();
  });
});

describe("M365TenantSection — tenant panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.currentOrgId = ORG_A;
    state.organizations = [{ id: ORG_A, name: "Contoso Ltd" }];
  });

  it("names the organization when nothing is connected and asks Actions for Read first", async () => {
    mockScenario({ consent: true, legacy: "none" });
    await renderSettled();

    expect(
      screen.getByRole("heading", { level: 2, name: "No Microsoft 365 tenant connected to Contoso Ltd" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("m365-copy-tenant-id")).not.toBeInTheDocument();
    const note = screen.getByTestId("m365-actions-read-note");
    expect(note).toHaveTextContent("AI lookups and reports need Read access (step 1).");
    expect(screen.getByRole("button", { name: "Connect tenant" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Grant admin actions…" })).toBeEnabled();
  });

  it("falls back to generic copy when the org name is not available client-side", async () => {
    state.organizations = undefined;
    mockScenario({ consent: true, legacy: "none" });
    await renderSettled();
    expect(
      screen.getByRole("heading", { level: 2, name: "No Microsoft 365 tenant connected to this organization" }),
    ).toBeInTheDocument();
  });

  it("shows the Read tenant identity with a copyable tenant ID and last verification", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    mockScenario({ consent: true, legacy: "none", read: readConnection() });
    await renderSettled();

    const identity = screen.getByTestId("m365-tenant-identity");
    expect(within(identity).getByRole("heading", { level: 2, name: "Northwind Traders" })).toBeInTheDocument();
    expect(within(identity).getByText(TENANT_ID)).toBeInTheDocument();
    expect(within(identity).getByText(/formatted 2026-07-14T18:01:00.000Z/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("m365-copy-tenant-id"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TENANT_ID));
    expect(screen.queryByTestId("m365-actions-read-note")).not.toBeInTheDocument();
  });

  it("uses the Actions identity when only Actions is connected, and still asks for Read first", async () => {
    mockScenario({
      consent: true,
      legacy: "none",
      actions: actionsConnection({ displayName: "Fabrikam Holdings" }),
    });
    await renderSettled();
    expect(screen.getByRole("heading", { level: 2, name: "Fabrikam Holdings" })).toBeInTheDocument();
    expect(screen.getByTestId("m365-actions-read-note")).toBeInTheDocument();
  });

  it("shows the tenant ID only when the connection has no display name", async () => {
    mockScenario({ consent: true, legacy: "none", read: readConnection({ displayName: null }) });
    await renderSettled();
    expect(screen.getByRole("heading", { level: 2, name: TENANT_ID })).toBeInTheDocument();
  });

  it("drops the Read-first note once both steps are connected", async () => {
    mockScenario({ consent: true, legacy: "none", read: readConnection(), actions: actionsConnection() });
    await renderSettled();
    expect(screen.queryByTestId("m365-actions-read-note")).not.toBeInTheDocument();
    expect(screen.getAllByText("Active").length).toBeGreaterThanOrEqual(2);
  });

  it("truncates a long tenant name and keeps the full value in the title", async () => {
    const longName = "Northwind Traders International Holdings Group Worldwide Operations Limited";
    mockScenario({ consent: true, legacy: "none", read: readConnection({ displayName: longName }) });
    await renderSettled();
    const heading = screen.getByRole("heading", { level: 2, name: longName });
    expect(heading).toHaveClass("truncate");
    expect(heading).toHaveAttribute("title", longName);
  });

  it("has no h1 of its own and uses h2 for the panel and h3 for each step", async () => {
    mockScenario({ consent: true, legacy: "connected", read: readConnection() });
    await renderSettled();
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 3, name: /Read access/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: /Admin actions/ })).toBeInTheDocument();
  });

  it("names the connected tenant in the admin-actions pre-flight and continues to Microsoft", async () => {
    mockScenario({ consent: true, legacy: "none", read: readConnection() });
    await renderSettled();

    fireEvent.click(screen.getByRole("button", { name: "Grant admin actions…" }));
    const preflight = screen.getByTestId("m365-actions-preflight");
    expect(preflight).toHaveTextContent(
      "You must be signed in to Microsoft as a Global Administrator (or Privileged Role Administrator) for Northwind Traders.",
    );
    fireEvent.click(within(preflight).getByRole("button", { name: "Continue to Microsoft" }));
    await waitFor(() =>
      expect(navigateToMock).toHaveBeenCalledWith(
        "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=server-owned",
      ),
    );
  });

  it("names the organization in the pre-flight before any tenant is connected", async () => {
    mockScenario({ consent: true, legacy: "none" });
    await renderSettled();
    fireEvent.click(screen.getByRole("button", { name: "Grant admin actions…" }));
    expect(screen.getByTestId("m365-actions-preflight")).toHaveTextContent(
      "Privileged Role Administrator) for Contoso Ltd.",
    );
  });
});
