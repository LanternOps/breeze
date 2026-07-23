import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "crypto";

// ============================================================
// Mocks — must appear before any `import` of the source
// ============================================================

vi.mock("../db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(
    async (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  ),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../db/schema", () => ({
  enrollmentKeys: {},
  installerBootstrapTokens: {},
}));

vi.mock("../db/schema/orgs", () => ({
  sites: {},
  enrollmentKeys: {},
}));

vi.mock("../db/schema/installerBootstrapTokens", () => ({
  installerBootstrapTokens: {},
}));

vi.mock("../services/installerBootstrapToken", () => ({
  generateBootstrapToken: vi.fn(() => "ABC1234567"),
  bootstrapTokenExpiresAt: vi.fn(() => new Date("2026-04-20T00:00:00.000Z")),
  BOOTSTRAP_TOKEN_PATTERN: /^[A-Z0-9]{10}$/,
}));

vi.mock("../middleware/auth", () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set("auth", {
      scope: "system",
      orgId: null,
      user: { id: "user-system", email: "system@example.com" },
      canAccessOrg: () => true,
      accessibleOrgIds: [],
    });
    return next();
  }),
  requireScope: () => vi.fn((_c: any, next: any) => next()),
  requirePermission: () => vi.fn((_c: any, next: any) => next()),
  requireMfa: () => vi.fn((_c: any, next: any) => next()),
}));

vi.mock("../services/permissions", () => ({
  PERMISSIONS: {
    ORGS_READ: { resource: "orgs", action: "read" },
    ORGS_WRITE: { resource: "orgs", action: "write" },
  },
}));

vi.mock("../services/auditService", () => ({
  createAuditLogAsync: vi.fn(),
}));

vi.mock("../services/enrollmentKeySecurity", () => ({
  hashEnrollmentKey: vi.fn((raw: string) => `hashed:${raw}`),
  hashEnrollmentKeyCandidates: vi.fn((raw: string) => [`hashed:${raw}`]),
}));

vi.mock("../services/msiSigning", () => ({
  MsiSigningService: { fromEnv: vi.fn(() => null) },
}));

vi.mock("../services/installerBuilder", () => ({
  buildWindowsInstallerZip: vi.fn(async () => Buffer.from("windows-zip")),
  buildMacosInstallerZip: vi.fn(async () => Buffer.from("macos-zip")),
  fetchRegularMsi: vi.fn(async () => Buffer.from("regular-msi")),
  assertMacosInstallerPkgsReachable: vi.fn(async () => {}),
  fetchMacosInstallerAppZip: vi.fn(async () => null),
  serveWindowsBootstrapMsi: vi.fn((c: any, args: { msi: Buffer; token: string; apiHost: string }) => {
    const filename = `Breeze Agent (${args.token}@${args.apiHost}).msi`;
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${filename}"`);
    c.header("Content-Length", String(args.msi.length));
    c.header("Cache-Control", "no-store");
    return c.body(args.msi);
  }),
}));

vi.mock("../services/installerAppZip", () => ({
  renameAppInZip: vi.fn(async (buf: Buffer) => buf),
}));

vi.mock("../services/rate-limit", () => ({
  rateLimiter: vi.fn(async () => ({
    allowed: true,
    remaining: 10,
    resetAt: new Date(),
  })),
}));

const issueDownloadHandleMock = vi.fn(async () => `dlh_${"1".repeat(32)}`);
const consumeDownloadHandleMock = vi.fn(async () => "a".repeat(64));
vi.mock("../services/downloadHandle", () => ({
  issueDownloadHandle: (...args: unknown[]) =>
    issueDownloadHandleMock(...(args as [])),
  consumeDownloadHandle: (...args: unknown[]) =>
    consumeDownloadHandleMock(...(args as [])),
}));

// H6: dynamic-import path inside serveInstaller pulls getRedis from '../services'.
// Provide a controllable mock so we can test fail-closed semantics.
const mockGetRedis = vi.fn(() => ({}) as any);
vi.mock("../services", () => ({
  getRedis: () => mockGetRedis(),
}));

// ============================================================
// Import after mocks
// ============================================================
import {
  enrollmentKeyRoutes,
  publicEnrollmentRoutes,
  publicShortLinkRoutes,
} from "./enrollmentKeys";
import { db, withSystemDbAccessContext } from "../db";
import { createAuditLogAsync } from "../services/auditService";
import { MsiSigningService } from "../services/msiSigning";
import { fetchMacosInstallerAppZip } from "../services/installerBuilder";
import { renameAppInZip } from "../services/installerAppZip";
import * as installerBootstrapTokenIssuance from "../services/installerBootstrapTokenIssuance";

// ============================================================
// Helpers
// ============================================================

const ORG_ID = randomUUID();
const SITE_ID = randomUUID();
const KEY_ID = randomUUID();
const CHILD_KEY_ID = randomUUID();

function makeKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    orgId: ORG_ID,
    siteId: SITE_ID,
    name: "Test Key",
    key: "hashed:rawkey",
    keySecretHash: null,
    shortCode: null,
    installerPlatform: null,
    maxUsage: 10,
    usageCount: 0,
    expiresAt: new Date(Date.now() + 3_600_000), // 1 hour from now
    createdBy: "user-system",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeChildKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CHILD_KEY_ID,
    orgId: ORG_ID,
    siteId: SITE_ID,
    name: "Test Key (link)",
    key: "hashed:childkey",
    keySecretHash: null,
    shortCode: "Ab3De5Fg7H",
    installerPlatform: "windows",
    maxUsage: 1,
    usageCount: 0,
    expiresAt: new Date(Date.now() + 3_600_000),
    createdBy: "user-system",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe("POST /enrollment-keys/:id/installer-link", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(MsiSigningService.fromEnv).mockReturnValue(null);
    process.env.PUBLIC_API_URL = "https://api.example.com";
    app = new Hono();
    app.route("/enrollment-keys", enrollmentKeyRoutes);
  });

  it("returns shortUrl in response", async () => {
    const parentRow = makeKeyRow();
    const childRow = makeChildKeyRow();

    // First select: look up parent key
    vi.mocked(db.select)
      // allocateShortCode: look up existing short code (not found → unique)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    // insert: create child key
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "windows" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shortUrl).toMatch(/^https?:\/\/.+\/s\/[A-Za-z0-9]{10}$/);
  });

  it("refuses to build an installer when parent key is within 60s of expiry", async () => {
    // Parent with only 30s of life left. Previously the child inherited this
    // and was DOA. Now the route refuses with 410 so the admin can regenerate.
    // NOTE: handler returns 410 before calling db.insert. Using the persistent
    // mockReturnValue here (not mockReturnValueOnce) so unconsumed entries
    // do not leak onto the queue and poison subsequent tests.
    const parentRow = makeKeyRow({
      expiresAt: new Date(Date.now() + 30_000),
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([parentRow]),
        }),
      }),
    } as any);

    const insertValues = vi.fn();
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "windows" }),
    });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toContain("expires too soon");
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("child key gets a 24h TTL when parent has enough remaining life", async () => {
    // Parent has 1h remaining (plenty) — child insert should fire with a
    // fresh ~24h expiresAt, independent of parent.
    const parentRow = makeKeyRow({
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h
    });
    const childRow = makeChildKeyRow();

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([childRow]),
    });
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const before = Date.now();
    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "windows" }),
    });
    const after = Date.now();
    expect(res.status).toBe(200);

    expect(insertValues).toHaveBeenCalledTimes(1);
    const firstCall = insertValues.mock.calls[0]!;
    const insertedRow = firstCall[0] as { expiresAt: Date };
    const childExpiryMs = insertedRow.expiresAt.getTime();
    // Child TTL must be at least 23 hours past "before" (well above parent's 1h)
    expect(childExpiryMs).toBeGreaterThan(before + 23 * 60 * 60 * 1000);
    // And no more than 25 hours past "after" (guards against runaway values)
    expect(childExpiryMs).toBeLessThan(after + 25 * 60 * 60 * 1000);
    // Explicitly NOT the parent's expiresAt
    expect(childExpiryMs).not.toBe(parentRow.expiresAt.getTime());
  });

  it("child key honors the ttlMinutes from the request body (per-link picker)", async () => {
    // Admin picked "7 days" in the Add Device modal. The child key (the
    // thing the short link redeems) must get a fresh 7d window measured
    // from mint time — not the deployment default, not the parent's life.
    const parentRow = makeKeyRow({
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // parent: 1h
    });
    const childRow = makeChildKeyRow();

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    const insertValues = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([childRow]),
    });
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const ttlMinutes = 10080; // 7 days
    const before = Date.now();
    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "windows", ttlMinutes }),
    });
    const after = Date.now();
    expect(res.status).toBe(200);

    expect(insertValues).toHaveBeenCalledTimes(1);
    const insertedRow = insertValues.mock.calls[0]![0] as { expiresAt: Date };
    const childExpiryMs = insertedRow.expiresAt.getTime();
    const ttlMs = ttlMinutes * 60 * 1000;
    expect(childExpiryMs).toBeGreaterThanOrEqual(before + ttlMs - 50);
    expect(childExpiryMs).toBeLessThanOrEqual(after + ttlMs + 50);
  });

  it("shortUrl and url share the same origin", async () => {
    const parentRow = makeKeyRow();
    const childRow = makeChildKeyRow();

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "windows" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const urlOrigin = new URL(body.url).origin;
    const shortUrlOrigin = new URL(body.shortUrl).origin;
    expect(urlOrigin).toBe(shortUrlOrigin);
  });

  it("returns 429 when per-user rate limit is exceeded", async () => {
    const { rateLimiter } = await import("../services/rate-limit");
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(),
    });

    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "windows" }),
    });
    expect(res.status).toBe(429);
  });
});

