import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let scope: "system" | "partner" | "organization" = "partner";
vi.mock("../../lib/authScope", () => ({
  getJwtClaims: () => ({ scope, orgId: null, partnerId: "partner-1" }),
  loginPathWithNext: () => "/login",
}));
vi.mock("../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));
vi.mock("../shared/Toast", () => ({ showToast: vi.fn() }));
vi.mock("../../stores/orgStore", () => ({
  useOrgStore: (selector: (s: { organizations: Array<{ id: string; name: string }> }) => unknown) =>
    selector({ organizations: [{ id: "org-1", name: "Acme" }] }),
}));

import BackupProvidersIntegration from "./BackupProvidersIntegration";
import { fetchWithAuth } from "../../stores/auth";
import { showToast } from "../shared/Toast";

const fetchMock = vi.mocked(fetchWithAuth);
const res = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: "OK", json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const conn = {
  id: "conn-1", provider: "cove", name: "OliveTech Cove", baseUrl: "https://api.backup.management/jsonapi",
  vendorRootName: "OliveTech", isActive: true, status: "connected", syncIntervalMinutes: 30,
  showProviderNameInPortal: false, lastSyncAt: "2026-09-15T11:50:00.000Z", lastSyncStatus: "success",
  lastSyncError: null, lastSyncCustomers: 3, lastSyncUnmappedCustomers: 1, lastSyncDevices: 40,
  lastSyncUnmappedDevices: 5, lastSyncLinkedDevices: 30, lastSyncAmbiguousDevices: 0, hasCredentials: true,
};

function routeFetch(connections: unknown[] = [conn], customers: unknown[] = []) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (url === "/backup/providers/connections" && method === "GET") return res({ data: connections });
    if (url.endsWith("/customers")) return res({ data: customers });
    return res({ success: true });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  scope = "partner";
  routeFetch();
});

