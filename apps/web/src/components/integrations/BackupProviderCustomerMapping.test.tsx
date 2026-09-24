import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BackupProviderCustomerMapping, { type BackupProviderCustomer } from "./BackupProviderCustomerMapping";
import { fetchWithAuth } from "../../stores/auth";
import { showToast } from "../shared/Toast";

vi.mock("../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));
vi.mock("../shared/Toast", () => ({ showToast: vi.fn() }));
vi.mock("../../stores/orgStore", () => ({
  useOrgStore: (selector: (s: { organizations: Array<{ id: string; name: string }> }) => unknown) =>
    selector({ organizations: [{ id: "org-1", name: "Acme" }, { id: "org-2", name: "Globex" }] }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);
const res = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, statusText: "OK", json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const customer = (o: Partial<BackupProviderCustomer> = {}): BackupProviderCustomer => ({
  id: "cust-1", vendorCustomerId: "9001", vendorCustomerName: "Acme North", vendorLevel: "EndCustomer",
  vendorExternalCode: null, orgId: null, mappingSource: null, deviceCount: 12, unmappedDeviceCount: 12,
  lastSeenAt: "2026-09-15T11:50:00.000Z", ...o,
});

const onChanged = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(res({ success: true }));
});

describe("BackupProviderCustomerMapping", () => {
  it("PUTs the chosen org for an unmapped customer", async () => {
    render(<BackupProviderCustomerMapping connectionId="conn-1" customers={[customer()]} onChanged={onChanged} />);
    fireEvent.change(screen.getByTestId("backup-mapping-select-cust-1"), { target: { value: "org-2" } });

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("/backup/providers/customers/cust-1/mapping");
    expect((init as RequestInit).method).toBe("PUT");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ orgId: "org-2" });
  });

  it("sends orgId:null for the explicit Unmapped (kept) choice", async () => {
    render(<BackupProviderCustomerMapping connectionId="conn-1" customers={[customer({ orgId: "org-1", mappingSource: "manual" })]} onChanged={onChanged} />);
    fireEvent.change(screen.getByTestId("backup-mapping-select-cust-1"), { target: { value: "__unmapped__" } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string)).toEqual({ orgId: null });
  });

  it("does nothing when the inert placeholder is re-selected", async () => {
    render(<BackupProviderCustomerMapping connectionId="conn-1" customers={[customer()]} onChanged={onChanged} />);
    fireEvent.change(screen.getByTestId("backup-mapping-select-cust-1"), { target: { value: "" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("toasts and does not call onChanged when the mapping PUT fails", async () => {
    fetchMock.mockResolvedValue(res({ error: "org not found" }, false));
    render(<BackupProviderCustomerMapping connectionId="conn-1" customers={[customer()]} onChanged={onChanged} />);
    fireEvent.change(screen.getByTestId("backup-mapping-select-cust-1"), { target: { value: "org-2" } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it.each([["auto_name"], ["auto_external_code"]])("shows the Auto badge for %s mappings", (mappingSource) => {
    render(
      <BackupProviderCustomerMapping
        connectionId="conn-1"
        customers={[customer({ orgId: "org-1", mappingSource: mappingSource as BackupProviderCustomer["mappingSource"] })]}
        onChanged={onChanged}
      />,
    );
    expect(screen.getByTestId("backup-mapping-auto-cust-1")).toBeInTheDocument();
  });

  it("does not show the Auto badge for a manual mapping", () => {
    render(<BackupProviderCustomerMapping connectionId="conn-1" customers={[customer({ orgId: "org-1", mappingSource: "manual" })]} onChanged={onChanged} />);
    expect(screen.queryByTestId("backup-mapping-auto-cust-1")).toBeNull();
  });

  it("selects Unmapped (kept) for a manual_unmapped customer, not the placeholder", () => {
    render(<BackupProviderCustomerMapping connectionId="conn-1" customers={[customer({ mappingSource: "manual_unmapped" })]} onChanged={onChanged} />);
    expect((screen.getByTestId("backup-mapping-select-cust-1") as HTMLSelectElement).value).toBe("__unmapped__");
  });

  it("summarises the unmapped customers and their devices", () => {
    render(
      <BackupProviderCustomerMapping
        connectionId="conn-1"
        customers={[
          customer({ id: "cust-1", unmappedDeviceCount: 12 }),
          customer({ id: "cust-2", unmappedDeviceCount: 6 }),
          customer({ id: "cust-3", orgId: "org-1", mappingSource: "manual", unmappedDeviceCount: 0 }),
        ]}
        onChanged={onChanged}
      />,
    );
    const summary = screen.getByTestId("backup-mapping-summary").textContent ?? "";
    expect(summary).toContain("2");
    expect(summary).toContain("18");
  });

  it("renders an empty state when nothing has been discovered", () => {
    render(<BackupProviderCustomerMapping connectionId="conn-1" customers={[]} onChanged={onChanged} />);
    expect(screen.getByTestId("backup-mapping-empty")).toBeInTheDocument();
  });

  it("shows the device count per row", () => {
    render(<BackupProviderCustomerMapping connectionId="conn-1" customers={[customer()]} onChanged={onChanged} />);
    const row = screen.getByTestId("backup-mapping-row-cust-1");
    expect(within(row).getByTestId("backup-mapping-devices-cust-1").textContent).toContain("12");
  });
});
