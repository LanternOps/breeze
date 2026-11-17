import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MonitoringIntegration from "./MonitoringIntegration";
import { fetchWithAuth } from "../../stores/auth";

// Two-layer context model: the header org picker (currentOrgId, null = All
// orgs) states the working context; page ACCESS is a token capability read
// from the JWT claims. Monitoring settings are per-org data, so for partner
// admins the selected org only decides which org's settings load.
let mockOrgState: {
  currentOrgId: string | null;
  allOrgs: boolean;
  error: string | null;
  organizationsLoaded: boolean;
  organizations: Array<{ id: string; name: string }>;
};
let mockClaims: {
  scope: "system" | "partner" | "organization" | null;
  orgId: string | null;
  partnerId: string | null;
};

vi.mock("../../stores/auth", () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock("../../stores/orgStore", () => ({
  useOrgStore: Object.assign(
    (selector?: (s: typeof mockOrgState) => unknown) =>
      selector ? selector(mockOrgState) : mockOrgState,
    { getState: () => mockOrgState },
  ),
}));

vi.mock("../../lib/authScope", () => ({
  getJwtClaims: () => mockClaims,
}));

const showToastMock = vi.hoisted(() => vi.fn());
vi.mock("../shared/Toast", () => ({
  showToast: (...args: unknown[]) => showToastMock(...args),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const monitoringResponse = (): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }) as unknown as Response;

beforeEach(() => {
  mockOrgState = {
    currentOrgId: "org-1",
    allOrgs: false,
    error: null,
    organizationsLoaded: true,
    organizations: [{ id: "org-1", name: "Acme" }],
  };
  mockClaims = { scope: "partner", orgId: null, partnerId: "partner-1" };
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue(monitoringResponse());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MonitoringIntegration — token-capability gate (partner admin)", () => {
  it("keeps the full config UI for a partner admin with an org selected", async () => {
    mockOrgState.currentOrgId = "org-1";
    render(<MonitoringIntegration />);

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        "/integrations/monitoring",
      ),
    );
    // Config sections render; the pick-an-org prompt does not.
    expect(await screen.findByText("Prometheus")).toBeInTheDocument();
    expect(screen.getByText("Grafana")).toBeInTheDocument();
    expect(
      screen.queryByText(/configured per organization/i),
    ).not.toBeInTheDocument();
  });

  it("shows the pick-an-org note and fires no doomed request in explicit fleet view", async () => {
    // Explicit All-orgs (fleet) is the resolved no-single-org state — the note
    // shows here, not during the transient pre-hydration null.
    mockOrgState.currentOrgId = null;
    mockOrgState.allOrgs = true;
    render(<MonitoringIntegration />);

    expect(
      screen.getByText(/configured per organization/i),
    ).toBeInTheDocument();

    // Per-org data with no target org: never fire the call that would 400.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it("holds (no note, no doomed request) during the transient null, then fetches once an org is selected", async () => {
    // Pre-hydration: no org, no explicit fleet intent → neither the note nor a
    // doomed org-less GET; just wait.
    mockOrgState.currentOrgId = null;
    mockOrgState.allOrgs = false;
    mockOrgState.organizationsLoaded = false;
    const { rerender } = render(<MonitoringIntegration />);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/configured per organization/i),
    ).not.toBeInTheDocument();

    mockOrgState.currentOrgId = "org-1";
    mockOrgState.organizationsLoaded = true;
    rerender(<MonitoringIntegration />);

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        "/integrations/monitoring",
      ),
    );
  });

  it("shows the org-load-failed retry card (not an endless spinner) when the org context fails to load", async () => {
    // Partner admin, no org, no fleet intent, and the org list fetch errored:
    // holding the loading frame forever hides the failure — surface the shared
    // retry card instead, and still never fire the org-less GET.
    mockOrgState.currentOrgId = null;
    mockOrgState.allOrgs = false;
    mockOrgState.organizationsLoaded = false;
    mockOrgState.organizations = [];
    mockOrgState.error = "Failed to load organizations";
    render(<MonitoringIntegration />);

    expect(screen.getByTestId("org-load-failed-state")).toBeInTheDocument();
    expect(screen.getByText("Failed to load organizations")).toBeInTheDocument();
    expect(
      screen.queryByText(/configured per organization/i),
    ).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it("adds a collision-free webhook id beside an existing masked endpoint", async () => {
    fetchWithAuthMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          webhooks: {
            enabled: true,
            endpoints: [
              { id: "wh-1", name: "Existing", url: "********", enabled: true },
            ],
          },
        },
      }),
    } as Response);
    render(<MonitoringIntegration />);

    await screen.findByDisplayValue("Existing");
    fireEvent.change(
      screen.getByPlaceholderText("https://hooks.monitoring.io/breeze"),
      { target: { value: "https://hooks.example.test/new" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /add endpoint/i }));
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    const [, saveOptions] = fetchWithAuthMock.mock.calls[1] ?? [];
    const saved = JSON.parse(String(saveOptions?.body));
    expect(saved.webhooks.endpoints).toHaveLength(2);
    expect(saved.webhooks.endpoints[0]).toMatchObject({ id: "wh-1", url: "********" });
    expect(saved.webhooks.endpoints[1].id).toEqual(expect.any(String));
    expect(saved.webhooks.endpoints[1].id).not.toBe("wh-1");
  });
});

