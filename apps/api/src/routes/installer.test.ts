import { describe, it, expect, beforeEach, vi } from "vitest";

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

// ============================================================
// Imports after mocks
// ============================================================

import { Hono } from "hono";
import { installerRoutes } from "./installer";
import { db } from "../db";

function makeApp() {
  const app = new Hono();
  app.route("/api/v1/installer", installerRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
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
