import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { M365ConfirmTenantPanel, M365ConsentSteps } from "./M365ConfirmTenantPanel";
import { fetchWithAuth } from "../../stores/auth";
import { runAction } from "../../lib/runAction";
import { navigateToMicrosoftLogin } from "@/lib/navigation";

const state = vi.hoisted(() => ({
  organizations: [] as Array<{ id: string; name: string }>,
  errorMessages: [] as string[],
}));

vi.mock("../../stores/auth", () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock("../../stores/orgStore", () => ({
  useOrgStore: vi.fn((selector: (value: { organizations: Array<{ id: string; name: string }> }) => unknown) =>
    selector({ organizations: state.organizations }),
  ),
}));

vi.mock("../../lib/runAction", () => ({
  runAction: vi.fn(async (options: {
    request: () => Promise<Response>;
    parseSuccess?: (value: unknown) => unknown;
    errorFallback: string;
  }) => {
    const response = await options.request();
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      state.errorMessages.push(options.errorFallback);
      throw new Error("request failed");
    }
    try {
      return options.parseSuccess ? options.parseSuccess(value) : value;
    } catch (error) {
      state.errorMessages.push(options.errorFallback);
      throw error;
    }
  }),
  handleActionError: vi.fn(),
}));

vi.mock("@/lib/navigation", () => ({ navigateToMicrosoftLogin: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const runActionMock = vi.mocked(runAction);
const navigateMock = vi.mocked(navigateToMicrosoftLogin);

const ORG = "11111111-1111-4111-8111-111111111111";
const TENANT = "99999999-9999-4999-8999-999999999999";
const READ_BASE = "/m365/connections/customer-graph-read/consent";
const CONSENT_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/authorize?state=fresh`;

function response(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: vi.fn().mockResolvedValue(payload),
    text: vi.fn().mockResolvedValue(JSON.stringify(payload)),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

function routes(map: Record<string, Response>) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const found = map[key];
    if (!found) throw new Error(`unexpected ${key}`);
    return found;
  });
}

function renderPanel(onCancelled = vi.fn()) {
  render(
    <M365ConfirmTenantPanel apiBase={READ_BASE} orgId={ORG} canWrite onCancelled={onCancelled} testId="m365-read-confirm-tenant" />,
  );
  return onCancelled;
}

describe("M365ConfirmTenantPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.organizations = [{ id: ORG, name: "Northwind Traders" }];
    state.errorMessages = [];
  });

  it("shows the verified tenant, the signed-in admin and the org, with the MSP-tenant warning", async () => {
    routes({
      [`GET ${READ_BASE}/pending?orgId=${ORG}`]: response({
        tenantId: TENANT, administratorUsername: "tech@msp.example", expiresAt: "2026-10-03T12:10:00.000Z",
      }),
    });

    renderPanel();

    const panel = await screen.findByTestId("m365-read-confirm-tenant");
    await waitFor(() => expect(panel).toHaveTextContent(TENANT));
    expect(panel).toHaveTextContent("You signed in as tech@msp.example in Microsoft tenant");
    expect(panel).toHaveTextContent("Breeze will request access to THIS tenant for Northwind Traders.");
    expect(panel).toHaveTextContent(/If this is your own MSP tenant rather than the customer's, cancel and sign in with the customer's admin account/);
    expect(screen.getByRole("button", { name: "Continue to Microsoft consent" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel, wrong tenant" })).toBeEnabled();
    // Nothing on this screen lets the operator type a tenant.
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("without a username or org name it still names the tenant", async () => {
    state.organizations = [];
    routes({
      [`GET ${READ_BASE}/pending?orgId=${ORG}`]: response({
        tenantId: TENANT, administratorUsername: null, expiresAt: "2026-10-03T12:10:00.000Z",
      }),
    });

    renderPanel();

    const panel = await screen.findByTestId("m365-read-confirm-tenant");
    await waitFor(() => expect(panel).toHaveTextContent(`You signed in to Microsoft tenant ${TENANT}.`));
    expect(panel).toHaveTextContent("Breeze will request access to THIS tenant for this organization.");
  });

  it("continue goes through runAction and navigates to the server-built Microsoft URL", async () => {
    routes({
      [`GET ${READ_BASE}/pending?orgId=${ORG}`]: response({
        tenantId: TENANT, administratorUsername: "admin@customer.example", expiresAt: "2026-10-03T12:10:00.000Z",
      }),
      [`POST ${READ_BASE}/continue?orgId=${ORG}`]: response({ adminConsentUrl: CONSENT_URL }),
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Continue to Microsoft consent" }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith(CONSENT_URL));
    expect(runActionMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${READ_BASE}/continue?orgId=${ORG}`, { method: "POST" });
  });

  it("continue refuses a consent URL that is not Microsoft's", async () => {
    routes({
      [`GET ${READ_BASE}/pending?orgId=${ORG}`]: response({
        tenantId: TENANT, administratorUsername: null, expiresAt: "2026-10-03T12:10:00.000Z",
      }),
      [`POST ${READ_BASE}/continue?orgId=${ORG}`]: response({ adminConsentUrl: "https://evil.example/authorize" }),
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Continue to Microsoft consent" }));

    await waitFor(() => expect(state.errorMessages).toContain("Microsoft consent could not be started."));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("cancel goes through runAction, reports back, and never navigates", async () => {
    routes({
      [`GET ${READ_BASE}/pending?orgId=${ORG}`]: response({
        tenantId: TENANT, administratorUsername: null, expiresAt: "2026-10-03T12:10:00.000Z",
      }),
      [`POST ${READ_BASE}/cancel?orgId=${ORG}`]: response({ connection: {} }),
    });
    const onCancelled = renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Cancel, wrong tenant" }));

    await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
    expect(runActionMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${READ_BASE}/cancel?orgId=${ORG}`, { method: "POST" });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("an expired or already-used confirmation shows the restart copy and no actions", async () => {
    routes({ [`GET ${READ_BASE}/pending?orgId=${ORG}`]: response({ error: "Connection not found" }, 404) });

    renderPanel();

    expect(await screen.findByText("This confirmation expired or was already used. Start consent again.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue to Microsoft consent" })).not.toBeInTheDocument();
  });

  it("rejects a malformed pending payload instead of rendering it", async () => {
    routes({
      [`GET ${READ_BASE}/pending?orgId=${ORG}`]: response({
        tenantId: "not-a-guid", administratorUsername: null, expiresAt: "2026-10-03T12:10:00.000Z",
      }),
    });

    renderPanel();

    expect(await screen.findByText("This confirmation expired or was already used. Start consent again.")).toBeInTheDocument();
    expect(screen.queryByText("not-a-guid", { exact: false })).not.toBeInTheDocument();
  });
});

describe("M365ConsentSteps", () => {
  it("lists identity → confirm → consent → verify in order", () => {
    render(<M365ConsentSteps />);
    const items = screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(items).toHaveLength(4);
    expect(items[0]).toMatch(/Breeze verifies who you are and which tenant you belong to/);
    expect(items[1]).toMatch(/Confirm in Breeze that this is the customer's tenant/);
    expect(items[2]).toMatch(/Approve Breeze's permissions for that tenant/);
    expect(items[3]).toMatch(/Breeze checks its access to that tenant before connecting it/);
  });
});