describe("BackupProvidersIntegration", () => {
  it("lists the partner's connections", async () => {
    render(<BackupProvidersIntegration />);
    expect(await screen.findByTestId("backup-connection-conn-1")).toBeInTheDocument();
  });

  it("shows the partner-only message and queries nothing for an org-scope user", async () => {
    scope = "organization";
    render(<BackupProvidersIntegration />);
    expect(await screen.findByTestId("backup-providers-org-scope")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the empty state when no provider is connected", async () => {
    routeFetch([]);
    render(<BackupProvidersIntegration />);
    expect(await screen.findByTestId("backup-providers-empty")).toBeInTheDocument();
  });

  it("uses a generic connection-name placeholder, not a real MSP name (sweep F7)", async () => {
    render(<BackupProvidersIntegration />);
    await screen.findByTestId("backup-connection-conn-1");
    fireEvent.click(screen.getByTestId("backup-providers-add"));
    expect(screen.getByTestId("backup-add-name")).not.toHaveAttribute("placeholder", "OliveTech Cove");
  });

  it("POSTs a new connection with the credentials blob and refetches", async () => {
    render(<BackupProvidersIntegration />);
    await screen.findByTestId("backup-connection-conn-1");

    fireEvent.click(screen.getByTestId("backup-providers-add"));
    fireEvent.change(screen.getByTestId("backup-add-name"), { target: { value: "Second Cove" } });
    fireEvent.change(screen.getByTestId("backup-add-partner-name"), { target: { value: "OliveTech" } });
    fireEvent.change(screen.getByTestId("backup-add-username"), { target: { value: "breeze-ro" } });
    fireEvent.change(screen.getByTestId("backup-add-password"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByTestId("backup-add-submit"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/backup/providers/connections",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const body = JSON.parse(
      (fetchMock.mock.calls.find(([u, i]) => u === "/backup/providers/connections" && (i as RequestInit)?.method === "POST")![1] as RequestInit).body as string,
    );
    expect(body).toEqual({
      provider: "cove",
      name: "Second Cove",
      showProviderNameInPortal: false,
      credentials: { partnerName: "OliveTech", username: "breeze-ro", password: "s3cret" },
    });
  });

  it("toggles the password field between masked and plain", async () => {
    render(<BackupProvidersIntegration />);
    fireEvent.click(await screen.findByTestId("backup-providers-add"));
    const field = screen.getByTestId("backup-add-password") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.click(screen.getByTestId("backup-add-password-toggle"));
    expect((screen.getByTestId("backup-add-password") as HTMLInputElement).type).toBe("text");
  });

  it("D12: never lets the browser autofill the Cove username/password with the Breeze login", async () => {
    render(<BackupProvidersIntegration />);
    fireEvent.click(await screen.findByTestId("backup-providers-add"));
    expect(screen.getByTestId("backup-add-username")).toHaveAttribute("autoComplete", "off");
    expect(screen.getByTestId("backup-add-password")).toHaveAttribute("autoComplete", "new-password");
  });

  it("#9932: credential labels use the same terms as the help text (API user login name / token)", async () => {
    render(<BackupProvidersIntegration />);
    fireEvent.click(await screen.findByTestId("backup-providers-add"));
    expect(screen.getByText("API user login name")).toBeInTheDocument();
    expect(screen.getByText("API user token")).toBeInTheDocument();
    expect(screen.queryByText("Username")).toBeNull();
    expect(screen.queryByText("Password")).toBeNull();
    expect(screen.getByTestId("backup-add-password-toggle")).toHaveAttribute("aria-label", "Show token");
    const help = screen.getByTestId("backup-add-help").textContent ?? "";
    expect(help).toContain("login name");
    expect(help).toContain("token");
    expect(help).not.toMatch(/as the (username|password)/);
  });

  it("shows the dedicated-user help text on the add form", async () => {
    render(<BackupProvidersIntegration />);
    fireEvent.click(await screen.findByTestId("backup-providers-add"));
    expect(screen.getByTestId("backup-add-help").textContent).toContain("API user");
  });

  it("opens the test-result modal when a card reports a result", async () => {
    render(<BackupProvidersIntegration />);
    fireEvent.click(await screen.findByTestId("backup-connection-test"));
    expect(await screen.findByTestId("backup-test-modal")).toBeInTheDocument();
  });

  it("loads the customer mapping grid for each connection", async () => {
    routeFetch([conn], [
      { id: "cust-1", vendorCustomerId: "9001", vendorCustomerName: "Acme North", vendorLevel: "EndCustomer", vendorExternalCode: null, orgId: null, mappingSource: null, deviceCount: 12, unmappedDeviceCount: 12, lastSeenAt: null },
    ]);
    render(<BackupProvidersIntegration />);
    expect(await screen.findByTestId("backup-mapping-row-cust-1")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/backup/providers/connections/conn-1/customers");
  });

  it("surfaces a load failure instead of rendering an empty, all-clear list", async () => {
    fetchMock.mockResolvedValue(res({ error: "nope" }, false, 500));
    render(<BackupProvidersIntegration />);
    expect(await screen.findByTestId("backup-providers-error")).toBeInTheDocument();
    expect(screen.queryByTestId("backup-providers-empty")).toBeNull();
  });

  it("surfaces a load failure when a per-connection customer fetch fails, instead of a silently-empty mapping grid", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      if (url === "/backup/providers/connections" && method === "GET") return res({ data: [conn] });
      if (url.endsWith("/customers")) return res({ error: "boom" }, false, 500);
      return res({ success: true });
    });
    render(<BackupProvidersIntegration />);
    expect(await screen.findByTestId("backup-providers-error")).toBeInTheDocument();
    // The connection itself still renders (it loaded fine) — only the mapping
    // grid data is missing — but it must never look like "nothing to map".
    expect(screen.queryByTestId("backup-mapping-row-cust-1")).toBeNull();
  });
});

describe("Dropsuite connections", () => {
  async function openForm() {
    render(<BackupProvidersIntegration />);
    await screen.findByTestId("backup-connection-conn-1");
    fireEvent.click(screen.getByTestId("backup-providers-add"));
    expect(screen.getByTestId("backup-add-provider")).not.toBeDisabled();
    fireEvent.change(screen.getByTestId("backup-add-provider"), { target: { value: "dropsuite" } });
  }

  function fillForm() {
    for (const [field, value] of Object.entries({ name: "SaaS backup", "reseller-token": "reseller-secret", "auth-token": "auth-secret", "base-url": "https://dropsuite.us/api/" })) {
      fireEvent.change(screen.getByTestId(`backup-add-${field}`), { target: { value } });
    }
  }

  it("uses a provider-specific connection-name placeholder", async () => {
    await openForm();
    expect(screen.getByTestId("backup-add-name")).toHaveAttribute("placeholder", "Main NinjaOne SaaS Backup account");
    fireEvent.change(screen.getByTestId("backup-add-provider"), { target: { value: "cove" } });
    expect(screen.getByTestId("backup-add-name")).toHaveAttribute("placeholder", "Main Cove account");
  });

  it("shows masked tokens and requires both tokens and the API URL", async () => {
    await openForm();
    expect(screen.queryByTestId("backup-add-password")).toBeNull();
    expect(screen.getByTestId("backup-add-reseller-token")).toHaveAttribute("type", "password");
    expect(screen.getByTestId("backup-add-auth-token")).toHaveAttribute("type", "password");
    expect(screen.getByTestId("backup-add-base-url")).toBeRequired();
    expect(screen.getByTestId("backup-add-base-url")).toHaveAttribute("placeholder", "https://dropsuite.us/api/");
    expect(screen.getByTestId("backup-add-help")).toHaveTextContent(/read-only reseller access/i);
    expect(screen.getByTestId("backup-add-help")).toHaveTextContent("encrypted");
    fillForm();
    expect(screen.getByTestId("backup-add-submit")).not.toBeDisabled();
    for (const field of ["reseller-token", "auth-token", "base-url"]) {
      fireEvent.change(screen.getByTestId(`backup-add-${field}`), { target: { value: " " } });
      expect(screen.getByTestId("backup-add-submit")).toBeDisabled();
      fillForm();
    }
    fireEvent.change(screen.getByTestId("backup-add-provider"), { target: { value: "cove" } });
    expect(screen.getByTestId("backup-add-password")).toBeInTheDocument();
    expect(screen.queryByTestId("backup-add-auth-token")).toBeNull();
    expect(screen.getByTestId("backup-add-submit")).toBeDisabled();
  });

  it("POSTs only Dropsuite credentials with the base URL and portal preference", async () => {
    await openForm();
    fillForm();
    fireEvent.click(screen.getByTestId("backup-add-portal-toggle"));
    fireEvent.click(screen.getByTestId("backup-add-submit"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/backup/providers/connections", expect.objectContaining({ method: "POST" })));
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ provider: "dropsuite", name: "SaaS backup", baseUrl: "https://dropsuite.us/api/", credentials: { resellerToken: "reseller-secret", authToken: "auth-secret" }, showProviderNameInPortal: true });
  });

  it.each([400, 422])("surfaces a %s API validation error and keeps entered values", async (status) => {
    await openForm();
    fillForm();
    fetchMock.mockResolvedValueOnce(res({ error: "API URL is not supported" }, false, status));
    fireEvent.click(screen.getByTestId("backup-add-submit"));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: "API URL is not supported" })));
    expect(screen.getByTestId("backup-add-auth-token")).toHaveValue("auth-secret");
  });

  it("passes the provider to customer mapping", async () => {
    routeFetch([{ ...conn, provider: "dropsuite" }], [{ id: "cust-1", vendorCustomerName: "Acme", deviceCount: 2 }]);
    render(<BackupProvidersIntegration />);
    expect(await screen.findByTestId("backup-mapping-count-heading")).toHaveTextContent("Workloads");
  });
});

it("shows Dropsuite guidance in a failed connection-test modal", async () => {
  routeFetch([{ ...conn, provider: "dropsuite" }]);
  render(<BackupProvidersIntegration />);
  await screen.findByTestId("backup-connection-test");
  fetchMock.mockResolvedValueOnce(res({ success: false, error: "Tokens rejected" }));
  fireEvent.click(screen.getByTestId("backup-connection-test"));
  expect(await screen.findByTestId("backup-test-modal")).not.toHaveTextContent("Cove API user");
});
