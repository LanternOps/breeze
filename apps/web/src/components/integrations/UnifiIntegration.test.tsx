import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UnifiIntegration from "./UnifiIntegration";
import { fetchWithAuth } from "../../stores/auth";

vi.mock("../../stores/auth", () => ({
  fetchWithAuth: vi.fn(),
}));
vi.mock("@/lib/navigation", () => ({ navigateTo: vi.fn() }));
vi.mock("../../lib/authScope", () => ({
  getJwtClaims: vi.fn(() => ({ scope: "partner" })),
  loginPathWithNext: vi.fn(() => "/login"),
}));

const fetchMock = vi.mocked(fetchWithAuth);

function res(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

// Route fetchWithAuth by URL; telemetry returns a caller-supplied response so each
// test can pick the failure mode.
function routeFetch(telemetry: Response) {
  fetchMock.mockImplementation((url: string) => {
    if (url === "/unifi")
      return Promise.resolve(res({ connected: true, status: "connected" }));
    if (url.startsWith("/orgs/sites"))
      return Promise.resolve(
        res({ data: [{ id: "site-1", name: "HQ", orgId: "org-1" }] }),
      );
    if (url.startsWith("/orgs/organizations"))
      return Promise.resolve(res({ data: [{ id: "org-1", name: "Acme" }] }));
    if (url === "/unifi/mappings")
      return Promise.resolve(res({ mappings: [] }));
    if (url === "/unifi/sync-runs") return Promise.resolve(res({ runs: [] }));
    if (url === "/unifi/collectors")
      return Promise.resolve(res({ collectors: [] }));
    if (url.startsWith("/devices")) return Promise.resolve(res({ data: [] }));
    if (url === "/unifi/hosts") return Promise.resolve(res({ hosts: [] }));
    if (url.startsWith("/unifi/telemetry")) return Promise.resolve(telemetry);
    return Promise.resolve(res({}));
  });
}

afterEach(() => vi.clearAllMocks());

describe("UnifiIntegration connection-type chooser (not connected)", () => {
  it("offers cloud + self-hosted modes, and selecting self-hosted reveals the account label + Connect button", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/unifi") return Promise.resolve(res({ connected: false }));
      return Promise.resolve(res({}));
    });
    render(<UnifiIntegration />);

    // Both mode toggles render on the not-connected screen; cloud is the default.
    await screen.findByTestId("unifi-connect-mode");
    expect(screen.getByTestId("unifi-connect-mode-cloud")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByTestId("unifi-connect-mode-self-hosted"),
    ).toHaveAttribute("aria-checked", "false");
    // Cloud form is shown by default; the self-hosted form is not.
    expect(screen.getByTestId("unifi-connect-cloud")).toBeInTheDocument();
    expect(screen.queryByTestId("unifi-connect-self-hosted")).toBeNull();

    // Switch to self-hosted → account label input + Connect button appear; cloud form hides.
    fireEvent.click(screen.getByTestId("unifi-connect-mode-self-hosted"));
    expect(screen.getByTestId("unifi-connect-self-hosted")).toBeInTheDocument();
    expect(screen.getByTestId("unifi-account-label-input")).toBeInTheDocument();
    expect(
      screen.getByTestId("unifi-connect-self-hosted-submit"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("unifi-connect-cloud")).toBeNull();
  });

  it("POSTs the account label to /unifi/connect-self-hosted and reloads status", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/unifi") return Promise.resolve(res({ connected: false }));
      if (url === "/unifi/connect-self-hosted")
        return Promise.resolve(
          res({ connected: true, connectionType: "self_hosted" }),
        );
      return Promise.resolve(res({}));
    });
    render(<UnifiIntegration />);

    await screen.findByTestId("unifi-connect-mode");
    fireEvent.click(screen.getByTestId("unifi-connect-mode-self-hosted"));
    fireEvent.change(screen.getByTestId("unifi-account-label-input"), {
      target: { value: "Acme HQ" },
    });
    fireEvent.click(screen.getByTestId("unifi-connect-self-hosted-submit"));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => c[0] === "/unifi/connect-self-hosted",
      );
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        accountLabel: "Acme HQ",
      });
    });
  });
});

describe("UnifiIntegration self-hosted connected view", () => {
  it("hides cloud-only Sync now / mapping / history affordances when connectionType is self_hosted", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/unifi")
        return Promise.resolve(
          res({
            connected: true,
            status: "connected",
            connectionType: "self_hosted",
          }),
        );
      return Promise.resolve(res({}));
    });
    render(<UnifiIntegration />);

    await screen.findByTestId("unifi-connected");
    expect(screen.queryByTestId("unifi-sync")).toBeNull();
    expect(screen.queryByTestId("unifi-mapping-card")).toBeNull();
    expect(screen.queryByTestId("unifi-history-card")).toBeNull();
    // Disconnect stays available for both connection types.
    expect(screen.getByTestId("unifi-disconnect")).toBeInTheDocument();
  });
});

