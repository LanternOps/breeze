import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import M365ActionsStaleManifestTable from "./M365ActionsStaleManifestTable";
import { fetchWithAuth } from "../../stores/auth";

const state = vi.hoisted(() => ({
  selectOrganization: vi.fn(),
  toasts: [] as unknown[],
}));

vi.mock("../../stores/auth", () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock("../../stores/orgStore", () => ({
  useOrgStore: vi.fn((selector: (value: { selectOrganization: (id: string) => void }) => unknown) =>
    selector({ selectOrganization: state.selectOrganization }),
  ),
}));

vi.mock("../shared/Toast", () => ({
  showToast: vi.fn((toast: unknown) => { state.toasts.push(toast); }),
}));

vi.mock("@/lib/dateTimeFormat", () => ({
  formatDateTime: vi.fn((value: string) => `formatted ${value}`),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const TENANT_A = "33333333-3333-4333-8333-333333333333";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    orgId: ORG_A,
    orgName: "Acme Corp",
    displayName: "Acme Tenant",
    tenantId: TENANT_A,
    manifestVersion: 2,
    currentManifestVersion: 3,
    status: "active",
    lastVerifiedAt: "2026-07-14T18:01:00.000Z",
    ...overrides,
  };
}

function response(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: vi.fn().mockResolvedValue(payload),
    text: vi.fn().mockResolvedValue(JSON.stringify(payload)),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

describe("M365ActionsStaleManifestTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.toasts = [];
    window.history.replaceState({}, "", "/integrations#m365");
  });

  it("fetches the partner stale-manifest endpoint with no query string", async () => {
    fetchWithAuthMock.mockResolvedValue(response({ currentManifestVersion: 3, connections: [row()] }));

    render(<M365ActionsStaleManifestTable />);

    await screen.findByTestId("m365-stale-manifest-table");
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      "/m365/customer-graph-actions/connections/stale-manifest",
    );
  });

  it("shows the loading skeleton and then the table", async () => {
    let resolve!: (value: Response) => void;
    fetchWithAuthMock.mockReturnValue(new Promise<Response>((r) => { resolve = r; }));

    render(<M365ActionsStaleManifestTable />);

    expect(screen.getByTestId("m365-stale-manifest-loading")).toBeInTheDocument();
    resolve(response({ currentManifestVersion: 3, connections: [row()] }));
    expect(await screen.findByTestId("m365-stale-manifest-table")).toBeInTheDocument();
    expect(screen.queryByTestId("m365-stale-manifest-loading")).not.toBeInTheDocument();
  });

  it("renders one row per connection with org, tenant and manifest version", async () => {
    fetchWithAuthMock.mockResolvedValue(response({
      currentManifestVersion: 3,
      connections: [
        row(),
        row({ id: "55555555-5555-4555-8555-555555555555", orgId: ORG_B, orgName: "Beta LLC", displayName: null, tenantId: null, lastVerifiedAt: null }),
      ],
    }));

    render(<M365ActionsStaleManifestTable />);

    const rows = await screen.findAllByTestId("m365-stale-connection-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Acme Corp");
    expect(rows[0]).toHaveTextContent("Acme Tenant");
    expect(rows[0]).toHaveTextContent("Manifest version 2");
    expect(rows[0]).toHaveTextContent("formatted 2026-07-14T18:01:00.000Z");
    expect(rows[1]).toHaveTextContent("Beta LLC");
    expect(screen.getByRole("heading", { name: "Organizations needing Microsoft 365 re-consent" })).toBeInTheDocument();
  });

  it("renders nothing at all when nothing is stale", async () => {
    fetchWithAuthMock.mockResolvedValue(response({ currentManifestVersion: 3, connections: [] }));

    const { container } = render(<M365ActionsStaleManifestTable />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("m365-stale-manifest-loading")).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing and shows no toast on a 403 (organization-scoped session)", async () => {
    fetchWithAuthMock.mockResolvedValue(response({ error: "This view is available to partner-scoped sessions." }, 403));

    const { container } = render(<M365ActionsStaleManifestTable />);

    await waitFor(() => expect(screen.queryByTestId("m365-stale-manifest-loading")).not.toBeInTheDocument());
    expect(container).toBeEmptyDOMElement();
    expect(state.toasts).toHaveLength(0);
  });

  it("renders an alert region on a 500", async () => {
    fetchWithAuthMock.mockResolvedValue(response({ error: "boom" }, 500));

    render(<M365ActionsStaleManifestTable />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The re-consent list could not be loaded.");
    expect(screen.queryByTestId("m365-stale-manifest-table")).not.toBeInTheDocument();
  });

  it("treats a malformed body as a load failure instead of trusting it", async () => {
    fetchWithAuthMock.mockResolvedValue(response({
      currentManifestVersion: 3,
      connections: [{ ...row(), observedGrants: [] }],
    }));

    render(<M365ActionsStaleManifestTable />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("m365-stale-connection-row")).not.toBeInTheDocument();
  });

  it("selecting a row opens the organization and writes the URL hash, never a query param", async () => {
    fetchWithAuthMock.mockResolvedValue(response({ currentManifestVersion: 3, connections: [row()] }));

    render(<M365ActionsStaleManifestTable />);
    fireEvent.click(await screen.findByTestId("m365-stale-connection-row"));

    expect(window.location.hash).toBe(`#m365-reconsent-${ORG_A}`);
    expect(window.location.search).toBe("");
    expect(state.selectOrganization).toHaveBeenCalledWith(ORG_A);
    expect(screen.getByTestId("m365-stale-connection-row")).toHaveAttribute("aria-current", "true");
  });
});
