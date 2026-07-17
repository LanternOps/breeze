import { render, screen, waitFor } from "@testing-library/react";
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
