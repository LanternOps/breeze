import { describe, expect, it, vi } from "vitest";

// unifiHelpers imports fetch helpers that pull in the auth store; the pure
// functions under test never call them.
vi.mock("@/lib/devicesFetch", () => ({ fetchAllDevices: vi.fn() }));
vi.mock("@/stores/auth", () => ({ fetchWithAuth: vi.fn() }));

import { computeRemoveMappingIds, uniqueSitesForKey } from "./unifiHelpers";
import { mapKey, type SavedMapping, type UnifiHostOption } from "./unifiTypes";

const saved = (id: string, unifiHostId: string, unifiSiteId: string): SavedMapping => ({
  id, orgId: "org-1", siteId: `breeze-${id}`, unifiHostId, unifiSiteId, unifiHostName: null, unifiSiteName: null,
});

const HOSTS: UnifiHostOption[] = [
  { id: "h1", name: "HQ", keyIds: ["k1", "k2"], sites: [
    { id: "default", name: "Default", keyIds: ["k1", "k2"] },
    { id: "s2", name: "Branch", keyIds: ["k1"] },
  ] },
  { id: "h2", name: "Lab", keyIds: ["k2"], sites: [{ id: "default", name: "Default", keyIds: ["k2"] }] },
];

describe("computeRemoveMappingIds (#11808 D9)", () => {
  it("removes only saved mappings the user cleared on a live row", () => {
    const mappings = [saved("m1", "h1", "default"), saved("m2", "h1", "s2"), saved("m3", "h2", "default")];
    const selection = { [mapKey("h1", "default")]: "breeze-m1", [mapKey("h1", "s2")]: "", [mapKey("h2", "default")]: "breeze-m3" };
    expect(computeRemoveMappingIds(mappings, HOSTS, selection, [])).toEqual(["m2"]);
  });

  it("treats an absent selection entry as cleared, like an empty one", () => {
    expect(computeRemoveMappingIds([saved("m2", "h1", "s2")], HOSTS, {}, [])).toEqual(["m2"]);
  });

  it("never removes a mapping whose host is missing from the live list", () => {
    expect(computeRemoveMappingIds([saved("gone", "h9", "default")], HOSTS, {}, [])).toEqual([]);
  });

  it("never removes a mapping whose host is live but whose site is not listed", () => {
    expect(computeRemoveMappingIds([saved("hidden", "h1", "s-hidden")], HOSTS, {}, [])).toEqual([]);
  });

  it("never removes a mapping the same save upserts (re-pointed to another Breeze site)", () => {
    const selection = { [mapKey("h1", "s2")]: "breeze-other" };
    expect(computeRemoveMappingIds([saved("m2", "h1", "s2")], HOSTS, selection, [{ unifiHostId: "h1", unifiSiteId: "s2" }])).toEqual([]);
  });

  it("keys sites by host and site, so the same site id on two hosts is independent", () => {
    const mappings = [saved("a", "h1", "default"), saved("b", "h2", "default")];
    const selection = { [mapKey("h1", "default")]: "breeze-a" };
    expect(computeRemoveMappingIds(mappings, HOSTS, selection, [])).toEqual(["b"]);
  });
});

describe("uniqueSitesForKey", () => {
  it("counts sites listed by exactly that key only", () => {
    expect(uniqueSitesForKey(HOSTS, "k1").map((s) => `${s.hostId}/${s.siteId}`)).toEqual(["h1/s2"]);
    expect(uniqueSitesForKey(HOSTS, "k2").map((s) => `${s.hostId}/${s.siteId}`)).toEqual(["h2/default"]);
  });

  it("never counts a site without keyIds (an older API)", () => {
    expect(uniqueSitesForKey([{ id: "h1", name: "x", sites: [{ id: "s", name: "s" }] }], "k1")).toEqual([]);
  });
});