describe("MonitoringIntegration — org-scope users are never gated by header context", () => {
  beforeEach(() => {
    mockClaims = { scope: "organization", orgId: "org-1", partnerId: null };
  });

  it("loads even while currentOrgId is the transient pre-hydration null", async () => {
    // The org store hydrates after mount; the token already identifies the
    // org and the API resolves it server-side, so the fetch must fire.
    mockOrgState.currentOrgId = null;
    render(<MonitoringIntegration />);

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        "/integrations/monitoring",
      ),
    );
    expect(
      screen.queryByText(/configured per organization/i),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("Prometheus")).toBeInTheDocument();
  });

  it("loads normally with the org store hydrated", async () => {
    mockOrgState.currentOrgId = "org-1";
    render(<MonitoringIntegration />);

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        "/integrations/monitoring",
      ),
    );
    expect(
      screen.queryByText(/configured per organization/i),
    ).not.toBeInTheDocument();
  });
});

// #12102: test actions are throttled per user and per org on the API.
describe("MonitoringIntegration — connection test outcome", () => {
  const testResponse = (payload: unknown, status: number): Response =>
    ({
      ok: status < 300,
      status,
      json: async () => payload,
    }) as unknown as Response;

  async function clickPrometheusTest(response: Response) {
    fetchWithAuthMock.mockImplementation(async (url) =>
      url === "/integrations/monitoring/test" ? response : monitoringResponse(),
    );
    render(<MonitoringIntegration />);
    const buttons = await screen.findAllByRole("button", { name: /Test connection/ });
    fireEvent.click(buttons[0]!);
    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        "/integrations/monitoring/test",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  }

  it("toasts and shows the rate-limit message when the test is throttled", async () => {
    await clickPrometheusTest(
      testResponse(
        { success: false, code: "RATE_LIMITED", error: "Too many test requests. Try again in 42 seconds." },
        429,
      ),
    );

    await waitFor(() => expect(showToastMock).toHaveBeenCalledTimes(1));
    const toast = showToastMock.mock.calls[0]![0] as { type: string; message: string };
    expect(toast.type).toBe("error");
    expect(toast.message).toMatch(/too many requests/i);
    expect(await screen.findByText(toast.message)).toBeInTheDocument();
  });

  it("shows a failed test beside the button without a toast", async () => {
    await clickPrometheusTest(
      testResponse({ success: false, error: "Prometheus rejected the request (HTTP 401)" }, 502),
    );

    expect(
      await screen.findByText("Prometheus rejected the request (HTTP 401)"),
    ).toBeInTheDocument();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("returns to idle without a message when the session expired", async () => {
    await clickPrometheusTest(testResponse({ error: "Unauthorized" }, 401));

    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Test connection/ })[0]).toBeEnabled(),
    );
    expect(screen.queryByText("Unauthorized")).not.toBeInTheDocument();
    expect(showToastMock).not.toHaveBeenCalled();
  });
});
