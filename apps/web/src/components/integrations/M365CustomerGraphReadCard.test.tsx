import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import M365CustomerGraphReadCard from "./M365CustomerGraphReadCard";
import { fetchWithAuth } from "../../stores/auth";
import { runAction } from "../../lib/runAction";
import { navigateToMicrosoftLogin } from "@/lib/navigation";
import { formatDateTime } from "@/lib/dateTimeFormat";

const state = vi.hoisted(() => ({
  currentOrgId: "11111111-1111-4111-8111-111111111111" as string | null,
  jwtScope: "partner" as "partner" | "organization" | null,
  jwtOrgId: null as string | null,
  canWrite: true,
  successMessages: [] as string[],
  errorMessages: [] as string[],
}));

vi.mock("../../stores/auth", () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock("../../stores/orgStore", () => ({
  useOrgStore: vi.fn((selector: (value: { currentOrgId: string | null }) => unknown) =>
    selector({ currentOrgId: state.currentOrgId }),
  ),
}));

vi.mock("../../lib/authScope", () => ({
  getJwtClaims: vi.fn(() => ({
    scope: state.jwtScope,
    orgId: state.jwtOrgId,
    partnerId: null,
  })),
}));

vi.mock("../../lib/permissions", () => ({
  usePermissions: vi.fn(() => ({
    permissions: state.canWrite
      ? [{ resource: "organizations", action: "write" }]
      : [],
    can: (resource: string, action: string) =>
      state.canWrite && resource === "organizations" && action === "write",
  })),
}));

vi.mock("../../lib/runAction", () => ({
  runAction: vi.fn(async (options: {
    request: () => Promise<Response>;
    parseSuccess?: (value: unknown) => unknown;
    successMessage?: string | ((value: unknown) => string);
    errorFallback: string;
  }) => {
    let response: Response;
    try {
      response = await options.request();
    } catch (error) {
      state.errorMessages.push(options.errorFallback);
      throw error;
    }
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      state.errorMessages.push(options.errorFallback);
      throw new Error("request failed");
    }
    let result: unknown;
    try {
      result = options.parseSuccess ? options.parseSuccess(value) : value;
    } catch (error) {
      state.errorMessages.push(options.errorFallback);
      throw error;
    }
    if (options.successMessage) {
      const message = typeof options.successMessage === "function"
        ? options.successMessage(result)
        : options.successMessage;
      if (message) state.successMessages.push(message);
    }
    return result;
  }),
  handleActionError: vi.fn(),
}));

vi.mock("@/lib/navigation", () => ({ navigateToMicrosoftLogin: vi.fn() }));

