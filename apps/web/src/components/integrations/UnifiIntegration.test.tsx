import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";
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

// A well-formed GET /devices cursor-mode body. `fetchAllDevices` walks
// `pagination.nextCursor` and seeds the count from `pagination.total`, so a mock
// that omits them is not merely terse — it now reads as genuine response drift,
// which is the point of the guard being tested.
function devicesBody(
  rows: unknown[],
  overrides: { nextCursor?: string | null; total?: number } = {},
) {
  return {
    data: rows,
    pagination: {
      nextCursor: overrides.nextCursor ?? null,
      total: overrides.total ?? rows.length,
    },
  };
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
    if (url.startsWith("/devices")) return Promise.resolve(res(devicesBody([])));
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
          res(
            devicesBody([
              {
                id: "agent-1",
                hostname: "edge-01",
                displayName: "Edge",
                siteId: "site-1",
              },
            ]),
          ),
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
        return Promise.resolve(res(devicesBody([])));
      if (url.startsWith("/orgs/organizations"))
        return Promise.resolve(res(devicesBody([])));
      if (url === "/unifi/mappings")
        return Promise.resolve(res({ mappings: [] }));
      if (url === "/unifi/collectors")
        return Promise.resolve(res({ collectors: [] }));
      if (url.startsWith("/devices")) return Promise.resolve(res(devicesBody([])));
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

describe("UnifiIntegration collector-agent dropdown labels (#3121)", () => {
  // The devices list endpoint returns `hostname` + `displayName` and has no
  // `name` field, so a picker keyed on `name` silently falls through to the raw
  // UUID for every row. Ids are deliberately UUID-shaped here so a regression
  // shows up as the user-visible symptom rather than a generic string mismatch.
  const AGENT_DEVICES = [
    {
      id: "6eae0f70-8da9-49ff-9e18-c241698975f3",
      hostname: "edge-01.acme.local",
      displayName: "HQ Edge Collector",
      siteId: "site-1",
    },
    {
      id: "9c1b2f44-1111-4222-8333-c44455566677",
      hostname: "closet-sw-02",
      displayName: null,
      siteId: "site-1",
    },
    // displayName: "" survives the device write schemas (no .min(1)/trim on
    // PATCH /devices or /devices/provision), so it must fall through to
    // hostname — a blank <option> is worse than the UUID this fix removes.
    {
      id: "1f2e3d4c-5b6a-4798-8899-aabbccddeeff",
      hostname: "blank-name-host",
      displayName: "",
      siteId: "site-1",
    },
    // Different site: must be filtered OUT once site-1 is chosen.
    {
      id: "77778888-9999-4aaa-8bbb-cccddd000111",
      hostname: "branch-01",
      displayName: "Branch Router",
      siteId: "site-2",
    },
  ];
  const SITE_1_AGENTS = AGENT_DEVICES.filter((d) => d.siteId === "site-1");
  const OTHER_SITE_AGENT = AGENT_DEVICES[3];

  function optionLabels(select: HTMLElement): string[] {
    return within(select)
      .getAllByRole("option")
      .map((o) => o.textContent?.trim() ?? "");
  }

  it("labels the self-hosted controller agent picker by displayName, falling back to hostname", async () => {
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
      if (url === "/unifi/controller-sites")
        return Promise.resolve(res({ sites: [] }));
      if (url.startsWith("/devices"))
        return Promise.resolve(res(devicesBody(AGENT_DEVICES)));
      return Promise.resolve(res({ success: true }));
    });
    render(<UnifiIntegration />);

    // Pick the site first: that is the real user journey, it enables the agent
    // select, and it is the only way the siteId filter branch is exercised.
    await screen.findAllByRole("option", { name: "HQ" });
    fireEvent.change(screen.getByTestId("unifi-controller-site"), {
      target: { value: "site-1" },
    });
    const select = await screen.findByTestId("unifi-controller-agent");
    expect((select as HTMLSelectElement).disabled).toBe(false);

    await waitFor(() =>
      expect(optionLabels(select)).toContain("HQ Edge Collector"),
    );
    // No displayName → hostname; empty-string displayName → hostname too.
    expect(optionLabels(select)).toContain("closet-sw-02");
    expect(optionLabels(select)).toContain("blank-name-host");
    // Never a UUID, and never a blank label.
    for (const device of AGENT_DEVICES) {
      expect(optionLabels(select)).not.toContain(device.id);
    }
    // The site filter still applies — an agent at another site is not offered.
    expect(optionLabels(select)).not.toContain(OTHER_SITE_AGENT.displayName);
    // Values stay the device id — only the label changed.
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(expect.arrayContaining(SITE_1_AGENTS.map((d) => d.id)));
  });

  it("labels the per-console collector agent picker by displayName, falling back to hostname", async () => {
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
      if (url === "/unifi/hosts")
        return Promise.resolve(
          res({
            hosts: [
              { id: "host-1", name: "UDM Pro", model: "UDMPRO", sites: [] },
            ],
          }),
        );
      if (url.startsWith("/devices"))
        return Promise.resolve(res(devicesBody(AGENT_DEVICES)));
      return Promise.resolve(res({ success: true }));
    });
    render(<UnifiIntegration />);

    await screen.findAllByRole("option", { name: "HQ" });
    fireEvent.change(screen.getByTestId("unifi-collector-site"), {
      target: { value: "site-1" },
    });
    const select = await screen.findByTestId("unifi-collector-agent");
    expect((select as HTMLSelectElement).disabled).toBe(false);

    await waitFor(() =>
      expect(optionLabels(select)).toContain("HQ Edge Collector"),
    );
    expect(optionLabels(select)).toContain("closet-sw-02");
    expect(optionLabels(select)).toContain("blank-name-host");
    for (const device of AGENT_DEVICES) {
      expect(optionLabels(select)).not.toContain(device.id);
    }
    expect(optionLabels(select)).not.toContain(OTHER_SITE_AGENT.displayName);
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(expect.arrayContaining(SITE_1_AGENTS.map((d) => d.id)));
  });

  // devices.hostname is NOT NULL, so this row cannot come from a healthy API —
  // it stands in for the response-shape drift that caused #3121. The id is a
  // deliberate last resort, but it must not be silent: a warning is what makes
  // the next drift visible instead of shipping UUIDs to users again.
  it("warns and falls back to the device id when both name fields are missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nameless = {
      id: "deadbeef-0000-4000-8000-000000000001",
      hostname: null,
      displayName: null,
      siteId: "site-1",
    };
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
      if (url === "/unifi/controller-sites")
        return Promise.resolve(res({ sites: [] }));
      if (url.startsWith("/devices"))
        return Promise.resolve(res(devicesBody([nameless])));
      return Promise.resolve(res({ success: true }));
    });
    render(<UnifiIntegration />);

    const select = await screen.findByTestId("unifi-controller-agent");
    await waitFor(() => expect(optionLabels(select)).toContain(nameless.id));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("neither displayName nor hostname"),
      nameless.id,
    );
    warn.mockRestore();
  });
});