// ============================================================
// GET /s/:code  (publicShortLinkRoutes)
// ============================================================

describe("GET /s/:code", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(MsiSigningService.fromEnv).mockReturnValue(null);
    process.env.PUBLIC_API_URL = "https://api.example.com";
    app = new Hono();
    app.route("/s", publicShortLinkRoutes);
  });

  it("serves installer for valid code", async () => {
    const shortLinkRow = makeKeyRow({
      shortCode: "abc1234567",
      installerPlatform: "windows",
    });
    const childRow = makeChildKeyRow({ installerPlatform: "windows" });

    // select: look up by shortCode; issueBootstrapTokenForKey also selects the child row
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([shortLinkRow]),
        }),
      }),
    } as any);

    // insert: spawn single-use child key
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    // update: atomic usage increment (claimed successfully)
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: KEY_ID }]),
        }),
      }),
    } as any);

    // serveInstaller (Windows) now calls issueBootstrapTokenForKey — spy it
    const issueSpy = vi
      .spyOn(installerBootstrapTokenIssuance, "issueBootstrapTokenForKey")
      .mockResolvedValueOnce({
        id: "btok-1",
        token: "ABC1234567",
        expiresAt: new Date(Date.now() + 3_600_000),
        parentKeyName: "Test Key",
      });

    const res = await app.request("/s/abc1234567");

    expect(res.status).toBe(200);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(0);

    issueSpy.mockRestore();
  });

  it("passes createdByUserId: null (never \"\") for the null-creator child key", async () => {
    // Regression: the /s/:code route spawns the child download key with
    // createdBy: null (it has no authenticated user). serveInstaller's Windows
    // branch previously coerced that to "" via `?? ""`, and the empty string
    // failed the uuid cast on insert into installer_bootstrap_tokens.created_by
    // (`invalid input syntax for type uuid: ""`) — every Windows short link 500'd.
    // Match the real route: the child row carries createdBy: null.
    const shortLinkRow = makeKeyRow({
      shortCode: "nullcreator",
      installerPlatform: "windows",
    });
    const childRow = makeChildKeyRow({
      installerPlatform: "windows",
      createdBy: null,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([shortLinkRow]),
        }),
      }),
    } as any);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: KEY_ID }]),
        }),
      }),
    } as any);

    const issueSpy = vi
      .spyOn(installerBootstrapTokenIssuance, "issueBootstrapTokenForKey")
      .mockResolvedValueOnce({
        id: "btok-2",
        token: "NULLCREAT0",
        expiresAt: new Date(Date.now() + 3_600_000),
        parentKeyName: "Test Key",
      });

    const res = await app.request("/s/nullcreator");

    expect(res.status).toBe(200);
    expect(issueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ createdByUserId: null }),
    );
    // The "" that broke the uuid insert must never be passed.
    expect(issueSpy.mock.calls[0]?.[0]?.createdByUserId).not.toBe("");

    issueSpy.mockRestore();
  });

  it("returns 404 for unknown code", async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const res = await app.request("/s/unknowncode");
    expect(res.status).toBe(404);
  });

  it("returns 410 for expired key", async () => {
    const expiredRow = makeKeyRow({
      shortCode: "expiredcode",
      installerPlatform: "windows",
      expiresAt: new Date(Date.now() - 10_000), // past
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([expiredRow]),
        }),
      }),
    } as any);

    // Atomic update returns empty because expiry check in WHERE clause fails
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const res = await app.request("/s/expiredcode");
    expect(res.status).toBe(410);
  });

  it("returns 410 when atomic update returns empty (usage exhausted at increment)", async () => {
    const shortLinkRow = makeKeyRow({
      shortCode: "fullcode567",
      installerPlatform: "windows",
      maxUsage: 1,
      usageCount: 0, // pre-check passes...
    });
    const childRow = makeChildKeyRow({ installerPlatform: "windows" });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([shortLinkRow]),
        }),
      }),
    } as any);

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    // Atomic update returns empty → another request beat us to it
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]), // empty = limit hit
        }),
      }),
    } as any);

    // delete: clean up orphaned child key
    vi.mocked(db.delete).mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    } as any);

    const res = await app.request("/s/fullcode567");
    expect(res.status).toBe(410);
  });

  it("does not spawn a child key for an already-expired short-link parent", async () => {
    const expiredRow = makeKeyRow({
      installerPlatform: "windows",
      shortCode: "test123",
      expiresAt: new Date(Date.now() - 1000),
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([expiredRow]),
        }),
      }),
    } as any);

    // Atomic update should fail immediately due to expiry in WHERE clause
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]), // empty = expired
        }),
      }),
    } as any);

    const insertValues = vi.fn();
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

    const res = await app.request("/s/test123");
    expect(res.status).toBe(410);
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("returns 404 for code longer than 12 chars", async () => {
    const res = await app.request("/s/this-code-is-way-too-long-for-sure");
    expect(res.status).toBe(404);
  });

  it("returns 404 when row has null installerPlatform", async () => {
    const rowNoPlatform = makeKeyRow({
      shortCode: "noplatform1",
      installerPlatform: null,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([rowNoPlatform]),
        }),
      }),
    } as any);

    const res = await app.request("/s/noplatform1");
    expect(res.status).toBe(404);
  });

  // Task 32 (public HIGH-1): per-(short-code OR enrollment-key id) cap of
  // 30/hour on the installer signing service. The per-IP 10/min cap by itself
  // is bypassable via IP rotation; this cap binds the spend per enrollment
  // link regardless of source IP.
  it("returns 429 when per-short-code signing cap (30/hr) is reached, regardless of IP", async () => {
    const shortLinkRow = makeKeyRow({
      shortCode: "rlcode12345",
      installerPlatform: "windows",
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([shortLinkRow]),
        }),
      }),
    } as any);

    // First rateLimiter call = per-short-code bucket. Block it.
    const { rateLimiter } = await import("../services/rate-limit");
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 3_600_000),
    });

    const res = await app.request("/s/rlcode12345", {
      headers: { "cf-connecting-ip": "198.51.100.99" },
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/rate limit/i);

    // Cap MUST be checked before atomic-claim — otherwise an attacker
    // would burn usage slots even after being rate-limited.
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();

    // The bucket key must be derived from the short-code (not the IP),
    // so IP rotation cannot reset the budget.
    const calls = vi.mocked(rateLimiter).mock.calls;
    const firstKey = calls[0]?.[1] as string;
    expect(firstKey).toContain("rlcode12345");
    expect(firstKey).not.toContain("198.51.100.99");
  });

  it("per-short-code cap uses windowed bucket (30/hour)", async () => {
    const shortLinkRow = makeKeyRow({
      shortCode: "rlcode22345",
      installerPlatform: "windows",
    });
    const childRow = makeChildKeyRow({ installerPlatform: "windows" });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([shortLinkRow]),
        }),
      }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: KEY_ID }]),
        }),
      }),
    } as any);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    const { rateLimiter } = await import("../services/rate-limit");
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: true,
      remaining: 29,
      resetAt: new Date(Date.now() + 3_600_000),
    });

    await app.request("/s/rlcode22345", {
      headers: { "cf-connecting-ip": "198.51.100.5" },
    });

    // First rateLimiter call must be the per-short-code 30/3600 bucket.
    const calls = vi.mocked(rateLimiter).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const [, key, limit, windowSeconds] = calls[0] as [
      unknown,
      string,
      number,
      number,
    ];
    expect(key).toContain("rlcode22345");
    expect(limit).toBe(30);
    expect(windowSeconds).toBe(3600);
  });

  it("returns 503 when redis is unavailable for the per-short-code cap (fail closed)", async () => {
    const shortLinkRow = makeKeyRow({
      shortCode: "rlcode32345",
      installerPlatform: "windows",
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([shortLinkRow]),
        }),
      }),
    } as any);

    mockGetRedis.mockReturnValueOnce(null as any);

    const res = await app.request("/s/rlcode32345");
    expect(res.status).toBe(503);
    // No atomic claim, no child key insert.
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
});

