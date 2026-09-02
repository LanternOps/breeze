import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ============================================================
// Mocks — must appear before any `import` of the source
// ============================================================

vi.mock("../db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../services/enrollmentKeySecurity", () => ({
  hashEnrollmentKey: vi.fn((k: string) => `hashed:${k}`),
  hashEnrollmentKeyCandidates: vi.fn((k: string) => [`hashed:${k}`]),
}));

// Partner-cap enforcement (#2776 fix round 3). Mocked at the wiring level —
// see enrollmentKeys.test.ts's identically-named-pattern helper for
// rationale. Permissive default (returns ttlMinutes unchanged) models "no
// partner cap configured", so every pre-existing test in this file (which
// predates the cap clamp) keeps passing without needing to stage an extra
// db.select call for the org⋈partner join.
const clampTtlToCapMock = vi.fn(
  async (_orgId: string, ttlMinutes: number) => ttlMinutes,
);
vi.mock("../services/enrollmentDefaults", () => ({
  clampTtlToCap: (...args: [string, number]) => clampTtlToCapMock(...args),
}));

// ============================================================
// Imports after mocks
// ============================================================

import { Hono } from "hono";
import { installerRoutes, childEnrollmentKeyTtlMinutes } from "./installer";
import { db } from "../db";

function makeApp() {
  const app = new Hono();
  app.route("/api/v1/installer", installerRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // vi.clearAllMocks clears call history but NOT implementations — restore
  // the permissive default every test.
  clampTtlToCapMock.mockReset();
  clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) => ttlMinutes);
  delete process.env.MACOS_INSTALLER_ALLOW_LEGACY_GET_BOOTSTRAP;
  delete process.env.AGENT_BACKUP_SERVER_URL;
});

async function redeemBootstrapOk(): Promise<Record<string, unknown>> {
  const tokenRow = {
    id: "backup-url-token",
    token: "HHHHHHHHHH",
    orgId: "backup-url-org",
    parentEnrollmentKeyId: "backup-url-parent-key",
    siteId: "backup-url-site",
    maxUsage: 1,
    consumedCount: 0,
    createdBy: "backup-url-user",
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  };

  vi.mocked(db.select)
    .mockReturnValueOnce({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([tokenRow]) }),
      }),
    } as any)
    .mockReturnValueOnce({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{
            id: "backup-url-parent-key",
            name: "Backup URL parent",
            orgId: "backup-url-org",
            siteId: "backup-url-site",
            keySecretHash: "parent-secret-hash",
            expiresAt: new Date(Date.now() + 60_000),
          }]),
        }),
      }),
    } as any)
    .mockReturnValueOnce({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: "backup-url-org", name: "Backup URL Org" }]),
        }),
      }),
    } as any);

  vi.mocked(db.insert).mockReturnValue({
    values: () => ({
      returning: () => Promise.resolve([{
        id: "backup-url-child-key",
        orgId: "backup-url-org",
        siteId: "backup-url-site",
      }]),
    }),
  } as any);
  vi.mocked(db.update).mockReturnValue({
    set: () => ({
      where: () => ({
        returning: () => Promise.resolve([{ ...tokenRow, consumedAt: new Date() }]),
      }),
    }),
  } as any);

  const res = await makeApp().request("/api/v1/installer/bootstrap", {
    method: "POST",
    headers: { "X-Breeze-Bootstrap-Token": "HHHHHHHHHH" },
  });
  expect(res.status).toBe(200);
  return await res.json() as Record<string, unknown>;
}

// #4126 follow-up: the human "Add Device" create route
// (routes/enrollmentKeys.ts) raised its no-env-set fallback to 43200 minutes
// (30 days), but this child-key TTL was missed and stayed at `24 * 60` (1
// day) — a self-hoster who sets neither env var got 30-day keys from Add
// Device but 1-day installer child keys.
describe("childEnrollmentKeyTtlMinutes", () => {
  const orig = process.env.CHILD_ENROLLMENT_KEY_TTL_MINUTES;
  afterEach(() => {
    if (orig === undefined) delete process.env.CHILD_ENROLLMENT_KEY_TTL_MINUTES;
    else process.env.CHILD_ENROLLMENT_KEY_TTL_MINUTES = orig;
  });

  it("falls back to 43200 minutes (30 days) — matching the human route — when the env var is unset", () => {
    delete process.env.CHILD_ENROLLMENT_KEY_TTL_MINUTES;
    expect(childEnrollmentKeyTtlMinutes()).toBe(43200);
  });

  it("falls back to 43200 when the env var is an empty string (#2776 compose gotcha)", () => {
    process.env.CHILD_ENROLLMENT_KEY_TTL_MINUTES = "";
    expect(childEnrollmentKeyTtlMinutes()).toBe(43200);
  });

  it("still honors an explicit CHILD_ENROLLMENT_KEY_TTL_MINUTES override", () => {
    process.env.CHILD_ENROLLMENT_KEY_TTL_MINUTES = "90";
    expect(childEnrollmentKeyTtlMinutes()).toBe(90);
  });
});