describe("UnifiIntegration agent-list integrity (#3121 follow-ups)", () => {
  // Self-hosted connected view. `devicesFor` receives the requested URL so a
  // test can serve a multi-page cursor walk, which is what fetchAllDevices does.
  function routeWithDevices(devicesFor: (url: string) => Response) {
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
      if (url === "/unifi/controller-sites")
        return Promise.resolve(res({ sites: [] }));
      if (url.startsWith("/devices"))
        return Promise.resolve(devicesFor(url));
      return Promise.resolve(res({ success: true }));
    });
  }

  /** Serve one fixed body for every device page. */
  function staticDevices(payload: unknown, ok = true) {
    return () => res(payload, ok);
  }

  function agentOptions(select: HTMLElement): string[] {
    return within(select)
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value)
      .filter((v) => v !== "");
  }

  function agentTexts(select: HTMLElement): string[] {
    return within(select)
      .getAllByRole("option")
      .map((o) => o.textContent?.trim() ?? "");
  }

  describe("the full fleet is reachable, not one capped page", () => {
    it("walks the cursor so agents beyond the first page are selectable", async () => {
      // The picker filters by site CLIENT-side, so a single capped page meant a
      // partner past the ceiling could never reach their agent — the same
      // "my agent isn't in the list" symptom #3121 produced.
      routeWithDevices((url) =>
        url.includes("cursor=page2")
          ? res(
              devicesBody(
                [
                  {
                    id: "agent-2",
                    hostname: "far-edge",
                    displayName: "Far Edge",
                    siteId: "site-1",
                  },
                ],
                { nextCursor: null, total: 2 },
              ),
            )
          : res(
              devicesBody(
                [
                  {
                    id: "agent-1",
                    hostname: "near-edge",
                    displayName: "Near Edge",
                    siteId: "site-1",
                  },
                ],
                { nextCursor: "page2", total: 2 },
              ),
            ),
      );
      render(<UnifiIntegration />);

      const select = await screen.findByTestId("unifi-controller-agent");
      // The second page's agent must be present — that is the whole point.
      await waitFor(() =>
        expect(agentOptions(select)).toEqual(["agent-1", "agent-2"]),
      );
      expect(agentTexts(select)).toContain("Far Edge");
      // A completed walk is not truncation.
      expect(screen.queryByTestId("unifi-agents-truncated")).toBeNull();
      expect(screen.queryByTestId("unifi-details-error")).toBeNull();
    });

    it("excludes decommissioned devices from the collector candidates", async () => {
      routeWithDevices(staticDevices(devicesBody([])));
      render(<UnifiIntegration />);

      await screen.findByTestId("unifi-controller-agent");
      await waitFor(() => {
        const call = fetchMock.mock.calls.find((c) =>
          String(c[0]).startsWith("/devices"),
        );
        expect(call).toBeTruthy();
        // The route only includes decommissioned rows when explicitly asked;
        // a decommissioned box is not a collector candidate.
        expect(String(call![0])).not.toContain("includeDecommissioned=true");
      });
    });

    it("warns when the walk hits its safety ceiling", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // A stuck cursor — the server keeps handing back a next page forever.
      // The walker stops at MAX_PAGES and must say the list is unreliable.
      routeWithDevices(() =>
        res(
          devicesBody(
            [
              {
                id: "agent-1",
                hostname: "edge-01",
                displayName: "Edge",
                siteId: "site-1",
              },
            ],
            { nextCursor: "always-more", total: 99999 },
          ),
        ),
      );
      render(<UnifiIntegration />);

      const note = await screen.findByTestId("unifi-agents-truncated");
      expect(note).toHaveTextContent(/incomplete/i);
      // Truncation is not a failure — it must not raise the error banner.
      expect(screen.queryByTestId("unifi-details-error")).toBeNull();
      warn.mockRestore();
    });
  });

  describe("response-shape drift is surfaced, not swallowed", () => {
    it("reports an error when the body carries no recognizable list (HTTP 200)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // An error body served with HTTP 200. `res.ok` is true, so the old code
      // unwrapped it to [] and pushed nothing to `failed` — an empty picker
      // with no explanation anywhere.
      routeWithDevices(staticDevices({ error: "something went wrong" }));
      render(<UnifiIntegration />);

      const err = await screen.findByTestId("unifi-details-error");
      expect(err).toHaveTextContent(/agent devices/i);
      expect(agentOptions(screen.getByTestId("unifi-controller-agent"))).toEqual(
        [],
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("response drift"),
        expect.stringContaining("no pagination total"),
      );
      warn.mockRestore();
    });

    it("reports an error when device rows carry neither hostname nor displayName", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // Literally the #3121 shape: rows arrive, but under a field name this
      // component does not read. It used to render UUIDs; now it says so.
      routeWithDevices(
        staticDevices(
          devicesBody([
            { id: "6eae0f70-8da9-49ff-9e18-c241698975f3", name: "Edge" },
          ]),
        ),
      );
      render(<UnifiIntegration />);

      const err = await screen.findByTestId("unifi-details-error");
      expect(err).toHaveTextContent(/agent devices/i);
      expect(agentOptions(screen.getByTestId("unifi-controller-agent"))).toEqual(
        [],
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("response drift"),
        expect.stringContaining("lack id/hostname/displayName"),
      );
      warn.mockRestore();
    });

    it("reports PARTIAL drift rather than silently dropping the bad rows", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // One good row, one drifted. An all-or-nothing guard would pass this
      // through with the bad row filtered out — a shorter list and no signal,
      // which is harder to notice than a total failure.
      routeWithDevices(
        staticDevices(
          devicesBody([
            {
              id: "agent-1",
              hostname: "edge-01",
              displayName: "Edge",
              siteId: "site-1",
            },
            { id: "agent-2", name: "Renamed Field" },
          ]),
        ),
      );
      render(<UnifiIntegration />);

      const err = await screen.findByTestId("unifi-details-error");
      expect(err).toHaveTextContent(/agent devices/i);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("response drift"),
        expect.stringContaining("1 of 2 device rows"),
      );
      warn.mockRestore();
    });

    it("reports drift for a row missing its id, which is what the save submits", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      routeWithDevices(
        staticDevices(
          devicesBody([{ hostname: "edge-01", displayName: "Edge" }]),
        ),
      );
      render(<UnifiIntegration />);

      await screen.findByTestId("unifi-details-error");
      expect(agentOptions(screen.getByTestId("unifi-controller-agent"))).toEqual(
        [],
      );
      warn.mockRestore();
    });

    it("does NOT report an error for a genuinely empty fleet", async () => {
      // The guard must stay quiet when a partner simply has no devices —
      // otherwise it is noise and gets ignored, which defeats the point.
      routeWithDevices(staticDevices(devicesBody([], { total: 0 })));
      render(<UnifiIntegration />);

      await screen.findByTestId("unifi-controller-agent");
      await waitFor(() =>
        expect(screen.queryByTestId("unifi-details-error")).toBeNull(),
      );
      expect(screen.queryByTestId("unifi-agents-truncated")).toBeNull();
    });

    it("treats a bare { devices: [...] } envelope as drift (no deployed shape returns it, per #778)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      routeWithDevices(
        staticDevices({
          devices: [
            {
              id: "agent-1",
              hostname: "edge-01",
              displayName: "Edge",
              siteId: "site-1",
            },
          ],
        }),
      );
      render(<UnifiIntegration />);

      await screen.findByTestId("unifi-details-error");
      warn.mockRestore();
    });

    it("does not leave a stale truncation notice after a failed reload", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // A notice asserting the list was cut short is a positive factual claim;
      // it must not survive a reload that loaded nothing at all.
      routeWithDevices(staticDevices({ error: "boom" }));
      render(<UnifiIntegration />);

      await screen.findByTestId("unifi-details-error");
      expect(screen.queryByTestId("unifi-agents-truncated")).toBeNull();
      warn.mockRestore();
    });
  });

  describe("agent status is visible in the picker", () => {
    it("annotates a non-online agent so an offline collector is not picked blind", async () => {
      routeWithDevices(
        staticDevices(
          devicesBody([
            {
              id: "agent-on",
              hostname: "edge-01",
              displayName: "Edge",
              siteId: "site-1",
              status: "online",
            },
            {
              id: "agent-off",
              hostname: "closet-sw",
              displayName: "Closet",
              siteId: "site-1",
              status: "offline",
            },
            {
              id: "agent-maint",
              hostname: "spare",
              displayName: "Spare",
              siteId: "site-1",
              status: "maintenance",
            },
          ]),
        ),
      );
      render(<UnifiIntegration />);

      const select = await screen.findByTestId("unifi-controller-agent");
      // Status text comes from the `devices` namespace, so it localizes with
      // the rest of the UI rather than leaking the raw enum.
      await waitFor(() =>
        expect(agentTexts(select)).toEqual(
          expect.arrayContaining([
            "Edge",
            "Closet (Offline)",
            "Spare (Maintenance)",
          ]),
        ),
      );
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