// ============================================================
// GET /public-download/:platform — RLS scoping regression test
// ============================================================

describe("GET /public-download/:platform", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(MsiSigningService.fromEnv).mockReturnValue(null);
    issueDownloadHandleMock.mockResolvedValue(`dlh_${"1".repeat(32)}`);
    consumeDownloadHandleMock.mockResolvedValue("a".repeat(64));
    process.env.PUBLIC_API_URL = "https://api.example.com";
    app = new Hono();
    app.route("/enrollment-keys", publicEnrollmentRoutes);
  });

  it("does not bump child key usage_count on download — leaves the slot for the agent enroll call", async () => {
    // Regression test for the root cause of the MSI "401 Invalid or
    // expired enrollment key" bug. Previously serveInstaller ran
    // `UPDATE enrollment_keys SET usage_count = usage_count + 1 WHERE
    // id = :keyRow.id` right after a successful build. Combined with
    // max_usage = 1 on single-use child keys (short-link downloads and
    // single-count installer links), this burned the enrollment slot
    // at *download* time: by the time the agent POSTed to
    // /agents/enroll, the child row already had usage_count >=
    // max_usage, the enroll endpoint's `usage_count < max_usage`
    // filter rejected the row, and the agent saw the deliberately-opaque
    // "Invalid or expired enrollment key" 401. The enroll endpoint
    // itself owns the slot-consuming UPDATE under a TOCTOU-safe
    // `UPDATE ... WHERE usage_count < max_usage`, so downloads must
    // NOT bump usage_count. max_usage is "max successful enrollments,"
    // not "max downloads."
    const row = makeKeyRow({
      shortCode: "pubcode1234",
      installerPlatform: "windows",
      maxUsage: 1,
      usageCount: 0,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    } as any);

    // Fail loudly if anything inside the download path touches
    // db.update — the whole point of the fix is that the download path
    // is now read-only against the enrollment_keys row.
    vi.mocked(db.update).mockImplementation(() => {
      throw new Error(
        "db.update called on public-download — regression of the usage_count-burn bug",
      );
    });

    // serveInstaller (Windows) now calls issueBootstrapTokenForKey
    const issueSpy = vi
      .spyOn(installerBootstrapTokenIssuance, "issueBootstrapTokenForKey")
      .mockResolvedValueOnce({
        id: "btok-1",
        token: "ABC1234567",
        expiresAt: new Date(Date.now() + 3_600_000),
        parentKeyName: "Test Key",
      });

    const res = await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
    );

    expect(res.status).toBe(200);
    expect(db.update).not.toHaveBeenCalled();

    issueSpy.mockRestore();
  });

  it("public windows download serves a static MSI named with the bootstrap token", async () => {
    // Verifies that the public download path uses the bootstrap-token flow:
    // issueBootstrapTokenForKey → fetchRegularMsi → serveWindowsBootstrapMsi
    // with the token embedded in the Content-Disposition filename.
    const row = makeKeyRow({
      shortCode: "pubcode1234",
      installerPlatform: "windows",
      maxUsage: 1,
      usageCount: 0,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    } as any);

    const issueSpy = vi
      .spyOn(installerBootstrapTokenIssuance, "issueBootstrapTokenForKey")
      .mockResolvedValueOnce({
        id: "btok-1",
        token: "ABCDE12345",
        expiresAt: new Date(Date.now() + 3_600_000),
        parentKeyName: "Test Key",
      });

    const res = await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="Breeze Agent \(ABCDE12345@api\.example\.com\)\.msi"$/,
    );
    // No db.update — download does not consume enrollment slots
    expect(db.update).not.toHaveBeenCalled();

    // BREEZE-5: the anonymous public-download audit row must use the
    // anonymous-actor UUID sentinel, not the literal string "public" —
    // audit_logs.actor_id is `uuid NOT NULL`, so "public" made every
    // anonymous-download audit insert fail with pg 22P02 (invalid uuid).
    expect(vi.mocked(createAuditLogAsync)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "enrollment_key.public_download",
        actorId: "00000000-0000-0000-0000-000000000000",
      }),
    );

    issueSpy.mockRestore();
  });

  it("public windows download encodes a nonstandard port as host_PORT in the filename (#2341)", async () => {
    // `:` is illegal in Windows filenames — the browser rewrites it at save
    // time and the agent-side parser never matches, so the device installs
    // unenrolled with no visible error. The port must ride as `_PORT`.
    process.env.PUBLIC_API_URL = "https://self-hosted.example.com:8443";
    const row = makeKeyRow({
      shortCode: "pubcode1234",
      installerPlatform: "windows",
      maxUsage: 1,
      usageCount: 0,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    } as any);

    const issueSpy = vi
      .spyOn(installerBootstrapTokenIssuance, "issueBootstrapTokenForKey")
      .mockResolvedValueOnce({
        id: "btok-1",
        token: "ABCDE12345",
        expiresAt: new Date(Date.now() + 3_600_000),
        parentKeyName: "Test Key",
      });

    const res = await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="Breeze Agent (ABCDE12345@self-hosted.example.com_8443).msi"',
    );

    issueSpy.mockRestore();
  });

  it("public windows download returns 400 for a non-https server URL without burning a token (#2341)", async () => {
    // The agent always redeems the filename token over https, so an
    // http-only server can never enroll through this path — fail the
    // download with the reason instead of serving a dead MSI.
    process.env.PUBLIC_API_URL = "http://self-hosted.example.com:8080";
    const row = makeKeyRow({
      shortCode: "pubcode1234",
      installerPlatform: "windows",
      maxUsage: 1,
      usageCount: 0,
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    } as any);

    const issueSpy = vi.spyOn(
      installerBootstrapTokenIssuance,
      "issueBootstrapTokenForKey",
    );

    const res = await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/https/i);
    expect(issueSpy).not.toHaveBeenCalled();

    issueSpy.mockRestore();
  });

  it("rejects legacy raw token query downloads by default", async () => {
    const res = await app.request(
      `/enrollment-keys/public-download/windows?token=${"a".repeat(64)}`,
    );

    expect(res.status).toBe(400);
    expect(consumeDownloadHandleMock).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("rejects legacy raw token query downloads even behind the retired compatibility flag", async () => {
    process.env.PUBLIC_INSTALLER_ALLOW_LEGACY_TOKEN_QUERY = "true";

    const res = await app.request(
      `/enrollment-keys/public-download/windows?token=${"b".repeat(64)}`,
    );

    expect(res.status).toBe(400);
    expect(consumeDownloadHandleMock).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    delete process.env.PUBLIC_INSTALLER_ALLOW_LEGACY_TOKEN_QUERY;
  });
});

