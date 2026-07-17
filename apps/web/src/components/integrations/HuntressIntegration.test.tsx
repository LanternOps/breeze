import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HuntressIntegration from "./HuntressIntegration";
import { fetchWithAuth } from "../../stores/auth";
import { getJwtClaims } from "../../lib/authScope";
import { useOrgStore } from "../../stores/orgStore";

vi.mock("../../stores/auth", () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  resolveApiOrigin: vi.fn(() => "https://us.2breeze.app"),
}));

vi.mock("../../lib/authScope", () => ({
  getJwtClaims: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const getJwtClaimsMock = vi.mocked(getJwtClaims);

// Token-capability claims: the partner config UI is gated on the JWT scope,
// NOT on the org selected in the header (two-layer context model).
const partnerClaims = {
  scope: "partner" as const,
  orgId: null,
  partnerId: "partner-1",
};
const orgClaims = {
  scope: "organization" as const,
  orgId: "00000000-0000-4000-8000-000000000001",
  partnerId: "partner-1",
};

function makeResponse(
  payload: unknown,
  ok = true,
  status = ok ? 200 : 500,
): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

type TestIntegration = {
  id: string;
  partnerId: string;
  name: string;
  accountId: string | null;
  apiBaseUrl: string;
  isActive: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  lastSyncAgents?: number | null;
  lastSyncIncidents?: number | null;
  lastSyncOrgs?: number | null;
  hasWebhookSecret: boolean;
  createdAt: string;
  updatedAt: string;
};

const existingIntegration: TestIntegration = {
  id: "huntress-1",
  partnerId: "partner-1",
  name: "Existing Huntress",
  accountId: "acct-123",
  apiBaseUrl: "https://api.huntress.io",
  isActive: true,
  lastSyncAt: null,
  lastSyncStatus: "success",
  lastSyncError: null,
  hasWebhookSecret: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const emptyStatus = {
  coverage: {
    totalAgents: 0,
    mappedAgents: 0,
    unmappedAgents: 0,
    offlineAgents: 0,
  },
  incidents: { open: 0, bySeverity: [], byStatus: [] },
};

const breezeOrg = {
  id: "00000000-0000-4000-8000-000000000001",
  partnerId: "partner-1",
  name: "Acme Corp",
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
};

const discoveredHuntressOrg = {
  huntressOrgId: "huntress-org-1",
  huntressOrgName: "Acme Huntress",
  huntressOrgKey: "acme",
  huntressAccountId: "acct-123",
  agentsCount: 2,
  incidentsCount: 1,
  mappedOrgId: null,
  mappedOrgName: null,
  lastSeenAt: null,
};

function mockPartnerLoad(
  options: {
    integration?: TestIntegration | null;
    mappings?: unknown[];
    statusOk?: boolean;
  } = {},
) {
  const integration =
    options.integration === undefined ? null : options.integration;
  const mappings = options.mappings ?? [];
  fetchWithAuthMock.mockImplementation(async (url, init) => {
    if (url === "/huntress/integration" && init?.method === "POST") {
      return makeResponse({ id: "huntress-1" }, true, integration ? 200 : 201);
    }
    if (url === "/huntress/organizations/map" && init?.method === "POST") {
      return makeResponse({
        data: {
          ...discoveredHuntressOrg,
          mappedOrgId: breezeOrg.id,
          mappedOrgName: breezeOrg.name,
        },
      });
    }
    if (url === "/huntress/integration")
      return makeResponse({ data: integration });
    if (url === "/huntress/status") {
      return options.statusOk === false
        ? makeResponse({ error: "upstream error" }, false, 502)
        : makeResponse(emptyStatus);
    }
    if (url === "/huntress/incidents?limit=5")
      return makeResponse({ data: [] });
    if (url === "/huntress/organizations")
      return makeResponse({ data: mappings });
    if (url === "/orgs/organizations")
      return makeResponse({ data: [breezeOrg] });
    return makeResponse({}, false, 404);
  });
}

describe("HuntressIntegration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Partner-scope token with an org selected in the header — the partner
    // config UI must render regardless of the selected org.
    getJwtClaimsMock.mockReturnValue(partnerClaims);
    useOrgStore.setState({
      currentOrgId: "00000000-0000-4000-8000-000000000001",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads the partner connection and mapping table in all-orgs scope", async () => {
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({
      integration: existingIntegration,
      mappings: [discoveredHuntressOrg],
    });

    render(<HuntressIntegration />);

    await waitFor(() =>
      expect(screen.getByText("Partner connection")).toBeInTheDocument(),
    );
    expect(screen.getByText("Organization mapping")).toBeInTheDocument();
    expect(screen.getByText("Acme Huntress")).toBeInTheDocument();
    expect(fetchWithAuthMock).toHaveBeenCalledWith("/huntress/integration");
    expect(fetchWithAuthMock).toHaveBeenCalledWith("/huntress/status");
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      "/huntress/incidents?limit=5",
    );
    expect(fetchWithAuthMock).toHaveBeenCalledWith("/huntress/organizations");
    expect(fetchWithAuthMock).toHaveBeenCalledWith("/orgs/organizations");
  });

  it("still renders the partner connection and mapping UI when a partner admin has an org selected", async () => {
    // currentOrgId stays set (default beforeEach): the header context must not
    // gate the partner config UI — the JWT capability does.
    mockPartnerLoad({
      integration: existingIntegration,
      mappings: [discoveredHuntressOrg],
    });

    render(<HuntressIntegration />);

    await waitFor(() =>
      expect(screen.getByText("Partner connection")).toBeInTheDocument(),
    );
    expect(screen.getByText("Organization mapping")).toBeInTheDocument();
    expect(screen.getByText("Acme Huntress")).toBeInTheDocument();
    expect(fetchWithAuthMock).toHaveBeenCalledWith("/huntress/organizations");
    expect(fetchWithAuthMock).toHaveBeenCalledWith("/orgs/organizations");
    // The org-scope-only "not connected" empty state never shows for partners.
    expect(
      screen.queryByText("Huntress isn't connected yet"),
    ).not.toBeInTheDocument();
  });

  it("loads Huntress resources when scoped to a current organization", async () => {
    getJwtClaimsMock.mockReturnValue(orgClaims);
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (url === "/huntress/integration")
        return makeResponse({ data: existingIntegration, mapped: true });
      if (url === "/huntress/status")
        return makeResponse({ ...emptyStatus, mapped: true });
      if (url === "/huntress/incidents?limit=5")
        return makeResponse({ data: [] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);

    await waitFor(() =>
      expect(screen.getByText("Sync status")).toBeInTheDocument(),
    );
    expect(fetchWithAuthMock).toHaveBeenCalledWith("/huntress/integration");
    expect(fetchWithAuthMock).toHaveBeenCalledWith("/huntress/status");
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      "/huntress/incidents?limit=5",
    );
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith(
      "/huntress/organizations",
    );
  });

  it("collects Huntress API Key and API Secret separately and submits them as one credential pair", async () => {
    const user = userEvent.setup();
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad();

    render(<HuntressIntegration />);

    await waitFor(() =>
      expect(screen.getByText("Partner connection")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(
        /Breeze formats the Basic auth credential automatically/,
      ),
    ).toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText("Partner Huntress"),
      "Production Huntress",
    );
    await user.type(
      screen.getByPlaceholderText("hk_..."),
      "hk_14b7a762d4770fe29e47",
    );
    await user.type(
      screen.getByPlaceholderText("hs_..."),
      "hs_9d3e49c689f781a453d028374ff665ab",
    );
    await user.click(screen.getByRole("button", { name: /Save & Connect/i }));

    await waitFor(() => {
      expect(
        fetchWithAuthMock.mock.calls.some(
          ([url, init]) =>
            url === "/huntress/integration" && init?.method === "POST",
        ),
      ).toBe(true);
    });

    const postCall = fetchWithAuthMock.mock.calls.find(
      ([url, init]) =>
        url === "/huntress/integration" && init?.method === "POST",
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      name: "Production Huntress",
      apiKey: "hk_14b7a762d4770fe29e47:hs_9d3e49c689f781a453d028374ff665ab",
      isActive: true,
    });
  });

  it("blocks a half-credential (key without secret): shows an error, disables Save, and never POSTs", async () => {
    const user = userEvent.setup();
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad();

    render(<HuntressIntegration />);
    await waitFor(() =>
      expect(screen.getByText("Partner connection")).toBeInTheDocument(),
    );

    await user.type(
      screen.getByPlaceholderText("Partner Huntress"),
      "Production Huntress",
    );
    await user.type(screen.getByPlaceholderText("hk_..."), "hk_only_the_key");

    expect(
      screen.getByText(/Enter both the API Key and API Secret from Huntress/),
    ).toBeInTheDocument();

    const saveButton = screen.getByRole("button", { name: /Save & Connect/i });
    expect(saveButton).toBeDisabled();

    await user.click(saveButton);
    expect(
      fetchWithAuthMock.mock.calls.some(
        ([url, init]) =>
          url === "/huntress/integration" && init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("updates an existing integration without re-entering credentials and omits apiKey from the POST", async () => {
    const user = userEvent.setup();
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({ integration: existingIntegration });

    render(<HuntressIntegration />);
    await waitFor(() =>
      expect(screen.getByText("Partner connection")).toBeInTheDocument(),
    );

    // Name is prefilled from the existing integration; Update is enabled with no credential input.
    const updateButton = screen.getByRole("button", { name: /Update/i });
    expect(updateButton).toBeEnabled();
    await user.click(updateButton);

    await waitFor(() => {
      expect(
        fetchWithAuthMock.mock.calls.some(
          ([url, init]) =>
            url === "/huntress/integration" && init?.method === "POST",
        ),
      ).toBe(true);
    });

    const postCall = fetchWithAuthMock.mock.calls.find(
      ([url, init]) =>
        url === "/huntress/integration" && init?.method === "POST",
    );
    const body = JSON.parse(String(postCall?.[1]?.body));
    expect(body).not.toHaveProperty("apiKey");
    expect(body).toMatchObject({ name: "Existing Huntress", isActive: true });
  });

  it("surfaces a save failure to the user", async () => {
    const user = userEvent.setup();
    useOrgStore.setState({ currentOrgId: null });
    fetchWithAuthMock.mockImplementation(async (url, init) => {
      if (url === "/huntress/integration" && init?.method === "POST") {
        return makeResponse(
          { error: "Invalid Huntress credentials" },
          false,
          400,
        );
      }
      if (url === "/huntress/integration") return makeResponse({ data: null });
      if (url === "/huntress/status") return makeResponse(emptyStatus);
      if (url === "/huntress/incidents?limit=5")
        return makeResponse({ data: [] });
      if (url === "/huntress/organizations") return makeResponse({ data: [] });
      if (url === "/orgs/organizations")
        return makeResponse({ data: [breezeOrg] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);
    await waitFor(() =>
      expect(screen.getByText("Partner connection")).toBeInTheDocument(),
    );

    await user.type(
      screen.getByPlaceholderText("Partner Huntress"),
      "Production Huntress",
    );
    await user.type(
      screen.getByPlaceholderText("hk_..."),
      "hk_14b7a762d4770fe29e47",
    );
    await user.type(
      screen.getByPlaceholderText("hs_..."),
      "hs_9d3e49c689f781a453d028374ff665ab",
    );
    await user.click(screen.getByRole("button", { name: /Save & Connect/i }));

    await waitFor(() =>
      expect(
        screen.getByText("Invalid Huntress credentials"),
      ).toBeInTheDocument(),
    );
  });

  it("warns when live status fails to load instead of rendering an all-clear", async () => {
    getJwtClaimsMock.mockReturnValue(orgClaims);
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (url === "/huntress/integration")
        return makeResponse({ data: existingIntegration });
      if (url === "/huntress/status")
        return makeResponse({ error: "upstream error" }, false, 502);
      if (url === "/huntress/incidents?limit=5")
        return makeResponse({ data: [] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);

    await waitFor(() =>
      expect(
        screen.getByText(/Live Huntress status could not be fully loaded/),
      ).toBeInTheDocument(),
    );
  });

  it("maps a discovered Huntress organization to a Breeze organization", async () => {
    const user = userEvent.setup();
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({
      integration: existingIntegration,
      mappings: [discoveredHuntressOrg],
    });

    render(<HuntressIntegration />);
    await waitFor(() =>
      expect(screen.getByText("Organization mapping")).toBeInTheDocument(),
    );

    await user.selectOptions(
      screen.getByDisplayValue("Select organization"),
      breezeOrg.id,
    );

    await waitFor(() => {
      expect(
        fetchWithAuthMock.mock.calls.some(
          ([url, init]) =>
            url === "/huntress/organizations/map" && init?.method === "POST",
        ),
      ).toBe(true);
    });

    const mapCall = fetchWithAuthMock.mock.calls.find(
      ([url, init]) =>
        url === "/huntress/organizations/map" && init?.method === "POST",
    );
    expect(JSON.parse(String(mapCall?.[1]?.body))).toMatchObject({
      integrationId: "huntress-1",
      huntressOrgId: "huntress-org-1",
      orgId: breezeOrg.id,
    });
  });

  it("surfaces a region-correct, copyable inbound webhook URL carrying the integrationId", async () => {
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({ integration: existingIntegration });

    render(<HuntressIntegration />);

    await waitFor(() =>
      expect(
        screen.getByText("Inbound webhook (push from Huntress)"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(
        "https://us.2breeze.app/api/v1/huntress/webhook?integrationId=huntress-1",
      ),
    ).toBeInTheDocument();
    // Signing scheme is documented so the user can configure the Huntress side.
    expect(
      screen.getByText(/Signing scheme to configure on Huntress/),
    ).toBeInTheDocument();
  });

  it("warns that inbound webhooks are rejected until a webhook secret is configured", async () => {
    useOrgStore.setState({ currentOrgId: null });
    // existingIntegration.hasWebhookSecret is false.
    mockPartnerLoad({ integration: existingIntegration });

    render(<HuntressIntegration />);

    await waitFor(() =>
      expect(
        screen.getByText("Inbound webhook (push from Huntress)"),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/inbound webhooks are rejected with 403/i),
    ).toBeInTheDocument();
  });

  it("does not surface the partner webhook URL or Generate button for an org-scope token", async () => {
    // Org-scope JWT: the webhook endpoint + secret are partner-level and must
    // not leak into a customer-org context (guarded by isPartnerAdmin).
    getJwtClaimsMock.mockReturnValue(orgClaims);
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (url === "/huntress/integration")
        return makeResponse({ data: existingIntegration, mapped: true });
      if (url === "/huntress/status")
        return makeResponse({ ...emptyStatus, mapped: true });
      if (url === "/huntress/incidents?limit=5")
        return makeResponse({ data: [] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);

    await waitFor(() =>
      expect(screen.getByText("Sync status")).toBeInTheDocument(),
    );
    expect(
      screen.queryByText("Inbound webhook (push from Huntress)"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Generate/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/huntress\/webhook\?integrationId=/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Partner connection")).not.toBeInTheDocument();
    expect(screen.queryByText("Organization mapping")).not.toBeInTheDocument();
  });

  it("keeps the read-only org view for an org-scope token even while no org is selected (pre-hydration)", async () => {
    // The old `!currentOrgId` gate misfired here and flashed the partner config
    // UI at org users during the transient pre-hydration null.
    getJwtClaimsMock.mockReturnValue(orgClaims);
    useOrgStore.setState({ currentOrgId: null });
    fetchWithAuthMock.mockImplementation(async (url) => {
      if (url === "/huntress/integration")
        return makeResponse({ data: existingIntegration, mapped: true });
      if (url === "/huntress/status")
        return makeResponse({ ...emptyStatus, mapped: true });
      if (url === "/huntress/incidents?limit=5")
        return makeResponse({ data: [] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);

    await waitFor(() =>
      expect(screen.getByText("Sync status")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Partner connection")).not.toBeInTheDocument();
    expect(screen.queryByText("Organization mapping")).not.toBeInTheDocument();
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith(
      "/huntress/organizations",
    );
  });

  it("generates a webhook secret, fills the input, and shows a copy-once notice that is submitted on save", async () => {
    const user = userEvent.setup();
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({ integration: existingIntegration });

    render(<HuntressIntegration />);
    await waitFor(() =>
      expect(screen.getByText("Partner connection")).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /Generate/i }));

    // Copy-once notice appears; the secret input is revealed (type=text) and populated.
    expect(
      screen.getByText(/Copy this webhook secret now/i),
    ).toBeInTheDocument();
    const secretInput = screen.getByPlaceholderText(
      "Enter or generate a webhook secret",
    ) as HTMLInputElement;
    expect(secretInput.value).toMatch(/^[0-9a-f]{64}$/);
    const generated = secretInput.value;

    await user.click(screen.getByRole("button", { name: /Update/i }));

    await waitFor(() => {
      expect(
        fetchWithAuthMock.mock.calls.some(
          ([url, init]) =>
            url === "/huntress/integration" && init?.method === "POST",
        ),
      ).toBe(true);
    });
    const postCall = fetchWithAuthMock.mock.calls.find(
      ([url, init]) =>
        url === "/huntress/integration" && init?.method === "POST",
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      webhookSecret: generated,
    });
  });

  it("clears the copy-once notice when the user manually edits the generated secret", async () => {
    const user = userEvent.setup();
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({ integration: existingIntegration });

    render(<HuntressIntegration />);
    await waitFor(() =>
      expect(screen.getByText("Partner connection")).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: /Generate/i }));
    expect(
      screen.getByText(/Copy this webhook secret now/i),
    ).toBeInTheDocument();

    // Typing into the secret field means the user is supplying their own value;
    // the "you just generated this, copy it now" banner no longer applies.
    await user.type(
      screen.getByPlaceholderText("Enter or generate a webhook secret"),
      "x",
    );
    expect(
      screen.queryByText(/Copy this webhook secret now/i),
    ).not.toBeInTheDocument();
  });

  // ---- #1736 -------------------------------------------------------------

  it("surfaces a failed last sync prominently rather than an all-clear", async () => {
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({
      integration: {
        ...existingIntegration,
        lastSyncStatus: "error",
        lastSyncError: "scheduled: write CONNECTION_CLOSED",
      },
    });

    render(<HuntressIntegration />);

    await waitFor(() =>
      expect(screen.getByText(/Last sync failed:/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/CONNECTION_CLOSED/)).toBeInTheDocument();
    // The badge reads "Error", never "Connected", when the last sync errored.
    expect(screen.getAllByText("Error").length).toBeGreaterThan(0);
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("shows the persisted last-run result counts when the last sync succeeded", async () => {
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({
      integration: {
        ...existingIntegration,
        lastSyncStatus: "success",
        lastSyncAgents: 12,
        lastSyncIncidents: 3,
        lastSyncOrgs: 26,
      },
    });

    render(<HuntressIntegration />);

    await waitFor(() =>
      expect(
        screen.getByText("Synced 12 agents · 3 incidents · 26 orgs"),
      ).toBeInTheDocument(),
    );
  });

  it('filters the mapping table by search and by "unmapped only"', async () => {
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({
      integration: existingIntegration,
      mappings: [
        {
          ...discoveredHuntressOrg,
          huntressOrgId: "h1",
          huntressOrgName: "Example Org A",
          mappedOrgId: breezeOrg.id,
          mappedOrgName: breezeOrg.name,
        },
        {
          ...discoveredHuntressOrg,
          huntressOrgId: "h2",
          huntressOrgName: "Example Org B",
          mappedOrgId: null,
          mappedOrgName: null,
        },
      ],
    });

    render(<HuntressIntegration />);
    await waitFor(() =>
      expect(screen.getByText("Example Org A")).toBeInTheDocument(),
    );
    expect(screen.getByText("Example Org B")).toBeInTheDocument();

    fireEvent.change(
      screen.getByPlaceholderText(/Search Huntress or Breeze organizations/),
      { target: { value: "example org b" } },
    );
    expect(screen.queryByText("Example Org A")).not.toBeInTheDocument();
    expect(screen.getByText("Example Org B")).toBeInTheDocument();

    fireEvent.change(
      screen.getByPlaceholderText(/Search Huntress or Breeze organizations/),
      { target: { value: "" } },
    );
    fireEvent.click(screen.getByLabelText("Unmapped only"));
    expect(screen.queryByText("Example Org A")).not.toBeInTheDocument();
    expect(screen.getByText("Example Org B")).toBeInTheDocument();
  });

  it("offers an explicit Unmap button that maps the org to null", async () => {
    useOrgStore.setState({ currentOrgId: null });
    mockPartnerLoad({
      integration: existingIntegration,
      mappings: [
        {
          ...discoveredHuntressOrg,
          huntressOrgId: "h1",
          huntressOrgName: "Example Org A",
          mappedOrgId: breezeOrg.id,
          mappedOrgName: breezeOrg.name,
        },
      ],
    });

    render(<HuntressIntegration />);
    const unmapButton = await screen.findByRole("button", { name: /Unmap/ });
    fireEvent.click(unmapButton);

    await waitFor(() =>
      expect(
        fetchWithAuthMock.mock.calls.some(
          ([url, init]) =>
            url === "/huntress/organizations/map" && init?.method === "POST",
        ),
      ).toBe(true),
    );
    const mapCall = fetchWithAuthMock.mock.calls.find(
      ([url]) => url === "/huntress/organizations/map",
    );
    expect(JSON.parse(String(mapCall?.[1]?.body))).toMatchObject({
      huntressOrgId: "h1",
      orgId: null,
    });
  });

  it("paginates the mapping table beyond the page size", async () => {
    useOrgStore.setState({ currentOrgId: null });
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...discoveredHuntressOrg,
      huntressOrgId: `h${i}`,
      huntressOrgName: `Org ${String(i).padStart(2, "0")}`,
      mappedOrgId: null,
      mappedOrgName: null,
    }));
    mockPartnerLoad({ integration: existingIntegration, mappings: many });

    render(<HuntressIntegration />);
    await waitFor(() => expect(screen.getByText("Org 00")).toBeInTheDocument());
    expect(screen.getByText("Org 24")).toBeInTheDocument();
    expect(screen.queryByText("Org 25")).not.toBeInTheDocument();
    expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Org 25")).toBeInTheDocument();
    expect(screen.queryByText("Org 24")).not.toBeInTheDocument();
  });

  it("polls the sync to a terminal state and reports the result counts", async () => {
    useOrgStore.setState({ currentOrgId: null });
    let syncStarted = false;
    let pollCount = 0;
    const running = {
      ...existingIntegration,
      lastSyncStatus: "running",
      lastSyncError: null,
      updatedAt: "2026-06-21T00:00:01.000Z",
    };
    const succeeded = {
      ...existingIntegration,
      lastSyncAt: "2026-06-21T00:00:00.000Z",
      updatedAt: "2026-06-21T00:00:05.000Z",
      lastSyncStatus: "success",
      lastSyncAgents: 12,
      lastSyncIncidents: 3,
      lastSyncOrgs: 26,
    };

    fetchWithAuthMock.mockImplementation(async (url, init) => {
      if (url === "/huntress/sync" && init?.method === "POST") {
        syncStarted = true;
        pollCount = 0;
        return makeResponse({ queued: true, jobId: "job-1" });
      }
      if (url === "/huntress/integration") {
        if (!syncStarted) return makeResponse({ data: existingIntegration });
        pollCount += 1;
        return makeResponse({ data: pollCount === 1 ? running : succeeded });
      }
      if (url === "/huntress/status") return makeResponse(emptyStatus);
      if (url === "/huntress/incidents?limit=5")
        return makeResponse({ data: [] });
      if (url === "/huntress/organizations") return makeResponse({ data: [] });
      if (url === "/orgs/organizations")
        return makeResponse({ data: [breezeOrg] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);
    const syncButton = await screen.findByRole("button", { name: /Sync Now/ });

    vi.useFakeTimers();
    fireEvent.click(syncButton);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(screen.getByText("Syncing…")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(
      screen.getAllByText("Synced 12 agents · 3 incidents · 26 orgs").length,
    ).toBeGreaterThan(0);
  });

  it("polls to an error terminal state and reports the failure (not an all-clear)", async () => {
    useOrgStore.setState({ currentOrgId: null });
    let syncStarted = false;
    let pollCount = 0;
    const running = {
      ...existingIntegration,
      lastSyncStatus: "running",
      lastSyncError: null,
      updatedAt: "2026-06-21T00:00:01.000Z",
    };
    const errored = {
      ...existingIntegration,
      lastSyncStatus: "error",
      lastSyncError: "scheduled: write CONNECTION_CLOSED",
      updatedAt: "2026-06-21T00:00:05.000Z",
    };

    fetchWithAuthMock.mockImplementation(async (url, init) => {
      if (url === "/huntress/sync" && init?.method === "POST") {
        syncStarted = true;
        pollCount = 0;
        return makeResponse({ queued: true });
      }
      if (url === "/huntress/integration") {
        if (!syncStarted) return makeResponse({ data: existingIntegration });
        pollCount += 1;
        return makeResponse({ data: pollCount === 1 ? running : errored });
      }
      if (url === "/huntress/status") return makeResponse(emptyStatus);
      if (url === "/huntress/incidents?limit=5")
        return makeResponse({ data: [] });
      if (url === "/huntress/organizations") return makeResponse({ data: [] });
      if (url === "/orgs/organizations")
        return makeResponse({ data: [breezeOrg] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);
    const syncButton = await screen.findByRole("button", { name: /Sync Now/ });
    vi.useFakeTimers();
    fireEvent.click(syncButton);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    }); // running
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    }); // error
    expect(
      screen.getAllByText(/scheduled: write CONNECTION_CLOSED/).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/Synced /)).not.toBeInTheDocument();
  });

  it('reports a neutral "taking longer" message when the sync never reaches a terminal state', async () => {
    useOrgStore.setState({ currentOrgId: null });
    let syncStarted = false;
    const running = {
      ...existingIntegration,
      lastSyncStatus: "running",
      lastSyncError: null,
      updatedAt: "2026-06-21T00:00:01.000Z",
    };

    fetchWithAuthMock.mockImplementation(async (url, init) => {
      if (url === "/huntress/sync" && init?.method === "POST") {
        syncStarted = true;
        return makeResponse({ queued: true });
      }
      if (url === "/huntress/integration")
        return makeResponse({
          data: syncStarted ? running : existingIntegration,
        });
      if (url === "/huntress/status") return makeResponse(emptyStatus);
      if (url === "/huntress/incidents?limit=5")
        return makeResponse({ data: [] });
      if (url === "/huntress/organizations") return makeResponse({ data: [] });
      if (url === "/orgs/organizations")
        return makeResponse({ data: [breezeOrg] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);
    const syncButton = await screen.findByRole("button", { name: /Sync Now/ });
    vi.useFakeTimers();
    fireEvent.click(syncButton);

    // Drive past the 120s deadline; the row never leaves 'running'.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(123_000);
    });
    expect(screen.getByText(/taking longer than expected/)).toBeInTheDocument();
    expect(screen.queryByText(/Synced /)).not.toBeInTheDocument();
  });

  it("bails with an error after repeated status-read failures instead of spinning silently", async () => {
    useOrgStore.setState({ currentOrgId: null });
    let syncStarted = false;

    fetchWithAuthMock.mockImplementation(async (url, init) => {
      if (url === "/huntress/sync" && init?.method === "POST") {
        syncStarted = true;
        return makeResponse({ queued: true });
      }
      if (url === "/huntress/integration") {
        if (!syncStarted) return makeResponse({ data: existingIntegration });
        return makeResponse({ error: "upstream down" }, false, 500); // every poll read fails
      }
      if (url === "/huntress/status") return makeResponse(emptyStatus);
      if (url === "/huntress/incidents?limit=5")
        return makeResponse({ data: [] });
      if (url === "/huntress/organizations") return makeResponse({ data: [] });
      if (url === "/orgs/organizations")
        return makeResponse({ data: [breezeOrg] });
      return makeResponse({}, false, 404);
    });

    render(<HuntressIntegration />);
    const syncButton = await screen.findByRole("button", { name: /Sync Now/ });
    vi.useFakeTimers();
    fireEvent.click(syncButton);

    // 4 consecutive failed reads (interval 2500ms) → bail with an error message.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500 * 4 + 100);
    });
    expect(screen.getByText(/Could not read sync status/)).toBeInTheDocument();
  });
});