vi.mock("@/lib/dateTimeFormat", () => ({
  formatDateTime: vi.fn((value: string) => `formatted ${value}`),
  formatRelativeTime: vi.fn((value: string) => `relative ${value}`),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const runActionMock = vi.mocked(runAction);
const navigateToMicrosoftLoginMock = vi.mocked(navigateToMicrosoftLogin);
const formatDateTimeMock = vi.mocked(formatDateTime);

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const CONNECTION_ID = "33333333-3333-4333-8333-333333333333";
const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
const REQUIRED_GRANTS = [
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
].map(([appRoleId, value]) => ({
  resourceApplicationId: GRAPH_APP_ID,
  appRoleId,
  value,
}));

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    profile: {
      id: "customer-graph-read",
      displayName: "Customer Graph Read",
      manifestVersion: 3,
      requiredGrants: REQUIRED_GRANTS,
    },
    onboardingEnabled: true,
    connection: null,
    syncEnabled: true,
    sync: {
      lastSuccessAt: "2026-09-08T11:30:00.000Z",
      users: 128,
      devices: 96,
      domains: [
        { domain: "users", status: "success", asOf: "2026-09-08T11:30:00.000Z", truncated: false, unlicensed: false },
        { domain: "signin_activity", status: "success", asOf: "2026-09-08T06:00:00.000Z", truncated: false, unlicensed: false },
        { domain: "intune_devices", status: "success", asOf: "2026-09-08T11:00:00.000Z", truncated: false, unlicensed: false },
        { domain: "ca_policies", status: "success", asOf: "2026-09-08T02:00:00.000Z", truncated: false, unlicensed: false },
        { domain: "skus", status: "success", asOf: "2026-09-08T02:00:00.000Z", truncated: false, unlicensed: false },
        { domain: "secure_score", status: "success", asOf: "2026-09-08T02:00:00.000Z", truncated: false, unlicensed: false },
      ],
    },
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    tenantId: "44444444-4444-4444-8444-444444444444",
    clientId: "55555555-5555-4555-8555-555555555555",
    displayName: "Northwind Tenant",
    status: "active",
    grantHealth: "active",
    manifestVersion: 3,
    currentManifestVersion: 3,
    observedGrants: REQUIRED_GRANTS,
    missingGrants: [],
    unexpectedGrants: [],
    grantsVerifiedAt: "2026-07-14T18:00:00.000Z",
    lastVerifiedAt: "2026-07-14T18:01:00.000Z",
    lastErrorCode: null,
    ...overrides,
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

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Response>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("M365CustomerGraphReadCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.currentOrgId = ORG_A;
    state.jwtScope = "partner";
    state.jwtOrgId = null;
    state.canWrite = true;
    state.successMessages = [];
    state.errorMessages = [];
  });

  it("renders the exact thirteen fixed permissions and no credential inputs for an empty envelope", async () => {
    fetchWithAuthMock.mockResolvedValue(makeResponse(envelope()));

    render(<M365CustomerGraphReadCard />);

    expect(
      await screen.findByRole("heading", { name: "Customer Graph Read" }),
    ).toBeInTheDocument();
    for (const grant of REQUIRED_GRANTS) {
      expect(screen.getByText(grant.value)).toBeInTheDocument();
    }
    expect(screen.getAllByTestId("required-grant")).toHaveLength(13);
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByLabelText(/client secret|certificate|vault/i)).not.toBeInTheDocument();
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      `/m365/connections?orgId=${ORG_A}`,
    );
  });

  it("shows when onboarding is unavailable for the selected organization", async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({ onboardingEnabled: false })),
    );

    render(<M365CustomerGraphReadCard />);

    expect(
      await screen.findByText(
        "Customer Graph Read onboarding is not enabled for this organization.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it.each([
    ["active", "Microsoft consent completed. The refreshed connection status is shown below."],
    ["degraded", "Microsoft consent completed, but the connection needs attention. Refreshed details are shown below."],
    ["consent_expired", "The consent session expired. Start consent again."],
    ["executor_unavailable", "The verification service is unavailable. Retest later."],
  ] as const)("shows safe callback copy for %s and refreshes once", async (callbackResult, message) => {
    fetchWithAuthMock.mockResolvedValue(makeResponse(envelope()));

    render(<M365CustomerGraphReadCard callbackResult={callbackResult} />);

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(document.body).not.toHaveTextContent(/authorization[_ -]?code|access[_ -]?token|tenant hint/i);
  });

  it("refreshes once per callback event, including a repeated result, without refreshing when only clearing the banner", async () => {
    fetchWithAuthMock.mockResolvedValue(makeResponse(envelope()));
    const view = render(<M365CustomerGraphReadCard />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));

    view.rerender(<M365CustomerGraphReadCard callbackResult="tenant_mismatch" callbackRefreshKey={1} />);
    expect(await screen.findByText("Microsoft returned a different tenant. Start consent again for this organization.")).toBeInTheDocument();
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));

    view.rerender(<M365CustomerGraphReadCard callbackResult="tenant_mismatch" callbackRefreshKey={2} />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(3));

    view.rerender(<M365CustomerGraphReadCard callbackResult={null} callbackRefreshKey={2} />);
    expect(screen.queryByText("Microsoft returned a different tenant. Start consent again for this organization.")).not.toBeInTheDocument();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(3);
  });

  it("clears an Org A callback during an in-flight switch, keeps Org B data, and refreshes once for a B callback", async () => {
    const pendingOrgA = deferredResponse();
    fetchWithAuthMock
      .mockReturnValueOnce(pendingOrgA.promise)
      .mockResolvedValueOnce(makeResponse(envelope({
        connection: connection({
          id: "88888888-8888-4888-8888-888888888888",
          tenantId: "99999999-9999-4999-8999-999999999999",
          displayName: "Contoso B",
        }),
      })))
      .mockResolvedValueOnce(makeResponse(envelope({
        connection: connection({
          id: "88888888-8888-4888-8888-888888888888",
          tenantId: "99999999-9999-4999-8999-999999999999",
          displayName: "Contoso B",
        }),
      })));

    const view = render(
      <M365CustomerGraphReadCard
        callbackResult="tenant_mismatch"
        callbackRefreshKey={1}
      />,
    );
    expect(screen.getByText("Microsoft returned a different tenant. Start consent again for this organization.")).toBeInTheDocument();

    state.currentOrgId = ORG_B;
    view.rerender(
      <M365CustomerGraphReadCard callbackResult={null} callbackRefreshKey={1} />,
    );
    expect(screen.queryByText("Microsoft returned a different tenant. Start consent again for this organization.")).not.toBeInTheDocument();
    expect(await screen.findByText("Contoso B")).toBeInTheDocument();

    pendingOrgA.resolve(makeResponse(envelope({ connection: connection() })));
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByText("Contoso B")).toBeInTheDocument();
    expect(screen.queryByText("Northwind Tenant")).not.toBeInTheDocument();

    view.rerender(
      <M365CustomerGraphReadCard callbackResult="active" callbackRefreshKey={2} />,
    );
    expect(await screen.findByText("Microsoft consent completed. The refreshed connection status is shown below.")).toBeInTheDocument();
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(3));
  });

  it.each([
    ["pending-consent", "Pending consent", false],
    ["verifying", "Verifying", false],
    ["active", "Active", true],
    ["degraded", "Degraded", true],
    ["suspended", "Suspended", false],
    ["revoked", "Revoked", false],
  ])("strictly accepts %s and renders only API-valid actions", async (status, label, canRetest) => {
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({ connection: connection({ status }) })),
    );

    render(<M365CustomerGraphReadCard />);

    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-consent" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Disconnect from Breeze" })).toBeEnabled();
    if (canRetest) {
      expect(screen.getByRole("button", { name: "Retest" })).toBeEnabled();
    } else {
      expect(screen.queryByRole("button", { name: "Retest" })).not.toBeInTheDocument();
    }
  });

  it("accepts the server-shaped revoked DTO and keeps reconnection available", async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({ connection: connection({
        tenantId: null,
        clientId: null,
        displayName: null,
        status: "revoked",
        observedGrants: [],
        missingGrants: [],
        unexpectedGrants: [],
        grantsVerifiedAt: null,
        lastVerifiedAt: null,
      }) })),
    );

    render(<M365CustomerGraphReadCard />);

    expect(await screen.findByText("Revoked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-consent" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Retest" })).not.toBeInTheDocument();
  });

  it.each([
    ["unknown status", envelope({ connection: connection({ status: "connected" }) })],
    ["unknown envelope field", { ...envelope(), extra: true }],
    ["malformed grant", envelope({ profile: { ...envelope().profile, requiredGrants: [{ value: "User.Read.All" }] } })],
    ["secret-shaped field", envelope({ connection: { ...connection(), clientSecret: "do-not-render" } })],
  ])("fails closed for %s", async (_case, payload) => {
    fetchWithAuthMock.mockResolvedValue(makeResponse(payload));

    render(<M365CustomerGraphReadCard />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connection details are unavailable.",
    );
    expect(screen.queryByText("do-not-render")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("fails closed when one canonical manifest assignment is substituted", async () => {
    const substituted = REQUIRED_GRANTS.map((grant, index) =>
      index === 0
        ? {
            resourceApplicationId: grant.resourceApplicationId,
            appRoleId: "77777777-7777-4777-8777-777777777777",
            value: "Directory.Read.All",
          }
        : grant,
    );
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({ profile: { ...envelope().profile, requiredGrants: substituted } })),
    );

    render(<M365CustomerGraphReadCard />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connection details are unavailable.",
    );
    expect(screen.queryByText("Directory.Read.All")).not.toBeInTheDocument();
  });

  it("shows tenant, manifest, grant groups, and formatted verification timestamps", async () => {
    const missing = REQUIRED_GRANTS[0];
    const unexpected = {
      resourceApplicationId: GRAPH_APP_ID,
      appRoleId: "66666666-6666-4666-8666-666666666666",
      value: "Directory.Read.All",
    };
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({
        connection: connection({
          status: "degraded",
          observedGrants: REQUIRED_GRANTS.slice(1).concat(unexpected),
          missingGrants: [missing],
          unexpectedGrants: [unexpected],
        }),
      })),
    );

    render(<M365CustomerGraphReadCard />);

    expect(await screen.findByText("Northwind Tenant")).toBeInTheDocument();
    expect(screen.getByText("44444444-4444-4444-8444-444444444444")).toBeInTheDocument();
    expect(screen.getByText("Manifest version 3")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Required permissions" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Observed permissions" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Missing permissions" })).toBeInTheDocument();
    const warning = screen.getByRole("alert");
    expect(warning).toHaveAccessibleName("Unexpected permissions detected");
    expect(warning).toHaveTextContent("Directory.Read.All");
    expect(formatDateTimeMock).toHaveBeenCalledWith("2026-07-14T18:00:00.000Z");
    expect(formatDateTimeMock).toHaveBeenCalledWith("2026-07-14T18:01:00.000Z");
    expect(screen.getByText("formatted 2026-07-14T18:00:00.000Z")).toBeInTheDocument();
  });

  it("keeps an unexpected grant visible when Microsoft returns no display value", async () => {
    const unknownRole = {
      resourceApplicationId: GRAPH_APP_ID,
      appRoleId: "99999999-9999-4999-8999-999999999999",
      value: null,
    };
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({ connection: connection({
        status: "degraded",
        observedGrants: [...REQUIRED_GRANTS, unknownRole],
        unexpectedGrants: [unknownRole],
      }) })),
    );

    render(<M365CustomerGraphReadCard />);

    const warning = await screen.findByRole("alert", { name: "Unexpected permissions detected" });
    expect(warning).toHaveTextContent(
      "Unknown permission (role 99999999-9999-4999-8999-999999999999)",
    );
  });

  it("shows first-time unavailable reconciliation as unknown without definitive drift", async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({ connection: connection({
        status: "degraded",
        observedGrants: [],
        missingGrants: [],
        unexpectedGrants: [],
        grantsVerifiedAt: null,
        lastErrorCode: "grant_reconciliation_unavailable",
      }) })),
    );

    render(<M365CustomerGraphReadCard />);

    expect(await screen.findByRole("heading", { name: "Observed permissions" })).toBeInTheDocument();
    expect(screen.getByText(
      "Microsoft could not complete permission reconciliation. No verified permission result is available yet.",
    )).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /missing permissions/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/last-known observed permissions/i)).not.toBeInTheDocument();
  });

  it("labels retained observations and derived drift as last known when reconciliation was unavailable", async () => {
    const unexpected = {
      resourceApplicationId: GRAPH_APP_ID,
      appRoleId: "66666666-6666-4666-8666-666666666666",
      value: "Directory.Read.All",
    };
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({ connection: connection({
        status: "degraded",
        missingGrants: [REQUIRED_GRANTS[0]],
        unexpectedGrants: [unexpected],
        lastErrorCode: "grant_reconciliation_unavailable",
      }) })),
    );

    render(<M365CustomerGraphReadCard />);

    expect(await screen.findByRole("heading", { name: "Last-known observed permissions" })).toBeInTheDocument();
    expect(screen.getByText("Microsoft could not complete permission reconciliation. The observed list is the last known result.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Last-known missing permissions" })).toBeInTheDocument();
    expect(screen.getByRole("alert", { name: "Last-known unexpected permissions detected" })).toHaveTextContent("Directory.Read.All");
    expect(screen.queryByText("grant_reconciliation_unavailable")).not.toBeInTheDocument();
  });

  it("localizes known stable codes and never renders raw or unknown codes", async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({ connection: connection({
        status: "degraded",
        lastErrorCode: "admin_role_required",
      }) })),
    );
    const { unmount } = render(<M365CustomerGraphReadCard />);

    expect(await screen.findByText("A Global Administrator or Privileged Role Administrator must grant consent.")).toBeInTheDocument();
    expect(screen.queryByText("admin_role_required")).not.toBeInTheDocument();
    unmount();

    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({ connection: connection({
        status: "degraded",
        lastErrorCode: "provider-secret-detail",
      }) })),
    );
    render(<M365CustomerGraphReadCard />);
    expect(await screen.findByText("Verification needs attention. Retest the connection or start consent again.")).toBeInTheDocument();
    expect(screen.queryByText("provider-secret-detail")).not.toBeInTheDocument();
  });

  it("starts consent through runAction and navigates only to the validated server Microsoft URL", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope()))
      .mockResolvedValueOnce(makeResponse({ adminConsentUrl: "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=server-owned" }));

    render(<M365CustomerGraphReadCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));

    await waitFor(() => expect(runActionMock).toHaveBeenCalledTimes(1));
    expect(fetchWithAuthMock).toHaveBeenNthCalledWith(
      2,
      `/m365/connections/customer-graph-read/consent?orgId=${ORG_A}`,
      { method: "POST" },
    );
    expect(navigateToMicrosoftLoginMock).toHaveBeenCalledWith(
      "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=server-owned",
    );
  });

  it("rejects a non-Microsoft consent URL returned by the server", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope()))
      .mockResolvedValueOnce(makeResponse({ adminConsentUrl: "https://evil.example/consent" }));

    render(<M365CustomerGraphReadCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));

    await waitFor(() => expect(runActionMock).toHaveBeenCalledTimes(1));
    expect(navigateToMicrosoftLoginMock).not.toHaveBeenCalled();
  });

  it("retests through runAction, prevents duplicate clicks, and reloads", async () => {
    let finish!: (response: Response) => void;
    const mutation = new Promise<Response>((resolve) => { finish = resolve; });
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope({ connection: connection() })))
      .mockReturnValueOnce(mutation)
      .mockResolvedValueOnce(makeResponse(envelope({ connection: connection() })));

    render(<M365CustomerGraphReadCard />);
    const retest = await screen.findByRole("button", { name: "Retest" });
    fireEvent.click(retest);
    fireEvent.click(retest);

    expect(retest).toBeDisabled();
    expect(runActionMock).toHaveBeenCalledTimes(1);
    finish(makeResponse({ connection: connection() }));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(3));
    expect(fetchWithAuthMock).toHaveBeenNthCalledWith(
      2,
      `/m365/connections/${CONNECTION_ID}/retest?orgId=${ORG_A}`,
      { method: "POST" },
    );
  });

  it("does not let a deferred Org A retest overwrite Org B or block Org B actions", async () => {
    const pendingRetest = deferredResponse();
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope({ connection: connection() })))
      .mockReturnValueOnce(pendingRetest.promise)
      .mockResolvedValueOnce(makeResponse(envelope({
        connection: connection({
          id: "88888888-8888-4888-8888-888888888888",
          tenantId: "99999999-9999-4999-8999-999999999999",
          displayName: "Contoso B",
        }),
      })));
    const view = render(<M365CustomerGraphReadCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Retest" }));

    state.currentOrgId = ORG_B;
    view.rerender(<M365CustomerGraphReadCard />);
    expect(await screen.findByText("Contoso B")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retest" })).toBeEnabled();

    pendingRetest.resolve(makeResponse({ connection: connection() }));
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchWithAuthMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Contoso B")).toBeInTheDocument();
    expect(screen.queryByText("Northwind Tenant")).not.toBeInTheDocument();
    expect(state.successMessages).toEqual([]);
  });

  it("warns that Microsoft consent remains, disconnects through runAction, and reloads", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope({ connection: connection() })))
      .mockResolvedValueOnce(makeResponse({ connection: connection({ status: "revoked" }) }))
      .mockResolvedValueOnce(makeResponse(envelope({ connection: connection({ status: "revoked" }) })));

    render(<M365CustomerGraphReadCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect from Breeze" }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(3));
    expect(confirm).toHaveBeenCalledWith(
      "Disconnecting stops Breeze from using this connection. Microsoft tenant-wide consent remains until a customer administrator removes it in Microsoft Entra.",
    );
    expect(runActionMock).toHaveBeenCalledTimes(1);
    expect(fetchWithAuthMock).toHaveBeenNthCalledWith(
      2,
      `/m365/connections/${CONNECTION_ID}/disconnect?orgId=${ORG_A}`,
      { method: "POST" },
    );
    confirm.mockRestore();
  });

  it("does not let a deferred Org A disconnect reload or clear Org B action state", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const pendingDisconnect = deferredResponse();
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope({ connection: connection() })))
      .mockReturnValueOnce(pendingDisconnect.promise)
      .mockResolvedValueOnce(makeResponse(envelope({
        connection: connection({
          id: "88888888-8888-4888-8888-888888888888",
          tenantId: "99999999-9999-4999-8999-999999999999",
          displayName: "Contoso B",
        }),
      })));
    const view = render(<M365CustomerGraphReadCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect from Breeze" }));

    state.currentOrgId = ORG_B;
    view.rerender(<M365CustomerGraphReadCard />);
    expect(await screen.findByText("Contoso B")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect from Breeze" })).toBeEnabled();

    pendingDisconnect.resolve(makeResponse({ connection: connection({ status: "revoked" }) }));
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchWithAuthMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Contoso B")).toBeInTheDocument();
    expect(state.successMessages).toEqual([]);
    confirm.mockRestore();
  });

  it("does not navigate for deferred Org A consent and allows Org B consent", async () => {
    const pendingConsent = deferredResponse();
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope()))
      .mockReturnValueOnce(pendingConsent.promise)
      .mockResolvedValueOnce(makeResponse(envelope()))
      .mockResolvedValueOnce(makeResponse({
        adminConsentUrl: "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=org-b",
      }));
    const view = render(<M365CustomerGraphReadCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));

    state.currentOrgId = ORG_B;
    view.rerender(<M365CustomerGraphReadCard />);
    const orgBConnect = await screen.findByRole("button", { name: "Connect" });
    expect(orgBConnect).toBeEnabled();
    fireEvent.click(orgBConnect);
    await waitFor(() =>
      expect(navigateToMicrosoftLoginMock).toHaveBeenCalledWith(
        "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=org-b",
      ),
    );

    pendingConsent.resolve(makeResponse({
      adminConsentUrl: "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=org-a",
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(navigateToMicrosoftLoginMock).toHaveBeenCalledTimes(1);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(4);
  });

  it("keeps the completed Org B load when an older Org A load resolves last", async () => {
    const pendingOrgA = deferredResponse();
    fetchWithAuthMock
      .mockReturnValueOnce(pendingOrgA.promise)
      .mockResolvedValueOnce(makeResponse(envelope({
        connection: connection({
          id: "88888888-8888-4888-8888-888888888888",
          tenantId: "99999999-9999-4999-8999-999999999999",
          displayName: "Contoso B",
        }),
      })));
    const view = render(<M365CustomerGraphReadCard />);

    state.currentOrgId = ORG_B;
    view.rerender(<M365CustomerGraphReadCard />);
    expect(await screen.findByText("Contoso B")).toBeInTheDocument();

    pendingOrgA.resolve(makeResponse(envelope({ connection: connection() })));
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Contoso B")).toBeInTheDocument();
    expect(screen.queryByText("Northwind Tenant")).not.toBeInTheDocument();
  });

  it.each([
    ["consent", "Connect"],
    ["retest", "Retest"],
    ["disconnect", "Disconnect from Breeze"],
    ["sync", "Sync now"],
  ])("silences a stale %s network rejection after switching to Org B", async (operation, buttonName) => {
    const confirm = operation === "disconnect"
      ? vi.spyOn(window, "confirm").mockReturnValue(true)
      : null;
    const pendingAction = deferredResponse();
    const hasConnection = operation !== "consent";
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope({
        connection: hasConnection ? connection() : null,
      })))
      .mockReturnValueOnce(pendingAction.promise)
      .mockResolvedValueOnce(makeResponse(envelope({
        connection: hasConnection
          ? connection({
              id: "88888888-8888-4888-8888-888888888888",
              tenantId: "99999999-9999-4999-8999-999999999999",
              displayName: "Contoso B",
            })
          : null,
      })));
    const view = render(<M365CustomerGraphReadCard />);
    fireEvent.click(await screen.findByRole("button", { name: buttonName }));

    state.currentOrgId = ORG_B;
    view.rerender(<M365CustomerGraphReadCard />);
    const orgBAction = await screen.findByRole("button", { name: buttonName });
    expect(orgBAction).toBeEnabled();

    pendingAction.reject(new Error("stale network failure"));
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchWithAuthMock).toHaveBeenCalledTimes(3);
    expect(state.errorMessages).toEqual([]);
    expect(state.successMessages).toEqual([]);
    expect(navigateToMicrosoftLoginMock).not.toHaveBeenCalled();
    expect(orgBAction).toBeEnabled();
    confirm?.mockRestore();
  });

  it.each([
    ["consent", "Connect", "complete"],
    ["consent", "Connect", "reject"],
    ["retest", "Retest", "complete"],
    ["retest", "Retest", "reject"],
    ["disconnect", "Disconnect from Breeze", "complete"],
    ["disconnect", "Disconnect from Breeze", "reject"],
    ["sync", "Sync now", "complete"],
    ["sync", "Sync now", "reject"],
  ])("silences a stale %s response body %s after switching to Org B", async (operation, buttonName, outcome) => {
    const confirm = operation === "disconnect"
      ? vi.spyOn(window, "confirm").mockReturnValue(true)
      : null;
    let resolveBody!: (body: string) => void;
    let rejectBody!: (error: unknown) => void;
    const body = new Promise<string>((resolve, reject) => {
      resolveBody = resolve;
      rejectBody = reject;
    });
    const textMock = vi.fn(() => body);
    const jsonMock = vi.fn(() => body);
    const actionResponse = {
      ok: false,
      status: 500,
      statusText: "Error",
      headers: new Headers({ "content-type": "application/json" }),
      text: textMock,
      json: jsonMock,
    } as unknown as Response;
    const hasConnection = operation !== "consent";
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope({
        connection: hasConnection ? connection() : null,
      })))
      .mockResolvedValueOnce(actionResponse)
      .mockResolvedValueOnce(makeResponse(envelope({
        connection: hasConnection
          ? connection({
              id: "88888888-8888-4888-8888-888888888888",
              tenantId: "99999999-9999-4999-8999-999999999999",
              displayName: "Contoso B",
            })
          : null,
      })));
    const view = render(<M365CustomerGraphReadCard />);
    fireEvent.click(await screen.findByRole("button", { name: buttonName }));
    await waitFor(() =>
      expect(textMock.mock.calls.length + jsonMock.mock.calls.length).toBe(1),
    );

    state.currentOrgId = ORG_B;
    view.rerender(<M365CustomerGraphReadCard />);
    const orgBAction = await screen.findByRole("button", { name: buttonName });
    expect(orgBAction).toBeEnabled();

    if (outcome === "complete") resolveBody('{"error":"stale provider detail"}');
    else rejectBody(new Error("stale body failure"));
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchWithAuthMock).toHaveBeenCalledTimes(3);
    expect(state.errorMessages).toEqual([]);
    expect(state.successMessages).toEqual([]);
    expect(navigateToMicrosoftLoginMock).not.toHaveBeenCalled();
    expect(orgBAction).toBeEnabled();
    confirm?.mockRestore();
  });

  it("uses at least 44px touch targets for every action", async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({ connection: connection() })),
    );
    render(<M365CustomerGraphReadCard />);

    for (const name of ["Re-consent", "Retest", "Disconnect from Breeze"]) {
      expect(await screen.findByRole("button", { name })).toHaveClass("min-h-11");
    }
  });

  it("disables every mutation without organizations:write", async () => {
    state.canWrite = false;
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({ connection: connection({ status: "degraded" }) })),
    );

    render(<M365CustomerGraphReadCard />);

    expect(await screen.findByRole("button", { name: "Re-consent" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retest" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disconnect from Breeze" })).toBeDisabled();
  });

  it("clears Org A metadata immediately when the subscribed organization changes", async () => {
    const pending = deferredResponse();
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope({ connection: connection() })))
      .mockReturnValueOnce(pending.promise);
    const view = render(<M365CustomerGraphReadCard />);
    expect(await screen.findByText("Northwind Tenant")).toBeInTheDocument();

    state.currentOrgId = ORG_B;
    view.rerender(<M365CustomerGraphReadCard />);

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        `/m365/connections?orgId=${ORG_B}`,
      ),
    );
    expect(screen.queryByText("Northwind Tenant")).not.toBeInTheDocument();
    expect(screen.queryByText("44444444-4444-4444-8444-444444444444")).not.toBeInTheDocument();
    pending.resolve(makeResponse(envelope()));
  });

  it("uses the JWT org only for organization-scoped sessions and blocks partner-wide mode", async () => {
    state.currentOrgId = null;
    state.jwtScope = "organization";
    state.jwtOrgId = ORG_A;
    fetchWithAuthMock.mockResolvedValueOnce(makeResponse(envelope()));
    const view = render(<M365CustomerGraphReadCard />);

    expect(await screen.findByRole("button", { name: "Connect" })).toBeEnabled();
    expect(fetchWithAuthMock).toHaveBeenCalledWith(`/m365/connections?orgId=${ORG_A}`);
    view.unmount();

    vi.clearAllMocks();
    state.jwtScope = "partner";
    state.jwtOrgId = ORG_A;
    render(<M365CustomerGraphReadCard />);
    expect(await screen.findByText("Select an organization to manage Customer Graph Read.")).toBeInTheDocument();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });
  describe("manifest upgrade banner", () => {
    it("shows the amber banner and the approve button for a manifest-stale connection", async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({
        connection: connection({ manifestVersion: 2, grantHealth: "manifest-stale" }),
      })));

      render(<M365CustomerGraphReadCard />);

      const banner = await screen.findByTestId("m365-read-manifest-stale-banner");
      expect(banner).toHaveTextContent(
        "New Microsoft 365 permissions are required for Conditional Access, Secure Score, and admin role visibility. A Global Administrator must approve them.",
      );
      expect(screen.getByTestId("m365-read-approve-new-permissions")).toBeEnabled();
    });

    it("hides the banner for a current connection", async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({
        connection: connection(),
      })));

      render(<M365CustomerGraphReadCard />);

      expect(await screen.findByRole("heading", { name: "Customer Graph Read" })).toBeInTheDocument();
      expect(screen.queryByTestId("m365-read-manifest-stale-banner")).not.toBeInTheDocument();
    });

    it("starts the upgrade through runAction and navigates to the validated Microsoft URL", async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeResponse(envelope({
          connection: connection({ manifestVersion: 2, grantHealth: "manifest-stale" }),
        })))
        .mockResolvedValueOnce(makeResponse({
          adminConsentUrl: "https://login.microsoftonline.com/common/adminconsent?state=raw",
        }));

      render(<M365CustomerGraphReadCard />);
      fireEvent.click(await screen.findByTestId("m365-read-approve-new-permissions"));

      await waitFor(() => expect(runActionMock).toHaveBeenCalledTimes(1));
      expect(fetchWithAuthMock).toHaveBeenLastCalledWith(
        `/m365/connections/${CONNECTION_ID}/upgrade-consent?orgId=${ORG_A}`,
        { method: "POST" },
      );
      await waitFor(() => expect(navigateToMicrosoftLoginMock).toHaveBeenCalledWith(
        "https://login.microsoftonline.com/common/adminconsent?state=raw",
      ));
    });

    it("refuses to navigate to a non-Microsoft consent URL", async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(makeResponse(envelope({
          connection: connection({ manifestVersion: 2, grantHealth: "manifest-stale" }),
        })))
        .mockResolvedValueOnce(makeResponse({ adminConsentUrl: "https://evil.example/adminconsent" }));

      render(<M365CustomerGraphReadCard />);
      fireEvent.click(await screen.findByTestId("m365-read-approve-new-permissions"));

      await waitFor(() => expect(runActionMock).toHaveBeenCalledTimes(1));
      expect(navigateToMicrosoftLoginMock).not.toHaveBeenCalled();
    });

    it("disables the approve button without organizations:write", async () => {
      state.canWrite = false;
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({
        connection: connection({ manifestVersion: 2, grantHealth: "manifest-stale" }),
      })));

      render(<M365CustomerGraphReadCard />);

      expect(await screen.findByTestId("m365-read-approve-new-permissions")).toBeDisabled();
    });

    it("still renders missing grants degraded rather than the banner once the manifest is current", async () => {
      // Spec §2.2: missing grants after a retest keep the EXISTING degraded
      // rendering; the banner is only for a stale manifest.
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({
        connection: connection({
          grantHealth: "missing",
          status: "degraded",
          observedGrants: REQUIRED_GRANTS.slice(0, 12),
          missingGrants: REQUIRED_GRANTS.slice(12),
        }),
      })));

      render(<M365CustomerGraphReadCard />);

      expect(await screen.findByRole("heading", { name: "Customer Graph Read" })).toBeInTheDocument();
      expect(screen.queryByTestId("m365-read-manifest-stale-banner")).not.toBeInTheDocument();
      expect(screen.getAllByText(REQUIRED_GRANTS[12]!.value).length).toBeGreaterThan(0);
    });

    it("rejects an envelope whose connection is missing the new fields", async () => {
      // hasExactKeys is exact in both directions: a server that has not shipped
      // the DTO change yet must fail closed, not render a half-parsed card.
      const stale = connection();
      delete (stale as Record<string, unknown>).grantHealth;
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({ connection: stale })));

      render(<M365CustomerGraphReadCard />);

      expect(await screen.findByText("Connection details are unavailable."))
        .toBeInTheDocument();
    });
  });

  describe("Sync now", () => {
    it("is hidden when the DTO says sync is disabled", async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({
        connection: connection(),
        syncEnabled: false,
        sync: null,
      })));
      render(<M365CustomerGraphReadCard />);
      await screen.findByRole("button", { name: "Retest" });
      expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
    });

    it("is hidden when there is no connection", async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({ connection: null, syncEnabled: true })));
      render(<M365CustomerGraphReadCard />);
      await screen.findByRole("button", { name: "Connect" });
      expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
    });

    it("is hidden for a revoked connection", async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({
        syncEnabled: true, connection: connection({ status: "revoked" }),
      })));
      render(<M365CustomerGraphReadCard />);
      await screen.findByRole("button", { name: "Re-consent" });
      expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
    });

    it("posts through runAction, prevents duplicate clicks, and reloads", async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({ connection: connection() })));
      render(<M365CustomerGraphReadCard />);
      const button = await screen.findByRole("button", { name: "Sync now" });
      fetchWithAuthMock.mockResolvedValue(makeResponse({ requested: true, domains: [] }));

      fireEvent.click(button);
      fireEvent.click(button);
      expect(button).toBeDisabled();

      await waitFor(() => {
        expect(fetchWithAuthMock).toHaveBeenCalledWith(
          `/m365/connections/${CONNECTION_ID}/sync?orgId=${ORG_A}`,
          { method: "POST" },
        );
      });
      expect(runActionMock).toHaveBeenCalledOnce();
      expect(state.successMessages).toContain("Tenant sync requested.");
    });

    it("surfaces a failure through runAction rather than silently no-opping", async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({ connection: connection() })));
      render(<M365CustomerGraphReadCard />);
      const button = await screen.findByRole("button", { name: "Sync now" });
      fetchWithAuthMock.mockResolvedValue(makeResponse({ error: "rate limited" }, false, 429));

      fireEvent.click(button);

      await waitFor(() => {
        expect(state.errorMessages).toContain("Tenant sync could not be requested.");
      });
    });

    it("is disabled without organizations:write", async () => {
      state.canWrite = false;
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({ connection: connection() })));
      render(<M365CustomerGraphReadCard />);
      expect(await screen.findByRole("button", { name: "Sync now" })).toBeDisabled();
    });

    it("does not let a deferred Org A sync block Org B actions", async () => {
      // mirrors the existing retest scope-isolation test in this file
      const pendingSync = deferredResponse();
      fetchWithAuthMock
        .mockResolvedValueOnce(makeResponse(envelope({ connection: connection() })))
        .mockReturnValueOnce(pendingSync.promise)
        .mockResolvedValueOnce(makeResponse(envelope({
          connection: connection({
            id: "88888888-8888-4888-8888-888888888888",
            tenantId: "99999999-9999-4999-8999-999999999999",
            displayName: "Contoso B",
          }),
        })));
      const view = render(<M365CustomerGraphReadCard />);
      fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));

      state.currentOrgId = ORG_B;
      view.rerender(<M365CustomerGraphReadCard />);
      expect(await screen.findByText("Contoso B")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();

      pendingSync.resolve(makeResponse({ requested: true, domains: [] }));
      await Promise.resolve();
      await Promise.resolve();

      expect(fetchWithAuthMock).toHaveBeenCalledTimes(3);
      expect(screen.getByText("Contoso B")).toBeInTheDocument();
      expect(screen.queryByText("Northwind Tenant")).not.toBeInTheDocument();
      expect(state.successMessages).toEqual([]);
    });
  });

  describe("sync summary line and chips", () => {
    it("shows the last-synced line with user and device counts", async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({ syncEnabled: true })));
      render(<M365CustomerGraphReadCard />);

      const summary = await screen.findByTestId("m365-sync-summary");
      expect(summary).toHaveTextContent("Last synced relative 2026-09-08T11:30:00.000Z");
      expect(summary).toHaveTextContent("128 users");
      expect(summary).toHaveTextContent("96 devices");
      expect(screen.queryAllByTestId("m365-sync-chip")).toHaveLength(0);
    });

    it("says not synced yet before the first successful run", async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({
        syncEnabled: true,
        sync: { lastSuccessAt: null, users: null, devices: null, domains: [] },
      })));
      render(<M365CustomerGraphReadCard />);

      expect(await screen.findByTestId("m365-sync-summary")).toHaveTextContent("Not synced yet");
    });

    it("renders a chip per degraded domain, in a fixed precedence, and none for healthy ones", async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({
        syncEnabled: true,
        sync: {
          lastSuccessAt: "2026-09-08T11:30:00.000Z",
          users: 10,
          devices: 5,
          domains: [
            { domain: "users", status: "partial", asOf: "2026-09-08T11:30:00.000Z", truncated: true, unlicensed: false },
            { domain: "signin_activity", status: "success", asOf: null, truncated: false, unlicensed: true },
            { domain: "intune_devices", status: "throttled", asOf: null, truncated: false, unlicensed: false },
            { domain: "ca_policies", status: "needs_consent", asOf: null, truncated: false, unlicensed: false },
            { domain: "skus", status: "error", asOf: null, truncated: false, unlicensed: false },
            { domain: "secure_score", status: "never", asOf: null, truncated: false, unlicensed: false },
          ],
        },
      })));
      render(<M365CustomerGraphReadCard />);

      const chips = await screen.findAllByTestId("m365-sync-chip");
      expect(chips.map((chip) => chip.textContent)).toEqual([
        "Users: partial",
        "Sign-in activity needs Entra ID P1",
        "Intune devices: throttled",
        "Conditional Access: needs consent",
        "Licenses: error",
      ]);
      // 'never' and 'success' are not problems; a domain nobody has run yet is
      // reported by the summary line, not by a warning chip.
    });

    it("hides the sync summary entirely when tenant sync is off", async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({ syncEnabled: false, sync: null })));
      render(<M365CustomerGraphReadCard />);

      expect(await screen.findByRole("heading", { name: "Customer Graph Read" })).toBeInTheDocument();
      expect(screen.queryByTestId("m365-sync-summary")).not.toBeInTheDocument();
    });

    it("rejects an envelope whose sync block has an unknown domain", async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({
        sync: {
          lastSuccessAt: null, users: null, devices: null,
          domains: [{ domain: "mailboxes", status: "success", asOf: null, truncated: false, unlicensed: false }],
        },
      })));
      render(<M365CustomerGraphReadCard />);

      expect(await screen.findByText("Connection details are unavailable.")).toBeInTheDocument();
    });

    it("rejects an envelope whose sync block has an unknown status", async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({
        sync: {
          lastSuccessAt: null, users: null, devices: null,
          domains: [{ domain: "users", status: "weird", asOf: null, truncated: false, unlicensed: false }],
        },
      })));
      render(<M365CustomerGraphReadCard />);

      expect(await screen.findByText("Connection details are unavailable.")).toBeInTheDocument();
    });
  });

  /**
   * Verification, not TDD: W05 built this card and its own suite covers the
   * button, the parser and the hidden states. What only this wave can see is
   * that the envelope shape the API really sends — `syncEnabled` and `sync`
   * on the ENVELOPE, beside `connection`, not inside it — survives the
   * card's strict `hasExactKeys` parser and reaches the screen. A drift
   * between the DTO and the parser degrades the whole card to
   * "unavailable" silently, which is exactly the failure no other test in
   * this wave would notice.
   */
  describe("sync summary renders from the envelope", () => {
    it("shows the last-synced line, the counts, and a chip for the unlicensed domain", async () => {
      fetchWithAuthMock.mockResolvedValue(makeResponse(envelope({
        syncEnabled: true,
        sync: {
          lastSuccessAt: "2026-09-08T11:30:00.000Z",
          users: 128,
          devices: 96,
          domains: [
            { domain: "users", status: "success", asOf: "2026-09-08T11:30:00.000Z", truncated: false, unlicensed: false },
            { domain: "signin_activity", status: "success", asOf: null, truncated: false, unlicensed: true },
            { domain: "intune_devices", status: "success", asOf: "2026-09-08T11:00:00.000Z", truncated: false, unlicensed: false },
            { domain: "ca_policies", status: "success", asOf: "2026-09-08T02:00:00.000Z", truncated: false, unlicensed: false },
            { domain: "skus", status: "success", asOf: "2026-09-08T02:00:00.000Z", truncated: false, unlicensed: false },
            { domain: "secure_score", status: "never", asOf: null, truncated: false, unlicensed: false },
          ],
        },
      })));

      render(<M365CustomerGraphReadCard />);

      // The card parsed the envelope rather than degrading to its
      // "Connection details are unavailable." state. "Last synced" and the
      // counts share ONE text node (M365CustomerGraphReadCard.tsx: the
      // `sync.lastSynced` + `sync.counts` strings are joined with " · "
      // inside a single <p>), so assert on that node's combined content
      // rather than three separate getByText calls.
      const summary = await screen.findByTestId("m365-sync-summary");
      expect(summary).toHaveTextContent(/Last synced/);
      expect(summary).toHaveTextContent("128 users");
      expect(summary).toHaveTextContent("96 devices");
      // At least one chip: sign-in activity on a tenant without Entra ID P1.
      expect(screen.getByText(/Entra ID P1/)).toBeInTheDocument();
    });
  });
});
