// #11604: the partner-wide UniFi panel's site + agent pickers must not be
// narrowed to the org switcher's org. `fetchWithAuth` injects the ambient
// `?orgId=`; the panel opts out with `orgIdOverride: null` so the API's own
// access scoping decides what the user sees.
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import UnifiIntegration from "./UnifiIntegration";
import { fetchWithAuth } from "../../stores/auth";

vi.mock("../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));
vi.mock("@/lib/navigation", () => ({ navigateTo: vi.fn() }));
vi.mock("../../lib/authScope", () => ({
  getJwtClaims: vi.fn(() => ({ scope: "partner" })),
  loginPathWithNext: vi.fn(() => "/login"),
}));

const fetchMock = vi.mocked(fetchWithAuth);

function res(payload: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: vi.fn().mockResolvedValue(payload) } as unknown as Response;
}

const ORG_A = { id: "org-a", name: "Alpha Co", type: "customer" };
const ORG_B = { id: "org-b", name: "Beta Co", type: "customer" };
const SITE_A = { id: "site-a", name: "Alpha HQ", orgId: "org-a" };
const SITE_B = { id: "site-b", name: "Beta HQ", orgId: "org-b" };
const AGENT_B = { id: "dev-b", hostname: "beta-edge", displayName: "Beta Edge", siteId: "site-b", status: "online" };

// The org switcher's org. The real fetchWithAuth injects it as ?orgId= unless
// the call opts out with orgIdOverride: null, and the API then narrows to it.
const AMBIENT_ORG = "org-a";

/** Mimics fetchWithAuth + API: ambient org narrows unless the call opts out. */
function route(allOrgs: (typeof ORG_A)[], allSites: (typeof SITE_A)[], allAgents: (typeof AGENT_B)[]) {
  fetchMock.mockImplementation((url: string, init?: { orgIdOverride?: string | null }) => {
    const narrowed = init?.orgIdOverride !== null;
    const orgs = narrowed ? allOrgs.filter((o) => o.id === AMBIENT_ORG) : allOrgs;
    const sites = narrowed ? allSites.filter((s) => s.orgId === AMBIENT_ORG) : allSites;
    const siteIds = new Set(sites.map((s) => s.id));
    const agents = allAgents.filter((a) => siteIds.has(a.siteId));
    if (url === "/unifi")
      return Promise.resolve(res({ connected: true, status: "connected", connectionType: "self_hosted" }));
    if (url.startsWith("/orgs/sites")) return Promise.resolve(res({ data: sites }));
    if (url.startsWith("/orgs/organizations")) return Promise.resolve(res({ data: orgs }));
    if (url === "/unifi/mappings") return Promise.resolve(res({ mappings: [] }));
    if (url === "/unifi/collectors") return Promise.resolve(res({ collectors: [] }));
    if (url === "/unifi/controller-sites") return Promise.resolve(res({ sites: [] }));
    if (url.startsWith("/devices"))
      return Promise.resolve(res({ data: agents, pagination: { nextCursor: null, total: agents.length } }));
    return Promise.resolve(res({}));
  });
}

function optionLabels(select: HTMLElement) {
  return within(select).getAllByRole("option").map((o) => o.textContent?.trim() ?? "");
}

afterEach(() => vi.clearAllMocks());

describe("UniFi partner-wide pickers (#11604)", () => {
  it("opts the sites, organizations and devices reads out of the ambient orgId", async () => {
    route([ORG_A, ORG_B], [SITE_A, SITE_B], [AGENT_B]);
    render(<UnifiIntegration />);
    await screen.findByTestId("unifi-controller-site");
    await waitFor(() => {
      for (const prefix of ["/orgs/sites", "/orgs/organizations", "/devices"]) {
        const calls = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith(prefix));
        expect(calls.length, prefix).toBeGreaterThan(0);
        for (const c of calls) {
          expect((c[1] as { orgIdOverride?: unknown } | undefined)?.orgIdOverride, prefix).toBeNull();
        }
      }
    });
  });

  it("user with two orgs: sites from both orgs are grouped by org and an other-org agent is selectable", async () => {
    route([ORG_A, ORG_B], [SITE_A, SITE_B], [AGENT_B]);
    render(<UnifiIntegration />);
    const siteSelect = await screen.findByTestId("unifi-controller-site");
    await waitFor(() => expect(optionLabels(siteSelect)).toEqual(expect.arrayContaining(["Alpha HQ", "Beta HQ"])));
    const groupLabels = Array.from(siteSelect.querySelectorAll("optgroup")).map((g) => g.getAttribute("label"));
    expect(groupLabels).toEqual(expect.arrayContaining(["Alpha Co", "Beta Co"]));
    fireEvent.change(siteSelect, { target: { value: "site-b" } });
    const agentSelect = await screen.findByTestId("unifi-controller-agent");
    await waitFor(() => expect(optionLabels(agentSelect)).toContain("Beta Edge"));
  });

  it("user restricted to one org: only that org's sites appear (API scoping unchanged)", async () => {
    route([ORG_A], [SITE_A], []);
    render(<UnifiIntegration />);
    const siteSelect = await screen.findByTestId("unifi-controller-site");
    await waitFor(() => expect(optionLabels(siteSelect)).toContain("Alpha HQ"));
    expect(optionLabels(siteSelect)).not.toContain("Beta HQ");
  });
});