// ============================================================
// H6: public installer rate limit — XFF spoofing + fail-closed
// ============================================================

describe("H6: public-installer rate limit hardening", () => {
  let app: Hono;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(MsiSigningService.fromEnv).mockReturnValue(null);
    consumeDownloadHandleMock.mockResolvedValue("a".repeat(64));
    process.env.PUBLIC_API_URL = "https://api.example.com";
    // Ensure getTrustedClientIp is in production-strict mode by default in
    // these tests so spoofed XFF is ignored.
    process.env.NODE_ENV = "production";
    process.env.TRUST_PROXY_HEADERS = "false";
    mockGetRedis.mockReturnValue({} as any);
    const { rateLimiter } = await import("../services/rate-limit");
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: true,
      remaining: 9,
      resetAt: new Date(Date.now() + 60_000),
    });

    app = new Hono();
    app.route("/enrollment-keys", publicEnrollmentRoutes);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function mockKeyLookup() {
    const row = makeKeyRow({
      shortCode: "pubcode1234",
      installerPlatform: "windows",
      maxUsage: 1,
      usageCount: 0,
    });
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([row]),
        }),
      }),
    } as any);
  }

  it('ignores spoofed X-Forwarded-For — buckets share an "unknown" key', async () => {
    mockKeyLookup();
    const { rateLimiter } = await import("../services/rate-limit");

    await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
      { headers: { "X-Forwarded-For": "1.2.3.4" } },
    );
    mockKeyLookup();
    await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
      { headers: { "X-Forwarded-For": "5.6.7.8" } },
    );

    // Both requests must use the SAME per-IP bucket key — spoofed XFF must
    // NOT give the attacker a fresh limit per fake IP.
    const calls = vi.mocked(rateLimiter).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const ipKeys = calls
      .map((c) => c[1] as string)
      .filter((k) => k.startsWith("public-installer:"));
    expect(ipKeys.length).toBeGreaterThanOrEqual(2);
    const distinct = new Set(ipKeys);
    expect(distinct.size).toBe(1);
    // Confirm we did NOT key off the spoofed IP.
    for (const k of ipKeys) {
      expect(k).not.toContain("1.2.3.4");
      expect(k).not.toContain("5.6.7.8");
    }
  });

  it("returns 503 when getRedis() is null (fail closed, NOT 200)", async () => {
    mockKeyLookup();
    mockGetRedis.mockReturnValueOnce(null as any);

    const res = await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/temporarily unavailable/i);
  });

  it("returns 503 when rateLimiter throws (fail closed, NOT 200)", async () => {
    mockKeyLookup();
    const { rateLimiter } = await import("../services/rate-limit");
    vi.mocked(rateLimiter).mockRejectedValueOnce(
      new Error("redis disconnected"),
    );

    const res = await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
    );
    expect(res.status).toBe(503);
  });

  it("returns 429 when over the rate limit", async () => {
    mockKeyLookup();
    const { rateLimiter } = await import("../services/rate-limit");
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    });

    const res = await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
    );
    expect(res.status).toBe(429);
  });

  // Task 32: per-(enrollment-key id) signing cap on the public-download path,
  // so IP rotation cannot exhaust the signing-service budget for a single key.
  it("checks a per-enrollment-key cap (30/hr) in addition to per-IP", async () => {
    mockKeyLookup();
    const { rateLimiter } = await import("../services/rate-limit");

    await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
    );

    // Expect two distinct rateLimiter calls: one per-IP (10/60), one per-key
    // (30/3600). Order isn't load-bearing — just that both buckets are hit.
    const calls = vi.mocked(rateLimiter).mock.calls.map((c) => ({
      key: c[1] as string,
      limit: c[2] as number,
      window: c[3] as number,
    }));
    const ipCall = calls.find(
      (c) => c.limit === 10 && c.window === 60,
    );
    const keyCall = calls.find(
      (c) => c.limit === 30 && c.window === 3600,
    );
    expect(ipCall).toBeDefined();
    expect(keyCall).toBeDefined();
    // The per-key bucket must NOT be IP-derived (so IP rotation doesn't
    // create fresh buckets).
    expect(keyCall!.key).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("returns 429 when per-enrollment-key cap is reached even on a fresh IP", async () => {
    mockKeyLookup();
    const { rateLimiter } = await import("../services/rate-limit");
    // Per-IP allowed, per-key blocked.
    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({
        allowed: true,
        remaining: 9,
        resetAt: new Date(Date.now() + 60_000),
      })
      .mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 3_600_000),
      });

    const res = await app.request(
      `/enrollment-keys/public-download/windows?h=dlh_${"1".repeat(32)}`,
      // Spoofed IP irrelevant — production-strict mode ignores XFF.
      { headers: { "X-Forwarded-For": "203.0.113.42" } },
    );
    expect(res.status).toBe(429);
  });
});

