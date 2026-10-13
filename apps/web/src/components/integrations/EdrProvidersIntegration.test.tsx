import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let scope: "system" | "partner" | "organization" = "partner";
let canManagePartnerWide: boolean | undefined = true;
vi.mock("../../lib/authScope", () => ({
  getJwtClaims: () => ({ scope, orgId: null, partnerId: "partner-1" }),
  loginPathWithNext: () => "/login",
}));
vi.mock("../../stores/auth", () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: { user: { canManagePartnerWide?: boolean } }) => unknown) =>
    selector({ user: { canManagePartnerWide } }),
}));
vi.mock("../shared/Toast", () => ({ showToast: vi.fn() }));
vi.mock("../../stores/orgStore", () => ({
  useOrgStore: (selector: (s: { organizations: Array<{ id: string; name: string }> }) => unknown) =>
    selector({ organizations: [{ id: "org-1", name: "Acme" }] }),
}));

import EdrProvidersIntegration from "./EdrProvidersIntegration";
import { fetchWithAuth } from "../../stores/auth";
import { showToast } from "../shared/Toast";

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);
const res = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: "x", json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const fakeProvider = {
  key: "fakevendor",
  label: "Fake Vendor",
  credentialFields: [
    { name: "apiKey", label: "API key", secret: true, required: true },
    { name: "accountId", label: "Account ID", secret: false, required: true },
  ],
  baseUrlPolicy: { required: true, pathPrefix: "/api/v1" },
  capabilities: { defaultIntervals: { detectionsMinutes: 5, inventoryMinutes: 60 } },
};

const conn = (o: Record<string, unknown> = {}) => ({
  id: "c1", partnerId: "p1", provider: "bitdefender", name: "Main GravityZone", baseUrl: null, region: null,
  vendorRootId: "r1", vendorRootName: "Root Co", vendorRootType: null, isActive: true, status: "connected",
  detectionIntervalMinutes: null, inventoryIntervalMinutes: 30,
  effectiveDetectionIntervalMinutes: 5, effectiveInventoryIntervalMinutes: 30,
  lastInventorySyncAt: "2026-09-15T11:50:00.000Z", lastInventorySyncStatus: "success", lastInventorySyncError: null,
  lastDetectionSyncAt: null, lastDetectionSyncStatus: null, lastDetectionSyncError: null,
  lastSyncTenants: 3, lastSyncUnmappedTenants: 1, lastSyncFailedTenants: 0, lastSyncEndpoints: 40,
  lastSyncLinkedEndpoints: 30, lastSyncAmbiguousEndpoints: 2, lastSyncOpenDetections: 7,
  capabilitiesSnapshot: null, createdAt: "", updatedAt: "", hasCredentials: true, hasWebhookSecret: false, ...o,
});

let connections: unknown[] = [conn()];
let overrides: (url: string, method: string) => Response | undefined = () => undefined;

function route() {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    const o = overrides(url, method);
    if (o) return o;
    if (url === "/edr/connections" && method === "GET") return res({ data: connections });
    if (url === "/edr/providers") return res({ data: [fakeProvider] });
    if (url.endsWith("/tenants")) return res({ data: [], suggestions: [], summary: { tenants: 0, unmappedTenants: 0, unmappedEndpointCount: 0 } });
    if (url.startsWith("/edr/endpoints")) return res({ data: [] });
    return res({ success: true, data: {} });
  });
}
const calls = (method: string) =>
  fetchMock.mock.calls.filter(([, i]) => ((i as RequestInit | undefined)?.method ?? "GET") === method);

beforeEach(() => {
  vi.clearAllMocks();
  scope = "partner";
  canManagePartnerWide = true;
  connections = [conn()];
  overrides = () => undefined;
  route();
});
afterEach(() => vi.restoreAllMocks());

