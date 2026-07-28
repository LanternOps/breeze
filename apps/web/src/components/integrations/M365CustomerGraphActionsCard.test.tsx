import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import M365CustomerGraphActionsCard from "./M365CustomerGraphActionsCard";
import { fetchWithAuth } from "../../stores/auth";
import { runAction } from "../../lib/runAction";
import { navigateTo } from "@/lib/navigation";
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

vi.mock("@/lib/navigation", () => ({ navigateTo: vi.fn() }));

vi.mock("@/lib/dateTimeFormat", () => ({
  formatDateTime: vi.fn((value: string) => `formatted ${value}`),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const runActionMock = vi.mocked(runAction);
const navigateToMock = vi.mocked(navigateTo);
const formatDateTimeMock = vi.mocked(formatDateTime);

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const CONNECTION_ID = "33333333-3333-4333-8333-333333333333";
const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
const REQUIRED_GRANTS = [
  ["204e0828-b5ca-4ad8-b9f3-f32a958e7cc4", "User.ReadWrite.All"],
  ["56760768-b641-451f-8906-e1b8ab31bca7", "User-PasswordProfile.ReadWrite.All"],
].map(([appRoleId, value]) => ({
  resourceApplicationId: GRAPH_APP_ID,
  appRoleId,
  value,
}));

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    profile: {
      id: "customer-graph-actions",
      displayName: "Customer Graph Actions",
      manifestVersion: 1,
      requiredGrants: REQUIRED_GRANTS,
    },
    onboardingEnabled: true,
    connection: null,
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
    manifestVersion: 1,
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

describe("M365CustomerGraphActionsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.currentOrgId = ORG_A;
    state.jwtScope = "partner";
    state.jwtOrgId = null;
    state.canWrite = true;
    state.successMessages = [];
    state.errorMessages = [];
  });

  it("renders the exact two fixed action permissions for an empty envelope", async () => {
    fetchWithAuthMock.mockResolvedValue(makeResponse(envelope()));

    render(<M365CustomerGraphActionsCard />);

    expect(
      await screen.findByRole("heading", { name: "Customer Graph Actions" }),
    ).toBeInTheDocument();
    for (const grant of REQUIRED_GRANTS) {
      expect(screen.getByText(grant.value)).toBeInTheDocument();
    }
    expect(screen.getAllByTestId("required-grant")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      `/m365/customer-graph-actions/connections?orgId=${ORG_A}`,
    );
  });

  it("disables Connect and shows the unavailable copy when onboarding is off", async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({ onboardingEnabled: false })),
    );

    render(<M365CustomerGraphActionsCard />);

    expect(
      await screen.findByText(
        "Customer Graph Actions onboarding is not enabled for this organization.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("fails closed for an unknown status without rendering the Connect button", async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({ connection: connection({ status: "connected" }) })),
    );

    render(<M365CustomerGraphActionsCard />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connection details are unavailable.",
    );
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("fails closed when a canonical manifest assignment is substituted", async () => {
    const substituted = REQUIRED_GRANTS.map((grant, index) =>
      index === 0
        ? {
            resourceApplicationId: grant.resourceApplicationId,
            appRoleId: "77777777-7777-4777-8777-777777777777",
            value: "Directory.ReadWrite.All",
          }
        : grant,
    );
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({ profile: { ...envelope().profile, requiredGrants: substituted } })),
    );

    render(<M365CustomerGraphActionsCard />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connection details are unavailable.",
    );
    expect(screen.queryByText("Directory.ReadWrite.All")).not.toBeInTheDocument();
  });

  it("shows tenant, manifest, grant groups, and formatted verification timestamps", async () => {
    const missing = REQUIRED_GRANTS[0];
    const unexpected = {
      resourceApplicationId: GRAPH_APP_ID,
      appRoleId: "66666666-6666-4666-8666-666666666666",
      value: "Directory.ReadWrite.All",
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

    render(<M365CustomerGraphActionsCard />);

    expect(await screen.findByText("Northwind Tenant")).toBeInTheDocument();
    expect(screen.getByText("Manifest version 1")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Required permissions" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Observed permissions" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Missing permissions" })).toBeInTheDocument();
    const warning = screen.getByRole("alert");
    expect(warning).toHaveAccessibleName("Unexpected permissions detected");
    expect(warning).toHaveTextContent("Directory.ReadWrite.All");
    expect(formatDateTimeMock).toHaveBeenCalledWith("2026-07-14T18:00:00.000Z");
  });

  it("localizes a known stable code and never renders raw or unknown codes", async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({ connection: connection({
        status: "degraded",
        lastErrorCode: "admin_role_required",
      }) })),
    );
    const { unmount } = render(<M365CustomerGraphActionsCard />);

    expect(await screen.findByText("A Global Administrator or Privileged Role Administrator must grant consent.")).toBeInTheDocument();
    expect(screen.queryByText("admin_role_required")).not.toBeInTheDocument();
    unmount();

    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({ connection: connection({
        status: "degraded",
        lastErrorCode: "provider-secret-detail",
      }) })),
    );
    render(<M365CustomerGraphActionsCard />);
    expect(await screen.findByText("Verification needs attention. Retest the connection or start consent again.")).toBeInTheDocument();
    expect(screen.queryByText("provider-secret-detail")).not.toBeInTheDocument();
  });

  it("starts consent through runAction and navigates only to the validated Microsoft URL", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope()))
      .mockResolvedValueOnce(makeResponse({ adminConsentUrl: "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=server-owned" }));

    render(<M365CustomerGraphActionsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));

    await waitFor(() => expect(runActionMock).toHaveBeenCalledTimes(1));
    expect(fetchWithAuthMock).toHaveBeenNthCalledWith(
      2,
      `/m365/customer-graph-actions/connections/consent?orgId=${ORG_A}`,
      { method: "POST" },
    );
    expect(navigateToMock).toHaveBeenCalledWith(
      "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=server-owned",
    );
  });

  it("rejects a non-Microsoft consent URL returned by the server", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope()))
      .mockResolvedValueOnce(makeResponse({ adminConsentUrl: "https://evil.example/consent" }));

    render(<M365CustomerGraphActionsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));

    await waitFor(() => expect(runActionMock).toHaveBeenCalledTimes(1));
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it("surfaces an error through runAction on an HTTP failure body", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope()))
      .mockResolvedValueOnce(makeResponse({ error: "boom" }, false, 500));

    render(<M365CustomerGraphActionsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));

    await waitFor(() => expect(state.errorMessages).toEqual(["Consent could not be started."]));
    expect(navigateToMock).not.toHaveBeenCalled();
  });

  it("retests through runAction against the actions path and reloads", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope({ connection: connection() })))
      .mockResolvedValueOnce(makeResponse({ connection: connection() }))
      .mockResolvedValueOnce(makeResponse(envelope({ connection: connection() })));

    render(<M365CustomerGraphActionsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Retest" }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(3));
    expect(fetchWithAuthMock).toHaveBeenNthCalledWith(
      2,
      `/m365/customer-graph-actions/connections/${CONNECTION_ID}/retest?orgId=${ORG_A}`,
      { method: "POST" },
    );
  });

  it("warns and disconnects through runAction against the actions path", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope({ connection: connection() })))
      .mockResolvedValueOnce(makeResponse({ connection: connection({ status: "revoked" }) }))
      .mockResolvedValueOnce(makeResponse(envelope({ connection: connection({ status: "revoked" }) })));

    render(<M365CustomerGraphActionsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect from Breeze" }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(3));
    expect(runActionMock).toHaveBeenCalledTimes(1);
    expect(fetchWithAuthMock).toHaveBeenNthCalledWith(
      2,
      `/m365/customer-graph-actions/connections/${CONNECTION_ID}/disconnect?orgId=${ORG_A}`,
      { method: "POST" },
    );
    confirm.mockRestore();
  });

  it("disables every mutation without organizations:write", async () => {
    state.canWrite = false;
    fetchWithAuthMock.mockResolvedValue(
      makeResponse(envelope({ connection: connection({ status: "degraded" }) })),
    );

    render(<M365CustomerGraphActionsCard />);

    expect(await screen.findByRole("button", { name: "Re-consent" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retest" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Disconnect from Breeze" })).toBeDisabled();
  });

  it("clears Org A metadata immediately when the subscribed organization changes", async () => {
    let resolvePending!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolvePending = resolve; });
    fetchWithAuthMock
      .mockResolvedValueOnce(makeResponse(envelope({ connection: connection() })))
      .mockReturnValueOnce(pending);
    const view = render(<M365CustomerGraphActionsCard />);
    expect(await screen.findByText("Northwind Tenant")).toBeInTheDocument();

    state.currentOrgId = ORG_B;
    view.rerender(<M365CustomerGraphActionsCard />);

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        `/m365/customer-graph-actions/connections?orgId=${ORG_B}`,
      ),
    );
    expect(screen.queryByText("Northwind Tenant")).not.toBeInTheDocument();
    resolvePending(makeResponse(envelope()));
  });
});