// ============================================================
// POST /:id/bootstrap-token
// ============================================================

describe("POST /:id/bootstrap-token", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUBLIC_API_URL = "https://api.example.com";
    app = new Hono();
    app.route("/enrollment-keys", enrollmentKeyRoutes);
  });

  it("issues a bootstrap token for a valid parent key", async () => {
    const parent = makeKeyRow();

    // select x2: route's access-control lookup + helper's business-rule lookup
    const parentSelectMock = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([parent]),
        }),
      }),
    } as any;
    vi.mocked(db.select)
      .mockReturnValueOnce(parentSelectMock)
      .mockReturnValueOnce(parentSelectMock);

    // insert: create bootstrap token row — helper now uses .returning() to get the row id
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "token-row-uuid-1" }]),
      }),
    } as any);

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/bootstrap-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxUsage: 1 }),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toMatch(/^[A-Z0-9]{10}$/);
    expect(body.expiresAt).toBeTypeOf("string");
    expect(body.maxUsage).toBe(1);
  });

  it("rejects unknown parent key with 404", async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const missingId = randomUUID();
    const res = await app.request(
      `/enrollment-keys/${missingId}/bootstrap-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxUsage: 1 }),
      },
    );

    expect(res.status).toBe(404);
  });

  it("rejects when caller has no org access (403)", async () => {
    // Override authMiddleware to return a scope where canAccessOrg returns false
    const { authMiddleware: mockAuth } = await import("../middleware/auth");
    vi.mocked(mockAuth).mockImplementationOnce((c: any, next: any) => {
      c.set("auth", {
        scope: "partner",
        orgId: null,
        user: { id: "user-partner", email: "partner@example.com" },
        canAccessOrg: () => false,
        accessibleOrgIds: [],
      });
      return next();
    });

    const restrictedApp = new Hono();
    restrictedApp.route("/enrollment-keys", enrollmentKeyRoutes);

    const parent = makeKeyRow();

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([parent]),
        }),
      }),
    } as any);

    const res = await restrictedApp.request(
      `/enrollment-keys/${KEY_ID}/bootstrap-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxUsage: 1 }),
      },
    );

    expect(res.status).toBe(403);
  });

  it("rejects expired parent key with 410", async () => {
    const expiredParent = makeKeyRow({
      expiresAt: new Date(Date.now() - 10_000), // past
    });

    // select x2: route's access-control lookup + helper's business-rule lookup
    const expiredSelectMock = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([expiredParent]),
        }),
      }),
    } as any;
    vi.mocked(db.select)
      .mockReturnValueOnce(expiredSelectMock)
      .mockReturnValueOnce(expiredSelectMock);

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/bootstrap-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxUsage: 1 }),
      },
    );

    expect(res.status).toBe(410);
  });
});