describe("EdrProvidersIntegration", () => {
  it("lists connections with the provider label and the per-stream cadence", async () => {
    render(<EdrProvidersIntegration />);
    expect(await screen.findByTestId("edr-connection-c1")).toBeInTheDocument();
    expect(screen.getByTestId("edr-connection-c1").textContent).toContain("Bitdefender GravityZone");
    expect(screen.getByTestId("edr-connection-inventory-c1").textContent).toContain("30");
    expect(screen.getByTestId("edr-connection-detections-c1").textContent).toContain("5");
  });

  it("shows the partner-only message and fetches nothing for an org-scoped user", async () => {
    scope = "organization";
    render(<EdrProvidersIntegration />);
    expect(await screen.findByTestId("edr-providers-org-scope")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the empty state when there are no connections", async () => {
    connections = [];
    render(<EdrProvidersIntegration />);
    expect(await screen.findByTestId("edr-providers-empty")).toBeInTheDocument();
  });

  it("surfaces a load failure instead of the empty state", async () => {
    overrides = (url) => (url === "/edr/connections" ? res({ error: "x" }, false, 500) : undefined);
    render(<EdrProvidersIntegration />);
    expect(await screen.findByTestId("edr-providers-error")).toBeInTheDocument();
    expect(screen.queryByTestId("edr-providers-empty")).toBeNull();
  });

  it("(a) builds the add form from the provider descriptor and POSTs the credentials blob", async () => {
    render(<EdrProvidersIntegration />);
    fireEvent.click(await screen.findByTestId("edr-providers-add"));
    await screen.findByTestId("edr-add-cred-apiKey");
    expect((screen.getByTestId("edr-add-cred-apiKey") as HTMLInputElement).type).toBe("password");
    expect((screen.getByTestId("edr-add-cred-accountId") as HTMLInputElement).type).toBe("text");
    expect(screen.getByTestId("edr-add-base-url")).toBeInTheDocument();
    expect(screen.getByTestId("edr-add-base-url-hint").textContent).toContain("/api/v1");

    fireEvent.change(screen.getByTestId("edr-add-name"), { target: { value: "Second" } });
    fireEvent.change(screen.getByTestId("edr-add-cred-apiKey"), { target: { value: "k" } });
    fireEvent.change(screen.getByTestId("edr-add-cred-accountId"), { target: { value: "acct" } });
    fireEvent.change(screen.getByTestId("edr-add-base-url"), { target: { value: "https://example.invalid" } });
    fireEvent.change(screen.getByTestId("edr-add-detection-interval"), { target: { value: "10" } });
    fireEvent.click(screen.getByTestId("edr-add-submit"));

    await waitFor(() => expect(calls("POST")).toHaveLength(1));
    const [url, init] = calls("POST")[0]!;
    expect(url).toBe("/edr/connections");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      provider: "fakevendor",
      name: "Second",
      baseUrl: "https://example.invalid",
      credentials: { apiKey: "k", accountId: "acct" },
      detectionIntervalMinutes: 10,
    });
  });

  it("(a) omits the Access URL input when the provider has no baseUrlPolicy", async () => {
    overrides = (url) =>
      url === "/edr/providers" ? res({ data: [{ ...fakeProvider, baseUrlPolicy: null }] }) : undefined;
    render(<EdrProvidersIntegration />);
    fireEvent.click(await screen.findByTestId("edr-providers-add"));
    await screen.findByTestId("edr-add-cred-apiKey");
    expect(screen.queryByTestId("edr-add-base-url")).toBeNull();
  });

  it("(a) keeps the form open when the vendor test fails the create (422)", async () => {
    overrides = (url, method) =>
      url === "/edr/connections" && method === "POST" ? res({ success: false, error: "Bad credentials" }, false, 422) : undefined;
    render(<EdrProvidersIntegration />);
    fireEvent.click(await screen.findByTestId("edr-providers-add"));
    await screen.findByTestId("edr-add-cred-apiKey");
    fireEvent.change(screen.getByTestId("edr-add-name"), { target: { value: "Second" } });
    fireEvent.change(screen.getByTestId("edr-add-cred-apiKey"), { target: { value: "k" } });
    fireEvent.change(screen.getByTestId("edr-add-cred-accountId"), { target: { value: "a" } });
    fireEvent.change(screen.getByTestId("edr-add-base-url"), { target: { value: "https://example.invalid" } });
    fireEvent.click(screen.getByTestId("edr-add-submit"));
    await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("edr-add-name")).toBeInTheDocument();
  });

  it("(b) shows the reauth banner and opens credential editing from it", async () => {
    connections = [conn({ status: "reauth_required", provider: "fakevendor" })];
    render(<EdrProvidersIntegration />);
    expect(await screen.findByTestId("edr-connection-reauth-banner")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("edr-connection-reauth"));
    expect(await screen.findByTestId("edr-connection-cred-apiKey")).toBeInTheDocument();
  });

  it("(c) hides every write control and shows one read-only notice without partner-wide access", async () => {
    canManagePartnerWide = false;
    render(<EdrProvidersIntegration />);
    expect(await screen.findByTestId("edr-providers-readonly")).toBeInTheDocument();
    expect(screen.getByTestId("edr-connection-c1")).toBeInTheDocument();
    for (const id of [
      "edr-providers-add",
      "edr-connection-test",
      "edr-connection-sync",
      "edr-connection-save",
      "edr-connection-delete",
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it("(e) a failed sync is toasted once by runAction and never twice", async () => {
    overrides = (url, method) =>
      url === "/edr/connections/c1/sync" && method === "POST" ? res({ error: "queue down" }, false, 500) : undefined;
    render(<EdrProvidersIntegration />);
    fireEvent.click(await screen.findByTestId("edr-connection-sync"));
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("(g) delete is two-step: 409 CONFIRM_COUNTS -> confirm -> repeat with the counts", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    overrides = (url, method) => {
      if (method !== "DELETE") return undefined;
      if (url === "/edr/connections/c1") {
        return res({ error: "confirm", code: "CONFIRM_COUNTS", detections: 7, endpoints: 40, tenants: 3 }, false, 409);
      }
      return res({ success: true });
    };
    render(<EdrProvidersIntegration />);
    fireEvent.click(await screen.findByTestId("edr-connection-delete"));
    await waitFor(() => expect(calls("DELETE")).toHaveLength(2));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0]![0])).toContain("40");
    expect(calls("DELETE")[1]![0]).toBe("/edr/connections/c1?confirm=7%3A40");
    // The first 409 is an expected step, not an error.
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("(g) declining the confirm sends no second DELETE", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    overrides = (url, method) =>
      method === "DELETE" ? res({ error: "confirm", code: "CONFIRM_COUNTS", detections: 1, endpoints: 2, tenants: 1 }, false, 409) : undefined;
    render(<EdrProvidersIntegration />);
    fireEvent.click(await screen.findByTestId("edr-connection-delete"));
    await waitFor(() => expect(calls("DELETE")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls("DELETE")).toHaveLength(1);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("opens the test-result modal after Test", async () => {
    overrides = (url, method) =>
      url === "/edr/connections/c1/test" && method === "POST"
        ? res({ success: true, rootName: "Root Co", tenantCount: 3 })
        : undefined;
    render(<EdrProvidersIntegration />);
    fireEvent.click(await screen.findByTestId("edr-connection-test"));
    expect(await screen.findByTestId("edr-test-modal")).toBeInTheDocument();
  });

  it("Save sends no credentials unless the user entered them", async () => {
    render(<EdrProvidersIntegration />);
    fireEvent.change(await screen.findByTestId("edr-connection-name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByTestId("edr-connection-save"));
    await waitFor(() => expect(calls("PATCH")).toHaveLength(1));
    const body = JSON.parse((calls("PATCH")[0]![1] as RequestInit).body as string);
    expect(body.name).toBe("Renamed");
    expect(body).not.toHaveProperty("credentials");
  });

  it("shows the reauth hint in the test modal when the test result carries reauth", async () => {
    overrides = (url, method) =>
      url === "/edr/connections/c1/test" && method === "POST"
        ? res({ success: false, error: "bad key", reauth: true })
        : undefined;
    render(<EdrProvidersIntegration />);
    fireEvent.click(await screen.findByTestId("edr-connection-test"));
    const modal = await screen.findByTestId("edr-test-modal");
    expect(within(modal).getByTestId("edr-test-reauth-hint")).toBeInTheDocument();
  });

  it("is fully read-only without canManagePartnerWide, even when reauth is required", async () => {
    canManagePartnerWide = false;
    connections = [conn({ status: "reauth_required" })];
    overrides = (url) => {
      if (url.endsWith("/tenants"))
        return res({
          data: [{
            id: "ten-1", connectionId: "c1", vendorTenantId: "v1", vendorTenantName: "Acme North", orgId: null, orgName: null,
            mappingSource: null, endpointCount: 1, openDetectionCount: 0, lastSeenAt: null, vendorMissingSince: null, lastDetectionSyncAt: null,
          }],
          suggestions: [{ tenantId: "ten-1", orgId: "org-1" }],
          summary: { tenants: 1, unmappedTenants: 1, unmappedEndpointCount: 1 },
        });
      if (url.startsWith("/edr/endpoints"))
        return res({ data: [{
          id: "ep-1", orgId: "org-1", connectionId: "c1", tenantId: "ten-1", tenantName: "Acme North", provider: "bitdefender",
          vendorEndpointId: "ve1", hostname: "ws-01", osName: "Windows 11", health: "healthy", lastSeenAt: null, breezeDeviceId: null,
        }] });
      return undefined;
    };
    render(<EdrProvidersIntegration />);
    expect(await screen.findByTestId("edr-connection-reauth-banner")).toBeInTheDocument();
    await screen.findByTestId("edr-tenant-row-ten-1");
    await screen.findByTestId("edr-endpoint-row-ep-1");
    expect(screen.queryByTestId("edr-connection-reauth")).toBeNull();
    expect(screen.queryByTestId("edr-connection-edit-credentials")).toBeNull();
    expect(screen.queryByTestId("edr-connection-cred-apiKey")).toBeNull();
    expect(screen.queryByTestId("edr-connection-save")).toBeNull();
    expect(screen.queryByTestId("edr-tenant-select-ten-1")).toBeNull();
    expect(screen.queryByTestId("edr-tenant-apply-ten-1")).toBeNull();
    expect(screen.queryByTestId("edr-endpoint-device-ep-1")).toBeNull();
    expect(screen.queryByTestId("edr-endpoint-link-ep-1")).toBeNull();
  });
});