describe("UnifiIntegration self-hosted controller mapping (Task D2)", () => {
  // Self-hosted connected view with one agent-discovered controller site.
  function routeSelfHosted() {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/unifi")
        return Promise.resolve(
          res({
            connected: true,
            status: "connected",
            connectionType: "self_hosted",
          }),
        );
      if (url.startsWith("/orgs/sites"))
        return Promise.resolve(
          res({ data: [{ id: "site-1", name: "HQ", orgId: "org-1" }] }),
        );
      if (url.startsWith("/orgs/organizations"))
        return Promise.resolve(res({ data: [{ id: "org-1", name: "Acme" }] }));
      if (url === "/unifi/mappings")
        return Promise.resolve(res({ mappings: [] }));
      if (url === "/unifi/collectors")
        return Promise.resolve(res({ collectors: [] }));
      if (url.startsWith("/devices"))
        return Promise.resolve(
          res({ data: [{ id: "agent-1", name: "Edge", siteId: "site-1" }] }),
        );
      if (url === "/unifi/controller-sites")
        return Promise.resolve(
          res({
            sites: [
              {
                collectorId: "col-1",
                localSiteId: "default",
                name: "Default",
                mapped: false,
              },
            ],
          }),
        );
      return Promise.resolve(res({ success: true }));
    });
  }

  it("renders a mapping row for each agent-discovered controller site", async () => {
    routeSelfHosted();
    render(<UnifiIntegration />);

    await screen.findByTestId("unifi-controller-mapping-card");
    const rows = await screen.findAllByTestId("unifi-controller-mapping-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Default");
    expect(rows[0]).toHaveTextContent("default");
    // Empty-state copy must not be showing when a site exists.
    expect(screen.queryByTestId("unifi-controller-mapping-empty")).toBeNull();
  });

  it("shows the empty-state copy when no controller sites are discovered yet", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/unifi")
        return Promise.resolve(
          res({
            connected: true,
            status: "connected",
            connectionType: "self_hosted",
          }),
        );
      if (url === "/unifi/controller-sites")
        return Promise.resolve(res({ sites: [] }));
      if (url.startsWith("/orgs/sites"))
        return Promise.resolve(res({ data: [] }));
      if (url.startsWith("/orgs/organizations"))
        return Promise.resolve(res({ data: [] }));
      if (url === "/unifi/mappings")
        return Promise.resolve(res({ mappings: [] }));
      if (url === "/unifi/collectors")
        return Promise.resolve(res({ collectors: [] }));
      if (url.startsWith("/devices")) return Promise.resolve(res({ data: [] }));
      return Promise.resolve(res({ success: true }));
    });
    render(<UnifiIntegration />);

    const empty = await screen.findByTestId("unifi-controller-mapping-empty");
    expect(empty).toHaveTextContent("No sites discovered yet");
  });

  it("saves a mapping with the collector id as the sentinel unifiHostId", async () => {
    routeSelfHosted();
    render(<UnifiIntegration />);

    await screen.findByTestId("unifi-controller-mapping-card");
    // Wait for the Breeze-site <option> to populate before selecting.
    await screen.findAllByRole("option", { name: "HQ" });
    fireEvent.change(screen.getByTestId("unifi-controller-mapping-select"), {
      target: { value: "site-1" },
    });
    fireEvent.click(screen.getByTestId("unifi-controller-mapping-save"));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) =>
          c[0] === "/unifi/mappings" && (c[1] as RequestInit)?.method === "PUT",
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.mappings).toEqual([
        {
          unifiHostId: "col-1",
          unifiSiteId: "default",
          unifiSiteName: "Default",
          siteId: "site-1",
        },
      ]);
    });
  });

  it("registers a controller via PUT /unifi/controllers with the chosen site, agent, url, and key", async () => {
    routeSelfHosted();
    render(<UnifiIntegration />);

    await screen.findByTestId("unifi-controller-form");
    await screen.findAllByRole("option", { name: "HQ" });
    fireEvent.change(screen.getByTestId("unifi-controller-url"), {
      target: { value: "https://192.168.1.1" },
    });
    fireEvent.change(screen.getByTestId("unifi-controller-site"), {
      target: { value: "site-1" },
    });
    fireEvent.change(screen.getByTestId("unifi-controller-agent"), {
      target: { value: "agent-1" },
    });
    fireEvent.change(screen.getByTestId("unifi-controller-key"), {
      target: { value: "secret-key" },
    });
    fireEvent.click(screen.getByTestId("unifi-controller-register"));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => c[0] === "/unifi/controllers",
      );
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        siteId: "site-1",
        collectorDeviceId: "agent-1",
        controllerUrl: "https://192.168.1.1",
        apiKey: "secret-key",
      });
    });
  });
});

describe("UnifiIntegration deep-telemetry error surfacing", () => {
  it("shows the backend error message on a failed telemetry load (not a silent empty panel)", async () => {
    routeFetch(res({ error: "Access to this site denied" }, false, 403));
    render(<UnifiIntegration />);

    const select = await screen.findByTestId("unifi-telemetry-site");
    // The <option> populates after loadDetails resolves; wait for it before
    // selecting, else the change is a no-op against a not-yet-present value.
    await screen.findByRole("option", { name: "HQ" });
    fireEvent.change(select, { target: { value: "site-1" } });

    const err = await screen.findByTestId("unifi-telemetry-error");
    expect(err).toHaveTextContent("Access to this site denied");
    // The data tables must NOT render when the request failed.
    expect(screen.queryByTestId("unifi-telemetry-devices")).toBeNull();
  });

  it("renders telemetry tables on success", async () => {
    routeFetch(
      res({
        devices: [
          {
            id: "d1",
            unifiDeviceId: "ud1",
            name: "AP",
            mac: "aa:bb",
            numClients: 2,
            isStale: false,
            poePorts: [],
          },
        ],
        clients: [],
      }),
    );
    render(<UnifiIntegration />);

    const select = await screen.findByTestId("unifi-telemetry-site");
    // The <option> populates after loadDetails resolves; wait for it before
    // selecting, else the change is a no-op against a not-yet-present value.
    await screen.findByRole("option", { name: "HQ" });
    fireEvent.change(select, { target: { value: "site-1" } });

    await waitFor(() =>
      expect(screen.getByTestId("unifi-telemetry-devices")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("unifi-telemetry-error")).toBeNull();
  });
});