describe("POST /api/v1/installer/bootstrap", () => {
  it("includes backupServerUrl when AGENT_BACKUP_SERVER_URL is set", async () => {
    process.env.AGENT_BACKUP_SERVER_URL = "https://new.example.com";
    const body = await redeemBootstrapOk();
    expect(body.backupServerUrl).toBe("https://new.example.com");
  });

  it("omits/empty backupServerUrl when env unset", async () => {
    const body = await redeemBootstrapOk();
    expect(body.backupServerUrl ?? "").toBe("");
  });

  it("returns 400 for malformed token", async () => {
    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap", {
      method: "POST",
      headers: { "X-Breeze-Bootstrap-Token": "lowercase" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown token", async () => {
    vi.mocked(db.select).mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    } as any);

    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap", {
      method: "POST",
      headers: { "X-Breeze-Bootstrap-Token": "AAAAAAAAAA" },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "token invalid, expired, or already used",
    });
  });

  it("M-H1: 404 path NEVER passes raw token to console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(db.select).mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    } as any);

    const app = makeApp();
    const RAW = "ZZZZZZZZZZ";
    const res = await app.request("/api/v1/installer/bootstrap", {
      method: "POST",
      headers: { "X-Breeze-Bootstrap-Token": RAW },
    });
    expect(res.status).toBe(404);

    // Raw token must not appear anywhere in any console.error argument.
    const allArgs = errSpy.mock.calls.flat().map((a) => {
      try {
        return typeof a === "string" ? a : JSON.stringify(a);
      } catch {
        return String(a);
      }
    });
    for (const s of allArgs) {
      expect(s).not.toContain(RAW);
    }
    // It should still log a tokenHash for correlation.
    expect(allArgs.some((s) => s.includes("tokenHash"))).toBe(true);

    errSpy.mockRestore();
  });

  it("returns 404 for exhausted token (consumed_count >= max_usage)", async () => {
    vi.mocked(db.select).mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              {
                id: "t1",
                token: "BBBBBBBBBB",
                orgId: "o1",
                parentEnrollmentKeyId: "pk1",
                siteId: "s1",
                maxUsage: 2,
                consumedCount: 2,
                consumedAt: new Date(),
                expiresAt: new Date(Date.now() + 60_000),
              },
            ]),
        }),
      }),
    } as any);

    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap", {
      method: "POST",
      headers: { "X-Breeze-Bootstrap-Token": "BBBBBBBBBB" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for expired token", async () => {
    vi.mocked(db.select).mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              {
                id: "t1",
                token: "CCCCCCCCCC",
                orgId: "o1",
                parentEnrollmentKeyId: "pk1",
                siteId: "s1",
                maxUsage: 1,
                consumedCount: 0,
                consumedAt: null,
                expiresAt: new Date(Date.now() - 1000),
              },
            ]),
        }),
      }),
    } as any);

    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap", {
      method: "POST",
      headers: { "X-Breeze-Bootstrap-Token": "CCCCCCCCCC" },
    });
    expect(res.status).toBe(404);
  });

  it("consumes a live token whose parent key has already expired (#2775)", async () => {
    // The token itself has 7 days left; the parent enrollment key (the
    // deliberately transient 60-minute container created by the Add Device
    // modal) died an hour ago. The token's own expiry is the sole authority —
    // redemption must still succeed and the child key must get a fresh TTL,
    // not the parent's dead one.
    const tokenRow = {
      id: "t-2775",
      token: "EEEEEEEEEE",
      orgId: "o1",
      parentEnrollmentKeyId: "pk-dead",
      siteId: "s1",
      maxUsage: 10,
      consumedCount: 0,
      createdBy: "u1",
      consumedAt: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
    };
    const parentKey = {
      id: "pk-dead",
      name: "Acme parent",
      orgId: "o1",
      siteId: "s1",
      keySecretHash: "parent-secret-hash",
      expiresAt: new Date(Date.now() - 3600_000), // parent: dead an hour ago
    };
    const org = { id: "o1", name: "Acme Corp" };

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([tokenRow]) }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([parentKey]) }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([org]) }),
        }),
      } as any);

    let capturedChildKeyValues: Record<string, unknown> | null = null;
    vi.mocked(db.insert).mockReturnValue({
      values: (vals: Record<string, unknown>) => {
        capturedChildKeyValues = vals;
        return {
          returning: () =>
            Promise.resolve([{ id: "ck-2775", orgId: "o1", siteId: "s1" }]),
        };
      },
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: () => ({
        where: () => ({
          returning: () =>
            Promise.resolve([{ ...tokenRow, consumedAt: new Date() }]),
        }),
      }),
    } as any);

    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap", {
      method: "POST",
      headers: { "X-Breeze-Bootstrap-Token": "EEEEEEEEEE" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enrollmentKey).toMatch(/^[a-f0-9]{64}$/);
    // Child key gets its own fresh TTL, not the parent's dead one.
    expect(capturedChildKeyValues).not.toBeNull();
    const childExpiresAt = (
      capturedChildKeyValues as unknown as { expiresAt: Date }
    ).expiresAt;
    expect(childExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(childExpiresAt.getTime()).toBeGreaterThan(
      parentKey.expiresAt.getTime(),
    );
  });

  // Fix round 3 (#2776): this is the hottest of all the redemption paths —
  // every device enrollment goes through it — and it uses the
  // CHILD_ENROLLMENT_KEY_TTL_MINUTES server-constant default with no
  // interactive caller (the token IS the auth), so a partner cap below the
  // default must CLAMP the minted child's lifetime down, never reject.
  it("clamps the child key TTL down when the partner cap is below the CHILD_ENROLLMENT_KEY_TTL_MINUTES default", async () => {
    const tokenRow = {
      id: "t-cap-low", token: "FFFFFFFFFF", orgId: "o-cap", parentEnrollmentKeyId: "pk-cap",
      siteId: "s-cap", maxUsage: 1, consumedCount: 0, createdBy: "u1", consumedAt: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
    };
    const parentKey = {
      id: "pk-cap", name: "Cap parent", orgId: "o-cap", siteId: "s-cap",
      keySecretHash: null, expiresAt: new Date(Date.now() + 3600_000),
    };
    const org = { id: "o-cap", name: "Cap Org" };

    clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) =>
      Math.min(ttlMinutes, 60), // partner cap: 60 minutes
    );

    vi.mocked(db.select)
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([tokenRow]) }) }) } as any)
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([parentKey]) }) }) } as any)
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([org]) }) }) } as any);

    let capturedChildKeyValues: Record<string, unknown> | null = null;
    vi.mocked(db.insert).mockReturnValue({
      values: (vals: Record<string, unknown>) => {
        capturedChildKeyValues = vals;
        return { returning: () => Promise.resolve([{ id: "ck-cap-low", orgId: "o-cap", siteId: "s-cap" }]) };
      },
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ ...tokenRow, consumedAt: new Date() }]) }) }),
    } as any);

    const before = Date.now();
    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap", {
      method: "POST",
      headers: { "X-Breeze-Bootstrap-Token": "FFFFFFFFFF" },
    });
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(capturedChildKeyValues).not.toBeNull();
    const childExpiresAt = (capturedChildKeyValues as unknown as { expiresAt: Date }).expiresAt;
    // Clamped to the 60-minute cap, NOT the 43200-minute (30-day) default.
    expect(childExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 59 * 60 * 1000);
    expect(childExpiresAt.getTime()).toBeLessThanOrEqual(after + 60 * 60 * 1000 + 5_000);
    expect(clampTtlToCapMock).toHaveBeenCalledWith("o-cap", 43200);
  });

  it("does not shorten the child key TTL when the partner cap is above the CHILD_ENROLLMENT_KEY_TTL_MINUTES default (no-op clamp)", async () => {
    const tokenRow = {
      id: "t-cap-high", token: "GGGGGGGGGG", orgId: "o-cap2", parentEnrollmentKeyId: "pk-cap2",
      siteId: "s-cap2", maxUsage: 1, consumedCount: 0, createdBy: "u1", consumedAt: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
    };
    const parentKey = {
      id: "pk-cap2", name: "Cap2 parent", orgId: "o-cap2", siteId: "s-cap2",
      keySecretHash: null, expiresAt: new Date(Date.now() + 3600_000),
    };
    const org = { id: "o-cap2", name: "Cap2 Org" };

    clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) =>
      Math.min(ttlMinutes, 525_600), // generous partner cap
    );

    vi.mocked(db.select)
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([tokenRow]) }) }) } as any)
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([parentKey]) }) }) } as any)
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([org]) }) }) } as any);

    let capturedChildKeyValues: Record<string, unknown> | null = null;
    vi.mocked(db.insert).mockReturnValue({
      values: (vals: Record<string, unknown>) => {
        capturedChildKeyValues = vals;
        return { returning: () => Promise.resolve([{ id: "ck-cap-high", orgId: "o-cap2", siteId: "s-cap2" }]) };
      },
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ ...tokenRow, consumedAt: new Date() }]) }) }),
    } as any);

    const before = Date.now();
    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap", {
      method: "POST",
      headers: { "X-Breeze-Bootstrap-Token": "GGGGGGGGGG" },
    });
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(capturedChildKeyValues).not.toBeNull();
    const childExpiresAt = (capturedChildKeyValues as unknown as { expiresAt: Date }).expiresAt;
    // Unchanged: still the full 43200-minute (30-day) default.
    expect(childExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 43199 * 60 * 1000);
    expect(childExpiresAt.getTime()).toBeLessThanOrEqual(after + 43201 * 60 * 1000);
  });

  // #2776 regression. docker-compose threads CHILD_ENROLLMENT_KEY_TTL_MINUTES
  // in as `${CHILD_ENROLLMENT_KEY_TTL_MINUTES:-}`, which `docker compose
  // config` renders as `VAR: ""` when the operator hasn't set it — the
  // container sees it SET to an empty string, not absent. The old
  // `Number(process.env.X ?? 24 * 60)` read yielded 0 there (`??` doesn't fire
  // on '', Number('') === 0), so every redeemed child enrollment key was born
  // already expired and agent enrollment stopped working entirely on upgrade.
  it("an EMPTY CHILD_ENROLLMENT_KEY_TTL_MINUTES falls back to the shared 30-day default, not 0 (#2776)", async () => {
    vi.stubEnv("CHILD_ENROLLMENT_KEY_TTL_MINUTES", "");
    process.env.PUBLIC_API_URL = "https://us.2breeze.app";

    const tokenRow = {
      id: "t-empty-env", token: "HHHHHHHHHH", orgId: "o-env", parentEnrollmentKeyId: "pk-env",
      siteId: "s-env", maxUsage: 1, consumedCount: 0, createdBy: "u1", consumedAt: null,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
    };
    const parentKey = {
      id: "pk-env", name: "Env parent", orgId: "o-env", siteId: "s-env",
      keySecretHash: null, expiresAt: new Date(Date.now() + 3600_000),
    };
    const org = { id: "o-env", name: "Env Org" };

    vi.mocked(db.select)
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([tokenRow]) }) }) } as any)
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([parentKey]) }) }) } as any)
      .mockReturnValueOnce({ from: () => ({ where: () => ({ limit: () => Promise.resolve([org]) }) }) } as any);

    let capturedChildKeyValues: Record<string, unknown> | null = null;
    vi.mocked(db.insert).mockReturnValue({
      values: (vals: Record<string, unknown>) => {
        capturedChildKeyValues = vals;
        return { returning: () => Promise.resolve([{ id: "ck-env", orgId: "o-env", siteId: "s-env" }]) };
      },
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([{ ...tokenRow, consumedAt: new Date() }]) }) }),
    } as any);

    const before = Date.now();
    const res = await makeApp().request("/api/v1/installer/bootstrap", {
      method: "POST",
      headers: { "X-Breeze-Bootstrap-Token": "HHHHHHHHHH" },
    });
    const after = Date.now();

    expect(res.status).toBe(200);
    // The value handed to the cap clamp is the shared 30-day default, never 0.
    expect(clampTtlToCapMock).toHaveBeenCalledWith("o-env", 43200);
    const childExpiresAt = (capturedChildKeyValues as unknown as { expiresAt: Date }).expiresAt;
    expect(childExpiresAt.getTime()).toBeGreaterThan(after);
    expect(childExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 43199 * 60 * 1000);
    expect(childExpiresAt.getTime()).toBeLessThanOrEqual(after + 43201 * 60 * 1000);

    vi.unstubAllEnvs();
  });

  it("partially-consumed multi-use token still redeems and mints a single-use child key", async () => {
    process.env.PUBLIC_API_URL = "https://us.2breeze.app";
    process.env.AGENT_ENROLLMENT_SECRET = "shared-secret-test";

    const tokenRow = {
      id: "t1",
      token: "DDDDDDDDDD",
      orgId: "o1",
      parentEnrollmentKeyId: "pk1",
      siteId: "s1",
      maxUsage: 3,
      consumedCount: 1,
      createdBy: "u1",
      consumedAt: new Date(Date.now() - 5_000),
      expiresAt: new Date(Date.now() + 60_000),
    };
    const parentKey = {
      id: "pk1",
      name: "Acme parent",
      orgId: "o1",
      siteId: "s1",
      keySecretHash: "parent-secret-hash",
      expiresAt: new Date(Date.now() + 60_000 * 60),
    };
    const org = { id: "o1", name: "Acme Corp" };

    // Select call order: (1) token row, (2) parent key, (3) org name
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([tokenRow]) }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([parentKey]) }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([org]) }),
        }),
      } as any);

    // INSERT child key — capture values to assert it is minted single-use.
    let capturedChildKeyValues: Record<string, unknown> | null = null;
    vi.mocked(db.insert).mockReturnValue({
      values: (vals: Record<string, unknown>) => {
        capturedChildKeyValues = vals;
        return {
          returning: () =>
            Promise.resolve([{ id: "ck1", orgId: "o1", siteId: "s1" }]),
        };
      },
    } as any);

    // UPDATE consume (returns consumed row)
    vi.mocked(db.update).mockReturnValue({
      set: () => ({
        where: () => ({
          returning: () =>
            Promise.resolve([{ ...tokenRow, consumedAt: new Date() }]),
        }),
      }),
    } as any);

    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap", {
      method: "POST",
      headers: { "X-Breeze-Bootstrap-Token": "DDDDDDDDDD" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.serverUrl).toBe("https://us.2breeze.app");
    expect(body.enrollmentSecret).toBe("shared-secret-test");
    expect(body.siteId).toBe("s1");
    expect(body.orgName).toBe("Acme Corp");
    expect(body.enrollmentKey).toMatch(/^[a-f0-9]{64}$/);
    // Each redemption hands the child key to exactly one device, so it must be
    // single-use regardless of the token's max_usage (#2161).
    expect(capturedChildKeyValues).not.toBeNull();
    expect(
      (capturedChildKeyValues as unknown as Record<string, unknown>).maxUsage,
    ).toBe(1);
    // The child key must carry the redeeming token's id so Task 3's cancel
    // endpoint can find and refund the token (#2764).
    expect(
      (capturedChildKeyValues as unknown as Record<string, unknown>)
        .bootstrapTokenId,
    ).toBe(tokenRow.id);
  });

  it("lost race / exhausted-on-consume: deletes the pre-inserted child key and 404s", async () => {
    // Token passes the pre-read guard (consumed_count < max_usage) and expiry,
    // so redemption reaches the atomic consume UPDATE — but that UPDATE returns
    // no row (a concurrent redemption took the last slot first). The child key
    // inserted just before must be cleaned up, and the response must be 404.
    const tokenRow = {
      id: "t9",
      token: "GGGGGGGGGG",
      orgId: "o1",
      parentEnrollmentKeyId: "pk1",
      siteId: "s1",
      maxUsage: 2,
      consumedCount: 1,
      createdBy: "u1",
      consumedAt: new Date(Date.now() - 5_000),
      expiresAt: new Date(Date.now() + 60_000),
    };
    const parentKey = {
      id: "pk1",
      name: "Acme parent",
      orgId: "o1",
      siteId: "s1",
      keySecretHash: "parent-secret-hash",
      expiresAt: new Date(Date.now() + 60_000 * 60),
    };

    // Select order: (1) token row, (2) parent key. Org select is never reached.
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([tokenRow]) }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([parentKey]) }),
        }),
      } as any);

    // INSERT child key returns an id we expect to see deleted.
    vi.mocked(db.insert).mockReturnValue({
      values: () => ({
        returning: () =>
          Promise.resolve([{ id: "ck9", orgId: "o1", siteId: "s1" }]),
      }),
    } as any);

    // Atomic consume UPDATE loses the race → returns no row.
    vi.mocked(db.update).mockReturnValue({
      set: () => ({
        where: () => ({ returning: () => Promise.resolve([]) }),
      }),
    } as any);

    // Capture the compensating DELETE.
    let deleteCalled = false;
    vi.mocked(db.delete).mockReturnValue({
      where: () => {
        deleteCalled = true;
        return Promise.resolve([]);
      },
    } as any);

    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap", {
      method: "POST",
      headers: { "X-Breeze-Bootstrap-Token": "GGGGGGGGGG" },
    });
    expect(res.status).toBe(404);
    expect(deleteCalled).toBe(true);
  });

  it("propagates installer_platform from token to child enrollment key", async () => {
    process.env.PUBLIC_API_URL = "https://us.2breeze.app";
    process.env.AGENT_ENROLLMENT_SECRET = "shared-secret-test";

    const tokenRow = {
      id: "t2",
      token: "FFFFFFFFFF",
      orgId: "o1",
      parentEnrollmentKeyId: "pk1",
      siteId: "s1",
      maxUsage: 1,
      consumedCount: 0,
      createdBy: "u1",
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      installerPlatform: "windows",
    };
    const parentKey = {
      id: "pk1",
      name: "Acme parent",
      orgId: "o1",
      siteId: "s1",
      keySecretHash: "parent-secret-hash",
      expiresAt: new Date(Date.now() + 60_000 * 60),
    };
    const org = { id: "o1", name: "Acme Corp" };

    // Select call order: (1) token row, (2) parent key, (3) org name
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([tokenRow]) }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([parentKey]) }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([org]) }),
        }),
      } as any);

    // Capture values passed to INSERT child key
    let capturedChildKeyValues: Record<string, unknown> | null = null;
    vi.mocked(db.insert).mockReturnValue({
      values: (vals: Record<string, unknown>) => {
        capturedChildKeyValues = vals;
        return {
          returning: () =>
            Promise.resolve([{ id: "ck2", orgId: "o1", siteId: "s1" }]),
        };
      },
    } as any);

    // UPDATE consume (returns consumed row)
    vi.mocked(db.update).mockReturnValue({
      set: () => ({
        where: () => ({
          returning: () =>
            Promise.resolve([{ ...tokenRow, consumedAt: new Date() }]),
        }),
      }),
    } as any);

    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap", {
      method: "POST",
      headers: { "X-Breeze-Bootstrap-Token": "FFFFFFFFFF" },
    });
    expect(res.status).toBe(200);
    expect(capturedChildKeyValues).not.toBeNull();
    expect((capturedChildKeyValues as unknown as Record<string, unknown>).installerPlatform).toBe("windows");
  });

  it("rejects legacy GET bootstrap by default", async () => {
    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap/DDDDDDDDDD");
    expect(res.status).toBe(404);
  });

  it("allows legacy GET bootstrap only behind the compatibility flag", async () => {
    process.env.MACOS_INSTALLER_ALLOW_LEGACY_GET_BOOTSTRAP = "true";
    vi.mocked(db.select).mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    } as any);

    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap/EEEEEEEEEE");
    expect(res.status).toBe(404);
    expect(db.select).toHaveBeenCalled();
  });
});

