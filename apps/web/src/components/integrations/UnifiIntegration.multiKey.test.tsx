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

function devicesBody(rows: unknown[]) {
  return { data: rows, pagination: { nextCursor: null, total: rows.length } };
}

afterEach(() => vi.clearAllMocks());

describe("UnifiIntegration cloud multi-key save (#11808)", () => {
  const KEY_A = "11111111-1111-4111-8111-111111111111";
  function routeCloud(savedMappings: unknown[], putResponse?: Response) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/unifi")
        return Promise.resolve(
          res({
            connected: true,
            connectionType: "cloud",
            status: "connected",
            keys: [
              {
                id: KEY_A,
                label: "Main",
                keyLast4: "abcd",
                isEnabled: true,
                status: "connected",
                lastSyncAt: null,
                lastSyncStatus: null,
                lastSyncError: null,
                lastOkAt: null,
                hostsSeen: 1,
                sitesSeen: 2,
                createdAt: "2026-11-01T00:00:00Z",
              },
            ],
          }),
        );
      if (url.startsWith("/orgs/sites"))
        return Promise.resolve(
          res({ data: [{ id: "site-1", name: "HQ", orgId: "org-1" }] }),
        );
      if (url.startsWith("/orgs/organizations"))
        return Promise.resolve(res({ data: [{ id: "org-1", name: "Acme" }] }));
      if (url === "/unifi/mappings" && init?.method === "PUT")
        return Promise.resolve(putResponse ?? res({ success: true }));
      if (url === "/unifi/mappings")
        return Promise.resolve(res({ mappings: savedMappings }));
      if (url === "/unifi/sync-runs") return Promise.resolve(res({ runs: [] }));
      if (url === "/unifi/collectors")
        return Promise.resolve(res({ collectors: [] }));
      if (url.startsWith("/devices"))
        return Promise.resolve(res(devicesBody([])));
      if (url === "/unifi/hosts")
        return Promise.resolve(
          res({
            hosts: [
              {
                id: "h1",
                name: "Console 1",
                keyIds: [KEY_A],
                sites: [
                  { id: "s1", name: "Site One", keyIds: [KEY_A] },
                  { id: "s2", name: "Site Two", keyIds: [KEY_A] },
                ],
              },
            ],
            omitted: 0,
            keys: [{ id: KEY_A, label: "Main", ok: true }],
            complete: true,
          }),
        );
      return Promise.resolve(res({}));
    });
  }
  const saved = (id: string, hostId: string, siteId: string) => ({
    id,
    orgId: "org-1",
    siteId: "site-1",
    unifiHostId: hostId,
    unifiSiteId: siteId,
    unifiHostName: null,
    unifiSiteName: null,
  });
  const putCall = () =>
    fetchMock.mock.calls.find(
      (c) =>
        c[0] === "/unifi/mappings" && (c[1] as RequestInit)?.method === "PUT",
    );

  async function clearFirstRowAndSave() {
    render(<UnifiIntegration />);
    await screen.findByTestId("unifi-mapping-table");
    const selects = await screen.findAllByTestId("unifi-mapping-select");
    await waitFor(() =>
      expect((selects[0] as HTMLSelectElement).value).toBe("site-1"),
    );
    fireEvent.change(selects[0]!, { target: { value: "" } });
    fireEvent.click(screen.getByTestId("unifi-mapping-save"));
  }

  it("cloud save sends removeMappingIds, never hostIds", async () => {
    routeCloud([saved("m1", "h1", "s1"), saved("m2", "h1", "s2")]);
    await clearFirstRowAndSave();
    await waitFor(() => expect(putCall()).toBeTruthy());
    const body = JSON.parse((putCall()![1] as RequestInit).body as string);
    expect(body.removeMappingIds).toEqual(["m1"]);
    expect(body).not.toHaveProperty("hostIds");
    expect(body.mappings).toHaveLength(1);
    expect(body.mappings[0]).toMatchObject({
      unifiHostId: "h1",
      unifiSiteId: "s2",
    });
  });

  it("a saved mapping missing from the live host list is never in removeMappingIds", async () => {
    routeCloud([
      saved("m1", "h1", "s1"),
      saved("m2", "h1", "s2"),
      saved("gone", "h-missing", "s-missing"),
    ]);
    await clearFirstRowAndSave();
    await waitFor(() => expect(putCall()).toBeTruthy());
    const body = JSON.parse((putCall()![1] as RequestInit).body as string);
    expect(body.removeMappingIds).toEqual(["m1"]);
    expect(body.removeMappingIds).not.toContain("gone");
  });

  it("a 409 UNIFI_EXPLICIT_DELETES_REQUIRED on save asks for a reload", async () => {
    routeCloud(
      [saved("m1", "h1", "s1"), saved("m2", "h1", "s2")],
      res(
        {
          success: false,
          code: "UNIFI_EXPLICIT_DELETES_REQUIRED",
          message: "explicit deletes required",
        },
        false,
        409,
      ),
    );
    await clearFirstRowAndSave();
    const err = await screen.findByTestId("unifi-load-error");
    expect(err.textContent).toMatch(/reload/i);
  });

  it("shows the incomplete banner and a via-label chip from the hosts response", async () => {
    routeCloud([]);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/unifi/hosts")
        return Promise.resolve(
          res({
            hosts: [
              {
                id: "h1",
                name: "Console 1",
                keyIds: [KEY_A],
                sites: [{ id: "s1", name: "Site One", keyIds: [KEY_A] }],
              },
            ],
            omitted: 0,
            keys: [
              { id: KEY_A, label: "Main", ok: true },
              { id: "other", label: "Broken", ok: false, error: "x" },
            ],
            complete: false,
          }),
        );
      return base(url, init);
    });
    render(<UnifiIntegration />);
    await screen.findByTestId("unifi-hosts-incomplete-banner");
    expect(screen.getByTestId("unifi-mapping-via-chip").textContent).toContain(
      "Main",
    );
  });

  it("self-hosted save still sends hostIds", async () => {
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
        return Promise.resolve(res(devicesBody([])));
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
    render(<UnifiIntegration />);
    await screen.findByTestId("unifi-controller-mapping-card");
    await screen.findAllByRole("option", { name: "HQ" });
    fireEvent.change(screen.getByTestId("unifi-controller-mapping-select"), {
      target: { value: "site-1" },
    });
    fireEvent.click(screen.getByTestId("unifi-controller-mapping-save"));
    await waitFor(() => expect(putCall()).toBeTruthy());
    const body = JSON.parse((putCall()![1] as RequestInit).body as string);
    expect(body.hostIds).toEqual(["col-1"]);
    expect(body).not.toHaveProperty("removeMappingIds");
  });
});
