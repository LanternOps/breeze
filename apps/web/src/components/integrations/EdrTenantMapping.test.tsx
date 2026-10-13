import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));
vi.mock("../shared/Toast", () => ({ showToast: vi.fn() }));

import EdrTenantMapping from "./EdrTenantMapping";
import { fetchWithAuth } from "../../stores/auth";
import { showToast } from "../shared/Toast";

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);
const res = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: "x", json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const orgs = [
  { id: "org-1", name: "Acme" },
  { id: "org-2", name: "Globex" },
];
const tenant = (o: Record<string, unknown> = {}) => ({
  id: "ten-1", connectionId: "conn-1", vendorTenantId: "v1", vendorTenantName: "Acme North",
  orgId: null, orgName: null, mappingSource: null, endpointCount: 12, openDetectionCount: 3,
  lastSeenAt: null, vendorMissingSince: null, lastDetectionSyncAt: "2026-09-15T11:50:00.000Z", ...o,
});

function route(rows: unknown[], suggestions: unknown[] = []) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (method === "GET" && url === "/edr/connections/conn-1/tenants") {
      return res({ data: rows, suggestions, summary: { tenants: rows.length, unmappedTenants: 1, unmappedEndpointCount: 12 } });
    }
    return res({ data: {} });
  });
}
const puts = () => fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "PUT");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EdrTenantMapping", () => {
  it("shows a suggestion badge and does NOT map until Apply is clicked", async () => {
    route([tenant()], [{ tenantId: "ten-1", orgId: "org-2" }]);
    const onChanged = vi.fn();
    render(<EdrTenantMapping connectionId="conn-1" orgs={orgs} canManage onChanged={onChanged} />);
    const badge = await screen.findByTestId("edr-tenant-suggestion-ten-1");
    expect(badge.textContent).toContain("Globex");
    expect((screen.getByTestId("edr-tenant-select-ten-1") as HTMLSelectElement).value).toBe("");
    expect(puts()).toHaveLength(0);

    fireEvent.click(screen.getByTestId("edr-tenant-apply-ten-1"));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const [url, init] = puts()[0]!;
    expect(url).toBe("/edr/tenants/ten-1/mapping");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ orgId: "org-2" });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("sends orgId:null when a mapped tenant is set to Unmapped", async () => {
    route([tenant({ orgId: "org-1", orgName: "Acme", mappingSource: "manual" })]);
    render(<EdrTenantMapping connectionId="conn-1" orgs={orgs} canManage onChanged={vi.fn()} />);
    fireEvent.change(await screen.findByTestId("edr-tenant-select-ten-1"), { target: { value: "__unmapped__" } });
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse((puts()[0]![1] as RequestInit).body as string)).toEqual({ orgId: null });
  });

  it("maps to the chosen org from the select", async () => {
    route([tenant()]);
    render(<EdrTenantMapping connectionId="conn-1" orgs={orgs} canManage onChanged={vi.fn()} />);
    fireEvent.change(await screen.findByTestId("edr-tenant-select-ten-1"), { target: { value: "org-1" } });
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse((puts()[0]![1] as RequestInit).body as string)).toEqual({ orgId: "org-1" });
  });

  it("shows the vendor-missing marker and the summary line", async () => {
    route([tenant({ vendorMissingSince: "2026-09-01T00:00:00.000Z" })]);
    render(<EdrTenantMapping connectionId="conn-1" orgs={orgs} canManage onChanged={vi.fn()} />);
    expect(await screen.findByTestId("edr-tenant-missing-ten-1")).toBeInTheDocument();
    expect(screen.getByTestId("edr-mapping-summary").textContent).toContain("12");
  });

  it("hides mapping controls when the user cannot manage", async () => {
    route([tenant()], [{ tenantId: "ten-1", orgId: "org-2" }]);
    render(<EdrTenantMapping connectionId="conn-1" orgs={orgs} canManage={false} onChanged={vi.fn()} />);
    await screen.findByTestId("edr-tenant-row-ten-1");
    expect(screen.queryByTestId("edr-tenant-select-ten-1")).toBeNull();
    expect(screen.queryByTestId("edr-tenant-apply-ten-1")).toBeNull();
  });

  it("surfaces a load failure rather than an empty list", async () => {
    fetchMock.mockResolvedValue(res({ error: "boom" }, false, 500));
    render(<EdrTenantMapping connectionId="conn-1" orgs={orgs} canManage onChanged={vi.fn()} />);
    expect(await screen.findByTestId("edr-mapping-error")).toBeInTheDocument();
    expect(screen.queryByTestId("edr-mapping-empty")).toBeNull();
  });

  it("toasts exactly once when the mapping PUT fails", async () => {
    fetchMock.mockImplementation(async (_input, init) => {
      if ((init as RequestInit | undefined)?.method === "PUT") return res({ error: "org not found" }, false, 404);
      return res({ data: [tenant()], suggestions: [], summary: { tenants: 1, unmappedTenants: 1, unmappedEndpointCount: 0 } });
    });
    const onChanged = vi.fn();
    render(<EdrTenantMapping connectionId="conn-1" orgs={orgs} canManage onChanged={onChanged} />);
    fireEvent.change(await screen.findByTestId("edr-tenant-select-ten-1"), { target: { value: "org-1" } });
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });
});