describe("POST /api/v1/installer/bootstrap — trusted client IP (SR2-16)", () => {
  const origTrust = process.env.TRUST_PROXY_HEADERS;
  const origCidrs = process.env.TRUSTED_PROXY_CIDRS;

  afterEach(() => {
    if (origTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = origTrust;
    if (origCidrs === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
    else process.env.TRUSTED_PROXY_CIDRS = origCidrs;
    delete process.env.TRUST_CF_CONNECTING_IP;
  });

  function mockRedeemChain(tokenRow: Record<string, unknown>, parentKey: Record<string, unknown>, org: Record<string, unknown>) {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([tokenRow]) }) }),
      } as any)
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([parentKey]) }) }),
      } as any)
      .mockReturnValueOnce({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([org]) }) }),
      } as any);
    vi.mocked(db.insert).mockReturnValue({
      values: () => ({
        returning: () => Promise.resolve([{ id: "ck-ip-test", orgId: tokenRow.orgId, siteId: tokenRow.siteId }]),
      }),
    } as any);
  }

  it("records the fallback, not a spoofed cf-connecting-ip, when the peer is untrusted (SR2-16)", async () => {
    process.env.TRUST_PROXY_HEADERS = "false";
    delete process.env.TRUSTED_PROXY_CIDRS;

    const tokenRow = {
      id: "ip-t1", token: "IIIIIIIIII", orgId: "o-ip", parentEnrollmentKeyId: "pk-ip", siteId: "s-ip",
      maxUsage: 1, consumedCount: 0, createdBy: "u-ip", consumedAt: null, expiresAt: new Date(Date.now() + 60_000),
    };
    const parentKey = {
      id: "pk-ip", name: "IP parent", orgId: "o-ip", siteId: "s-ip", keySecretHash: "hash",
      expiresAt: new Date(Date.now() + 60_000 * 60),
    };
    const org = { id: "o-ip", name: "IP Org" };
    mockRedeemChain(tokenRow, parentKey, org);

    let capturedSet: Record<string, unknown> | null = null;
    vi.mocked(db.update).mockReturnValue({
      set: (vals: Record<string, unknown>) => {
        capturedSet = vals;
        return { where: () => ({ returning: () => Promise.resolve([{ ...tokenRow, consumedAt: new Date() }]) }) };
      },
    } as any);

    const app = makeApp();
    const res = await app.request(
      "/api/v1/installer/bootstrap",
      {
        method: "POST",
        headers: { "X-Breeze-Bootstrap-Token": "IIIIIIIIII", "cf-connecting-ip": "203.0.113.5" },
      },
      { incoming: { socket: { remoteAddress: "198.51.100.77" } } },
    );

    expect(res.status).toBe(200);
    expect(capturedSet).not.toBeNull();
    // GUARD-BITE: RED today — installer.ts reads the header raw, so the
    // persisted enrollment IP is the spoof '203.0.113.5' instead of the
    // socket fallback.
    expect((capturedSet as any).consumedFromIp).not.toBe("203.0.113.5");
    expect((capturedSet as any).consumedFromIp).toBe("198.51.100.77");
  });

  it("records the real cf-connecting-ip when the peer is a trusted proxy (SR2-16)", async () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    process.env.TRUSTED_PROXY_CIDRS = "198.51.100.77/32";
    process.env.TRUST_CF_CONNECTING_IP = "true";

    const tokenRow = {
      id: "ip-t2", token: "JJJJJJJJJJ", orgId: "o-ip2", parentEnrollmentKeyId: "pk-ip2", siteId: "s-ip2",
      maxUsage: 1, consumedCount: 0, createdBy: "u-ip2", consumedAt: null, expiresAt: new Date(Date.now() + 60_000),
    };
    const parentKey = {
      id: "pk-ip2", name: "IP2 parent", orgId: "o-ip2", siteId: "s-ip2", keySecretHash: "hash",
      expiresAt: new Date(Date.now() + 60_000 * 60),
    };
    const org = { id: "o-ip2", name: "IP2 Org" };
    mockRedeemChain(tokenRow, parentKey, org);

    let capturedSet: Record<string, unknown> | null = null;
    vi.mocked(db.update).mockReturnValue({
      set: (vals: Record<string, unknown>) => {
        capturedSet = vals;
        return { where: () => ({ returning: () => Promise.resolve([{ ...tokenRow, consumedAt: new Date() }]) }) };
      },
    } as any);

    const app = makeApp();
    const res = await app.request(
      "/api/v1/installer/bootstrap",
      {
        method: "POST",
        headers: { "X-Breeze-Bootstrap-Token": "JJJJJJJJJJ", "cf-connecting-ip": "203.0.113.5" },
      },
      { incoming: { socket: { remoteAddress: "198.51.100.77" } } },
    );

    expect(res.status).toBe(200);
    expect((capturedSet as any).consumedFromIp).toBe("203.0.113.5");
  });
});