// ============================================================
// GET /:id/installer/macos — app-bundle path
// ============================================================

describe("GET /:id/installer/macos — app-bundle path", () => {
  let app: Hono;
  let issueSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(MsiSigningService.fromEnv).mockReturnValue(null);
    process.env.PUBLIC_API_URL = "https://api.example.com";
    app = new Hono();
    app.route("/enrollment-keys", enrollmentKeyRoutes);

    // Default: issueBootstrapTokenForKey succeeds with a fixed token
    issueSpy = vi
      .spyOn(installerBootstrapTokenIssuance, "issueBootstrapTokenForKey")
      .mockResolvedValue({
        id: "token-row-uuid-1",
        token: "ABC1234567",
        expiresAt: new Date("2026-04-20T00:00:00.000Z"),
        parentKeyName: "Test Key",
      });
  });

  afterEach(() => {
    issueSpy.mockRestore();
  });

  it("returns a renamed app zip when installer app is available", async () => {
    const parentRow = makeKeyRow();

    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([parentRow]),
        }),
      }),
    } as any);

    // fetchMacosInstallerAppZip returns a fixture buffer
    vi.mocked(fetchMacosInstallerAppZip).mockResolvedValueOnce(
      Buffer.from("fixture-app-zip"),
    );

    // renameAppInZip returns a renamed buffer
    vi.mocked(renameAppInZip).mockResolvedValueOnce(
      Buffer.from("renamed-app-zip"),
    );

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/installer/macos?count=1`,
      { headers: { authorization: "Bearer jwt" } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    // Download name stays stable and token-free (Finder names the extracted
    // folder after it; the token must not leak into proxy/access logs).
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd).toBe('attachment; filename="breeze-agent-macos-installer.zip"');
    expect(cd).not.toContain("ABC1234567");
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    // The token must ride in BOTH the bundle filename (survives macOS App
    // Translocation, which strands sibling files) AND the sibling JSON (clean
    // read for the non-translocated case). See #2544.
    expect(vi.mocked(renameAppInZip)).toHaveBeenCalledWith(
      Buffer.from("fixture-app-zip"),
      expect.objectContaining({
        oldAppName: "Breeze Installer.app",
        newAppName: "Breeze Installer [ABC1234567@api.example.com].app",
        extraFiles: [
          {
            path: "Breeze Installer.bootstrap.json",
            data: JSON.stringify({
              token: "ABC1234567",
              apiHost: "api.example.com",
            }),
            mode: 0o600,
          },
        ],
      }),
    );
  });

  it("falls back to legacy zip when ?legacy=1 is passed", async () => {
    const parentRow = makeKeyRow();
    const childRow = makeChildKeyRow({ installerPlatform: "macos" });

    // select: parent key lookup + allocateShortCode dedup check
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]), // no existing short code → unique
          }),
        }),
      } as any);

    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    // fetchMacosInstallerAppZip is NOT called when ?legacy=1 is passed
    // (wantLegacy=true → appZip=null without calling the function)

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/installer/macos?count=1&legacy=1`,
      { headers: { authorization: "Bearer jwt" } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain(
      "breeze-agent-macos.zip",
    );
    // The app-bundle path must NOT have been called
    expect(vi.mocked(renameAppInZip)).not.toHaveBeenCalled();
    expect(issueSpy).not.toHaveBeenCalled();
  });

  it("falls back to legacy zip when installer app asset is missing (returns null)", async () => {
    const parentRow = makeKeyRow();
    const childRow = makeChildKeyRow({ installerPlatform: "macos" });

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    // fetchMacosInstallerAppZip default mock returns null → falls back to legacy path

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/installer/macos?count=1`,
      { headers: { authorization: "Bearer jwt" } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain(
      "breeze-agent-macos.zip",
    );
    expect(vi.mocked(renameAppInZip)).not.toHaveBeenCalled();
    expect(issueSpy).not.toHaveBeenCalled();
  });

  it("falls back to legacy zip for a nonstandard-port server URL even when the app asset exists (#2341)", async () => {
    // The app-bundle installer's Swift-side parser accepts only a bare https
    // host — no port form — so a ported self-hosted server could hand out a
    // bundle that can never enroll. The route must skip the app-bundle path
    // entirely (never even fetch the asset) and serve the legacy zip, which
    // embeds the full server URL.
    process.env.PUBLIC_API_URL = "https://self-hosted.example.com:8443";
    const parentRow = makeKeyRow();
    const childRow = makeChildKeyRow({ installerPlatform: "macos" });

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([parentRow]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([childRow]),
      }),
    } as any);

    // The asset IS available — the gate must short-circuit before fetching it.
    vi.mocked(fetchMacosInstallerAppZip).mockResolvedValueOnce(
      Buffer.from("fixture-app-zip"),
    );

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/installer/macos?count=1`,
      { headers: { authorization: "Bearer jwt" } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain(
      "breeze-agent-macos.zip",
    );
    expect(vi.mocked(fetchMacosInstallerAppZip)).not.toHaveBeenCalled();
    expect(vi.mocked(renameAppInZip)).not.toHaveBeenCalled();
    expect(issueSpy).not.toHaveBeenCalled();
  });
});

