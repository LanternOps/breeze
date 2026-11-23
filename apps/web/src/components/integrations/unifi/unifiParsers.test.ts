import { describe, expect, it } from "vitest";
import {
  parseHostsResponse,
  parseSyncRuns,
  parseUnifiStatus,
} from "./unifiParsers";

const key = {
  id: "k1",
  label: "Main",
  keyLast4: "abcd",
  isEnabled: true,
  status: "reauth_required",
  lastSyncAt: "2026-11-01T00:00:00Z",
  lastSyncStatus: "failed",
  lastSyncError: "rejected",
  lastOkAt: "2026-10-30T00:00:00Z",
  hostsSeen: 2,
  sitesSeen: 3,
  createdAt: "2026-10-01T00:00:00Z",
};

describe("unifi response parsers keep the multi-key fields", () => {
  it("the hosts parser keeps keyIds and complete", () => {
    const parsed = parseHostsResponse({
      hosts: [
        {
          id: "h1",
          name: "Console",
          model: "UDM",
          keyIds: ["k1", "k2"],
          sites: [{ id: "s1", name: "Site", keyIds: ["k2"] }],
        },
      ],
      omitted: 0,
      keys: [
        { id: "k1", label: "Main", ok: true },
        { id: "k2", label: "Second", ok: false, error: "boom" },
      ],
      complete: false,
    });
    expect(parsed.complete).toBe(false);
    expect(parsed.hosts[0]!.keyIds).toEqual(["k1", "k2"]);
    expect(parsed.hosts[0]!.model).toBe("UDM");
    expect(parsed.hosts[0]!.sites[0]!.keyIds).toEqual(["k2"]);
    expect(parsed.keys).toEqual([
      { id: "k1", label: "Main", ok: true },
      { id: "k2", label: "Second", ok: false, error: "boom" },
    ]);
  });

  it("the hosts parser treats a missing complete flag as complete and tolerates a bare body", () => {
    expect(parseHostsResponse({ hosts: [] }).complete).toBe(true);
    expect(parseHostsResponse(null)).toEqual({
      hosts: [],
      keys: [],
      complete: true,
    });
  });

  it("the status parser keeps keys", () => {
    const parsed = parseUnifiStatus({
      connected: true,
      connectionType: "cloud",
      status: "connected",
      keys: [key],
    });
    expect(parsed.connected).toBe(true);
    expect(parsed.keys).toEqual([key]);
    expect(parseUnifiStatus({ connected: false }).keys).toBeUndefined();
  });

  it("the sync-runs parser keeps keyResults", () => {
    const keyResult = {
      keyId: "k1",
      label: "Main",
      status: "failed",
      authFailure: true,
      hostsSeen: null,
      sitesSeen: null,
      hostIds: null,
      error: "rejected",
    };
    const runs = parseSyncRuns({
      runs: [
        { id: "r1", status: "partial", keyResults: [keyResult] },
        { id: "r2", status: "success", keyResults: null },
        { id: "r3", status: "success" },
      ],
    });
    expect(runs[0]!.keyResults).toEqual([keyResult]);
    expect(runs[1]!.keyResults).toBeNull();
    expect(runs[2]!.keyResults).toBeNull();
    expect(runs[0]!.id).toBe("r1");
  });
});