// Recursively collects string leaves out of a Drizzle `sql`/`and`/`eq` query
// tree (mirrors the identical helper in discovery.test.ts, extended to also
// unwrap bound Param values and Column names). Lets us assert:
//   - the DECREMENT update actually uses GREATEST(... - 1, 0) rather than a
//     plain `consumedCount - 1` that could go negative;
//   - the DELETE's WHERE predicate actually references both `id` (pinned to
//     the looked-up child's id) AND `usage_count = 0` — a column reference
//     has no `.queryChunks`/`.value` array, so it's pinned by `.name`
//     instead (the underlying Column object itself is not asserted).
function collectSqlLeafStrings(node: unknown, seen = new Set<unknown>(), acc: string[] = []): string[] {
  if (typeof node === "string") {
    acc.push(node);
    return acc;
  }
  if (typeof node === "number" || typeof node === "boolean") {
    acc.push(String(node));
    return acc;
  }
  if (node === null || typeof node !== "object" || seen.has(node)) return acc;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectSqlLeafStrings(item, seen, acc);
    return acc;
  }
  const queryChunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(queryChunks)) {
    for (const item of queryChunks) collectSqlLeafStrings(item, seen, acc);
    return acc;
  }
  // Drizzle's raw SQL text segments are StringChunk instances shaped
  // `{ value: string[] }` — unwrap those.
  const value = (node as { value?: unknown }).value;
  if (Array.isArray(value)) {
    for (const item of value) collectSqlLeafStrings(item, seen, acc);
    return acc;
  }
  // Bound query parameters are Param instances shaped `{ value: <scalar> }`.
  if (typeof value === "string" || typeof value === "number") {
    acc.push(String(value));
    return acc;
  }
  // Column references (e.g. enrollmentKeys.id) have neither queryChunks nor
  // value — pin what's pinnable: the column's SQL name, not the object.
  const columnName = (node as { name?: unknown }).name;
  const columnType = (node as { columnType?: unknown }).columnType;
  if (typeof columnName === "string" && typeof columnType === "string") {
    acc.push(columnName);
  }
  return acc;
}