// ============================================================
// POST / - siteId ownership validation
// ============================================================

describe("POST / - siteId ownership validation", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUBLIC_API_URL = "https://api.example.com";
    app = new Hono();
    app.route("/enrollment-keys", enrollmentKeyRoutes);
  });

  it("rejects siteId that does not belong to the target org", async () => {
    const orgId = randomUUID();
    const siteId = randomUUID();

    // select: site lookup returns empty (site not found in org)
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]), // not found
        }),
      }),
    } as any);

    const res = await app.request("/enrollment-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orgId,
        name: "Test Key",
        siteId,
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/siteId.*does not belong.*org/i);
    // insert should never be called when siteId validation fails
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("creates key with valid siteId", async () => {
    const orgId = randomUUID();
    const siteId = randomUUID();
    const keyRow = makeKeyRow({ orgId, siteId });

    // select: site lookup returns the site
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: siteId }]),
        }),
      }),
    } as any);

    // insert: create enrollment key
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([keyRow]),
      }),
    } as any);

    const res = await app.request("/enrollment-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orgId,
        name: "Test Key",
        siteId,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.siteId).toBe(siteId);
  });

  it("creates key without siteId (null is valid)", async () => {
    const orgId = randomUUID();
    const keyRow = makeKeyRow({ orgId, siteId: null });

    // insert: create enrollment key with no siteId
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([keyRow]),
      }),
    } as any);

    const res = await app.request("/enrollment-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orgId,
        name: "Test Key",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.siteId).toBeNull();
    // when no siteId is provided, site lookup should not be called
    expect(db.select).not.toHaveBeenCalled();
  });
});
