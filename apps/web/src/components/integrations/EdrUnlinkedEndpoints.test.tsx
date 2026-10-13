import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));
vi.mock("../shared/Toast", () => ({ showToast: vi.fn() }));

import EdrUnlinkedEndpoints from "./EdrUnlinkedEndpoints";
import { fetchWithAuth } from "../../stores/auth";

const fetchMock = vi.mocked(fetchWithAuth);
const res = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: "x", json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const endpoint = {
  id: "ep-1", orgId: "org-1", connectionId: "conn-1", tenantId: "ten-1", tenantName: "Acme North",
  provider: "bitdefender", vendorEndpointId: "ve1", hostname: "ws-01", osName: "Windows 11",
  health: "healthy", lastSeenAt: "2026-09-15T11:50:00.000Z", breezeDeviceId: null,
};

function route(endpoints: unknown[] = [endpoint]) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (url.startsWith("/edr/endpoints?")) return res({ data: endpoints });
    if (url.startsWith("/devices?")) return res({ data: [{ id: "dev-1", hostname: "WS-01", displayName: null }] });
    if (method === "PUT") return res({ data: {} });
    return res({});
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  route();
});

describe("EdrUnlinkedEndpoints", () => {
  it("queries the unlinked state for the connection and renders rows", async () => {
    render(<EdrUnlinkedEndpoints connectionId="conn-1" canManage />);
    expect(await screen.findByTestId("edr-endpoint-row-ep-1")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/edr/endpoints?connectionId=conn-1&state=unlinked");
  });

  it("switches to the ambiguous filter", async () => {
    render(<EdrUnlinkedEndpoints connectionId="conn-1" canManage />);
    await screen.findByTestId("edr-endpoint-row-ep-1");
    fireEvent.change(screen.getByTestId("edr-endpoints-state"), { target: { value: "ambiguous" } });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/edr/endpoints?connectionId=conn-1&state=ambiguous"),
    );
  });

  it("links an endpoint to a device of its org", async () => {
    render(<EdrUnlinkedEndpoints connectionId="conn-1" canManage />);
    const select = await screen.findByTestId("edr-endpoint-device-ep-1");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/devices?orgId=org-1&limit=200"));
    await screen.findByRole("option", { name: "WS-01" });
    fireEvent.change(select, { target: { value: "dev-1" } });
    fireEvent.click(screen.getByTestId("edr-endpoint-link-ep-1"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/edr/endpoints/ep-1/link",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ deviceId: "dev-1" }) }),
      ),
    );
  });

  it("renders a read-only list without link controls when canManage is false", async () => {
    render(<EdrUnlinkedEndpoints connectionId="conn-1" canManage={false} />);
    await screen.findByTestId("edr-endpoint-row-ep-1");
    expect(screen.queryByTestId("edr-endpoint-link-ep-1")).toBeNull();
  });

  it("shows an error banner, not the empty state, when the load fails", async () => {
    fetchMock.mockResolvedValue(res({ error: "x" }, false, 500));
    render(<EdrUnlinkedEndpoints connectionId="conn-1" canManage />);
    expect(await screen.findByTestId("edr-endpoints-error")).toBeInTheDocument();
    expect(screen.queryByTestId("edr-endpoints-empty")).toBeNull();
  });

  it("shows a truncation hint when more devices exist than were returned", async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/edr/endpoints?")) return res({ data: [endpoint] });
      if (url.startsWith("/devices?"))
        return res({ data: [{ id: "dev-1", hostname: "WS-01", displayName: null }], pagination: { total: 450, limit: 200, nextCursor: "c" } });
      return res({});
    });
    render(<EdrUnlinkedEndpoints connectionId="conn-1" canManage />);
    expect(await screen.findByTestId("edr-endpoint-devices-truncated")).toBeInTheDocument();
  });

  it("does not show the truncation hint when all devices were returned", async () => {
    render(<EdrUnlinkedEndpoints connectionId="conn-1" canManage />);
    await screen.findByRole("option", { name: "WS-01" });
    expect(screen.queryByTestId("edr-endpoint-devices-truncated")).toBeNull();
  });

  it("does not cache a failed device fetch permanently (retry works)", async () => {
    let fail = true;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/edr/endpoints?")) return res({ data: [endpoint] });
      if (url.startsWith("/devices?")) {
        return fail ? res({ error: "x" }, false, 500) : res({ data: [{ id: "dev-1", hostname: "WS-01", displayName: null }] });
      }
      return res({});
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<EdrUnlinkedEndpoints connectionId="conn-1" canManage />);
    const retry = await screen.findByTestId("edr-endpoint-devices-retry-ep-1");
    expect(errSpy).toHaveBeenCalled();
    fail = false;
    fireEvent.click(retry);
    await screen.findByRole("option", { name: "WS-01" });
    errSpy.mockRestore();
  });
});