describe("POST /api/v1/installer/bootstrap/cancel (#2764)", () => {
  function mockChildLookup(child: Record<string, unknown> | null) {
    vi.mocked(db.select).mockReturnValueOnce({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(child ? [child] : []) }),
      }),
    } as any);
  }

  it("1. unused linked child: deletes the child row AND decrements consumed_count (refunded:true)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const RAW_SECRET = "raw-child-secret-1";
    const child = {
      id: "child-1",
      orgId: "o1",
      usageCount: 0,
      bootstrapTokenId: "tok-1",
    };
    mockChildLookup(child);

    let deleteWhereArgs: unknown = null;
    vi.mocked(db.delete).mockReturnValue({
      where: (arg: unknown) => {
        deleteWhereArgs = arg;
        return { returning: () => Promise.resolve([{ id: "child-1" }]) };
      },
    } as any);

    let capturedSet: Record<string, unknown> | null = null;
    let updateWhereArgs: unknown = null;
    vi.mocked(db.update).mockReturnValue({
      set: (vals: Record<string, unknown>) => {
        capturedSet = vals;
        return {
          where: (arg: unknown) => {
            updateWhereArgs = arg;
            return Promise.resolve([]);
          },
        };
      },
    } as any);

    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enrollmentSecret: RAW_SECRET }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ refunded: true });
    expect(deleteWhereArgs).not.toBeNull();

    // Pin the DELETE's WHERE shape: it must reference BOTH `id = <this
    // child's id>` AND `usage_count = 0` — not just "some predicate". A
    // guard that dropped the usage_count=0 half (or the id half) would
    // still make this test's `deleteWhereArgs).not.toBeNull()` pass, which
    // is exactly the untested-guard gap this pins.
    const deleteWhereText = collectSqlLeafStrings(deleteWhereArgs).join("");
    expect(deleteWhereText).toMatch(/\bid\s*=\s*child-1\b/);
    expect(deleteWhereText).toMatch(/usage_count\s*=\s*0\b/);

    // The decrement must be GREATEST(consumed_count - 1, 0), never a bare
    // `consumedCount - 1` that could underflow below zero.
    expect(capturedSet).not.toBeNull();
    const consumedCountExpr = (capturedSet as any).consumedCount;
    expect(typeof consumedCountExpr).toBe("object");
    const leaves = collectSqlLeafStrings(consumedCountExpr).join("");
    expect(leaves).toContain("GREATEST(");
    expect(leaves).toContain("- 1, 0)");
    expect(updateWhereArgs).not.toBeNull();

    // Forensic trail: the successful refund is logged with the child/token
    // ids, and the raw secret never appears in any logged argument.
    const allArgs = logSpy.mock.calls.flat().map((a) =>
      typeof a === "string" ? a : JSON.stringify(a),
    );
    expect(allArgs.some((s) => s.includes("refunded"))).toBe(true);
    expect(allArgs.some((s) => s.includes("child-1"))).toBe(true);
    expect(allArgs.some((s) => s.includes("tok-1"))).toBe(true);
    for (const s of allArgs) expect(s).not.toContain(RAW_SECRET);

    logSpy.mockRestore();
  });

  it("1b. lost race on DELETE (returning() → []): no decrement (refunded:false, already_used)", async () => {
    // The read at the top of the handler saw usage_count = 0 and a linked
    // token, but between that read and the DELETE a concurrent enroll (or a
    // concurrent cancel) already claimed/removed the row — the atomic
    // `WHERE id = X AND usage_count = 0 RETURNING id` guard is what this
    // pins: a 0-row DELETE must NOT fall through to the decrement. Without
    // the `!deletedChild` check, this exact scenario would double-refund.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const child = {
      id: "child-1b",
      orgId: "o1",
      usageCount: 0,
      bootstrapTokenId: "tok-1b",
    };
    mockChildLookup(child);

    vi.mocked(db.delete).mockReturnValue({
      where: () => ({ returning: () => Promise.resolve([]) }),
    } as any);

    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enrollmentSecret: "raw-child-secret-1b" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      refunded: false,
      reason: "already_used",
    });
    // The DELETE itself was attempted (that's how the race is lost), but the
    // decrement UPDATE must never run off a 0-row DELETE result.
    expect(db.update).not.toHaveBeenCalled();

    const allArgs = logSpy.mock.calls.flat().map((a) =>
      typeof a === "string" ? a : JSON.stringify(a),
    );
    expect(allArgs.some((s) => s.includes("already_used"))).toBe(true);
    logSpy.mockRestore();
  });

  it("2. child with usage_count > 0: nothing deleted, no decrement (refunded:false, already_used)", async () => {
    const child = {
      id: "child-2",
      orgId: "o1",
      usageCount: 1,
      bootstrapTokenId: "tok-2",
    };
    mockChildLookup(child);

    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enrollmentSecret: "raw-child-secret-2" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      refunded: false,
      reason: "already_used",
    });
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("3. second cancel of the same child (child row gone): 404, no decrement — farming regression", async () => {
    // The first cancel already deleted the child row; this simulates the
    // second call finding nothing by secret hash. Cancel must NEVER be able
    // to yield both a usable child key AND a second freed slot — so the
    // second call must neither delete anything (nothing left to delete) nor
    // decrement the token again.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const RAW_SECRET = "raw-child-secret-3";
    mockChildLookup(null);

    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enrollmentSecret: RAW_SECRET }),
    });

    expect(res.status).toBe(404);
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();

    const allArgs = errSpy.mock.calls.flat().map((a) =>
      typeof a === "string" ? a : JSON.stringify(a),
    );
    expect(allArgs.some((s) => s.includes("unknown_secret"))).toBe(true);
    for (const s of allArgs) expect(s).not.toContain(RAW_SECRET);
    errSpy.mockRestore();
  });

  it("4. child with bootstrap_token_id NULL (pre-migration key): refunded:false, not_linked, no delete", async () => {
    const child = {
      id: "child-4",
      orgId: "o1",
      usageCount: 0,
      bootstrapTokenId: null,
    };
    mockChildLookup(child);

    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enrollmentSecret: "raw-child-secret-4" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      refunded: false,
      reason: "not_linked",
    });
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("returns 400 when enrollmentSecret is missing", async () => {
    const app = makeApp();
    const res = await app.request("/api/v1/installer/bootstrap/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
