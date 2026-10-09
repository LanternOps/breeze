import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "crypto";

const { evaluateCapability, partnerTrustMode, requireCapability } = vi.hoisted(() => {
  const evaluateCapability = vi.fn(async (_cap?: string, _ctx?: unknown): Promise<any> => ({ allow: true }));
  return {
    evaluateCapability,
    partnerTrustMode: vi.fn((): "off" | "shadow" | "enforce" => "off"),
    requireCapability: vi.fn((capability: string) => async (c: any, next: any) => {
      const auth = c.get("auth");
      if (!auth?.partnerId) return next();
      const decision = await evaluateCapability(capability, {
        partnerId: auth.partnerId,
        userId: auth.user?.id,
        orgId: auth.orgId ?? undefined,
      });
      if (!decision.allow) {
        return c.json({
          error: decision.code,
          capability: decision.capability,
          reason: decision.reason,
          reviewRequested: false,
          meetingUrl: null,
        }, 403);
      }
      return next();
    }),
  };
});

const { routeAuth } = vi.hoisted(() => ({
  routeAuth: { current: null as Record<string, unknown> | null },
}));

vi.mock("../services/partnerTrust", () => ({ evaluateCapability, requireCapability }));
vi.mock("../config/partnerTrustMode", () => ({ partnerTrustMode }));

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
  organizations: { id: "organizations.id", partnerId: "organizations.partnerId" },
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
  hashBootstrapToken: vi.fn((t: string) => `hmac:${t}`),
  bootstrapTokenTtlMinutes: vi.fn(() => 10080),
  clampBootstrapTokenTtlMinutes: vi.fn((m: number) => Math.max(1, Math.min(Math.floor(m), 43200))),
  BOOTSTRAP_TOKEN_PATTERN: /^[A-Z0-9]{10}$/,
}));

vi.mock("../middleware/auth", () => ({
  siteAccessCheck: (allowed?: string[]) => (siteId?: string | null) =>
    allowed === undefined || (!!siteId && allowed.includes(siteId)),
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set("auth", routeAuth.current ?? {
      scope: "system",
      orgId: null,
      partnerId: "22222222-2222-4222-8222-222222222222",
      user: { id: "user-system", email: "system@example.com" },
      canAccessOrg: () => true,
      accessibleOrgIds: [],
      orgCondition: () => undefined,
    });
    return next();
  }),
  requireScope: () => vi.fn((_c: any, next: any) => next()),
  requirePermission: () => vi.fn((_c: any, next: any) => next()),
  requireMfa: () => vi.fn((_c: any, next: any) => next()),
  // Default to satisfied — most tests in this file exercise write routes
  // (already gated by the mocked requirePermission/requireMfa above), not
  // the read-route shortCode-visibility gate directly (see
  // enrollmentKeys_list_create.test.ts / enrollmentKeys_get_rotate_delete.test.ts
  // for that behavior's dedicated coverage).
  hasSatisfiedMfa: vi.fn(() => true),
}));

vi.mock("../services/permissions", () => ({
  PERMISSIONS: {
    ORGS_READ: { resource: "orgs", action: "read" },
    ORGS_WRITE: { resource: "orgs", action: "write" },
  },
  getUserPermissions: vi.fn(async () => ({
    permissions: ["orgs:read", "orgs:write"],
  })),
  hasPermission: (
    userPerms: { permissions: string[] },
    resource: string,
    action: string,
  ) =>
    userPerms.permissions.includes(`${resource}:${action}`) ||
    userPerms.permissions.includes("*:*"),
}));

vi.mock("../services/auditService", () => ({
  createAuditLogAsync: vi.fn(),
}));

vi.mock("../services/enrollmentKeySecurity", () => ({
  hashEnrollmentKey: vi.fn((raw: string) => `hashed:${raw}`),
  hashEnrollmentKeyCandidates: vi.fn((raw: string) => [`hashed:${raw}`]),
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

// Partner-cap enforcement (#2776 task 3.4). Mocked at the wiring level — the
// cap-computation/message logic itself is unit-tested directly against
// resolveEnrollmentDefaults/getEnrollmentDefaultsForOrg, so these route tests
// only need to prove the route calls assertTtlWithinCap with the right org id
// and TTL, and reacts correctly to its null/error return.
const assertTtlWithinCapMock = vi.fn(
  async (_orgId: string, _ttlMinutes: number | undefined) => null as string | null,
);
// clampTtlToCap (fix round 3, #2776): the CLAMP-shaped sibling of
// assertTtlWithinCap, used by mintChildEnrollmentKey/redeemShortCode/the
// /s/:code redemption/issueBootstrapTokenForKey for server-constant TTLs on
// paths with no interactive caller. Permissive default (returns ttlMinutes
// unchanged) models "no partner cap configured".
const clampTtlToCapMock = vi.fn(
  async (_orgId: string, ttlMinutes: number) => ttlMinutes,
);
vi.mock("../services/enrollmentDefaults", () => ({
  assertTtlWithinCap: (...args: [string, number | undefined]) =>
    assertTtlWithinCapMock(...args),
  clampTtlToCap: (...args: [string, number]) => clampTtlToCapMock(...args),
}));

// ============================================================
// Import after mocks
// ============================================================
import { enrollmentKeyRoutes, publicShortLinkRoutes } from "./enrollmentKeys";
import { db } from "../db";
import { createAuditLogAsync } from "../services/auditService";
import * as installerBootstrapTokenIssuance from "../services/installerBootstrapTokenIssuance";
import { rateLimiter } from "../services/rate-limit";

// ============================================================
// Helpers
// ============================================================

const ORG_ID = randomUUID();
const SITE_ID = randomUUID();
const KEY_ID = randomUUID();
const CHILD_KEY_ID = randomUUID();

/** Awaitable Drizzle limit result that also supports a terminal SHARE lock. */
function lockableLimitRows<T>(rows: T[]) {
  const result = Promise.resolve(rows) as Promise<T[]> & {
    for: (mode: string) => Promise<T[]>;
  };
  result.for = (mode: string) => {
    expect(mode).toBe('share');
    return Promise.resolve(rows);
  };
  return result;
}

function makeKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY_ID,
    orgId: ORG_ID,
    siteId: SITE_ID,
    name: "Test Key",
    key: "hashed:rawkey",
    keySecretHash: null,
    credentialGeneration: 1,
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

// Runs before every per-describe `vi.clearAllMocks()` (outer beforeEach hooks
// fire before inner ones). clearAllMocks only wipes call history, not
// mockImplementation, so every mock a test may reshape is reset here.
beforeEach(() => {
  routeAuth.current = null;
  partnerTrustMode.mockReturnValue("off");
  evaluateCapability.mockResolvedValue({ allow: true });
  assertTtlWithinCapMock.mockReset();
  assertTtlWithinCapMock.mockImplementation(async () => null);
  clampTtlToCapMock.mockReset();
  clampTtlToCapMock.mockImplementation(async (_orgId: string, ttlMinutes: number) => ttlMinutes);
  // Tests below install db mockImplementations; clearAllMocks keeps those, so
  // reset the four db entry points explicitly.
  vi.mocked(db.select).mockReset();
  vi.mocked(db.insert).mockReset();
  vi.mocked(db.update).mockReset();
  vi.mocked(db.delete).mockReset();
});

// ============================================================
// #7217 — failed Add Device attempts must not leave live keys behind, and a
// failed short-link download must not consume a use.
// ============================================================
describe("#7217 installer-link: no live key without a link", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUBLIC_API_URL = "https://api.example.com";
    app = new Hono();
    app.route("/enrollment-keys", enrollmentKeyRoutes);
  });

  function mockParentLookup(row = makeKeyRow({ maxUsage: 1 })) {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([row]) }),
        }),
      } as any)
      // allocateShortCode uniqueness probe (not found → free)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as any);
  }

  function mockDiscardDelete(
    rows: any[] = [{ id: KEY_ID, orgId: ORG_ID, name: "Add device link" }],
  ) {
    vi.mocked(db.delete).mockReturnValueOnce({
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }),
    } as any);
  }

  it("refuses a Windows link on a server that can only answer it with an error, before minting a child", async () => {
    process.env.PUBLIC_API_URL = "http://self-hosted.example.com:8080";
    mockParentLookup();

    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "windows" }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/https/i);
    expect(db.insert).not.toHaveBeenCalled();
    expect(issueDownloadHandleMock).not.toHaveBeenCalled();
  });

  it("with ?discardKeyOnFailure=1, deletes the parent key when the link cannot be made", async () => {
    process.env.PUBLIC_API_URL = "http://self-hosted.example.com:8080";
    mockParentLookup();
    mockDiscardDelete();

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/installer-link?discardKeyOnFailure=1`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "windows" }),
      },
    );

    expect(res.status).toBe(400);
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "enrollment_key.delete",
        details: expect.objectContaining({
          reason: "artifact_not_produced",
          route: "installer-link",
          status: 400,
        }),
      }),
    );
  });

  // Add Device's create and link calls share the enroll-write bucket, so a 429
  // on the link is the likeliest failure; the discard runs ahead of the limiter.
  it("still discards the parent key when the link request is rate-limited", async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    } as any);
    mockDiscardDelete();

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/installer-link?discardKeyOnFailure=1`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "windows" }),
      },
    );

    expect(res.status).toBe(429);
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("never lets a failing discard replace the caller's original error", async () => {
    process.env.PUBLIC_API_URL = "http://self-hosted.example.com:8080";
    // An auth context whose org predicate throws: the discard must log it and
    // the caller must still get the route's own 400, not a 500.
    routeAuth.current = {
      scope: "system",
      orgId: null,
      partnerId: null,
      user: { id: "user-system", email: "system@example.com" },
      canAccessOrg: () => true,
      accessibleOrgIds: [],
      orgCondition: () => {
        throw new Error("predicate exploded");
      },
    };
    mockParentLookup();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/installer-link?discardKeyOnFailure=1`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "windows" }),
      },
    );

    expect(res.status).toBe(400);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/could not discard/i),
      expect.objectContaining({ keyId: KEY_ID }),
    );
    errSpy.mockRestore();
  });

  it("#7974: installer_link_created audit never stores the live short code", async () => {
    mockParentLookup();
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([makeChildKeyRow()]),
      }),
    } as any);

    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "windows" }),
    });

    expect(res.status).toBe(200);
    const { shortUrl } = await res.json();
    const liveCode = shortUrl.split("/s/")[1];
    expect(liveCode).toMatch(/^[A-Za-z0-9]{10}$/);

    const call = vi
      .mocked(createAuditLogAsync)
      .mock.calls.map(([arg]) => arg)
      .find((arg) => arg.action === "enrollment_key.installer_link_created");
    expect(call).toBeDefined();
    expect(JSON.stringify(call)).not.toContain(liveCode);
    expect(call!.details).not.toHaveProperty("shortCode");
    // Still correlatable: a stable, non-reversible reference is recorded.
    expect(call!.details).toMatchObject({
      shortCodeRef: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
  });

  it("deletes the child link row it minted when issuing the download handle fails", async () => {
    mockParentLookup();
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([makeChildKeyRow()]),
      }),
    } as any);
    issueDownloadHandleMock.mockRejectedValueOnce(new Error("redis down"));
    const childDeleteWhere = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.delete).mockReturnValueOnce({ where: childDeleteWhere } as any);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await app.request(`/enrollment-keys/${KEY_ID}/installer-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "windows" }),
    });

    expect(res.status).toBe(500);
    // The live short-link child must not outlive the failed request.
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(childDeleteWhere).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("keeps the parent key when the link is produced", async () => {
    mockParentLookup();
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([makeChildKeyRow()]),
      }),
    } as any);

    const res = await app.request(
      `/enrollment-keys/${KEY_ID}/installer-link?discardKeyOnFailure=1`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "windows" }),
      },
    );

    expect(res.status).toBe(200);
    expect(db.delete).not.toHaveBeenCalled();
  });
});

describe("#7217 GET /s/:code: a failed download does not consume a use", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PUBLIC_API_URL = "https://api.example.com";
    app = new Hono();
    app.route("/s", publicShortLinkRoutes);
  });

  /**
   * Wire the claim → insert → serve path. Returns the captured update `set`
   * payloads (the claim, then any refund) and the delete `where` spy.
   */
  function wireRedemption(opts: {
    platform: "windows" | "macos";
    failRefund?: boolean;
  }) {
    const shortLinkRow = makeKeyRow({
      shortCode: "refund12345",
      installerPlatform: opts.platform,
      maxUsage: 50,
      usageCount: 2,
    });
    const downloadRow = makeChildKeyRow({
      installerPlatform: opts.platform,
      shortCode: null,
      createdBy: null,
    });
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue(lockableLimitRows([shortLinkRow])),
        }),
      }),
    } as any);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([downloadRow]),
      }),
    } as any);
    const updateSets: unknown[] = [];
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: vi.fn((payload: unknown) => {
            updateSets.push(payload);
            const isRefund = updateSets.length === 2;
            return {
              where: vi.fn().mockReturnValue({
                returning:
                  isRefund && opts.failRefund
                    ? vi.fn().mockRejectedValue(new Error("connection reset"))
                    : vi.fn().mockResolvedValue([{ id: KEY_ID }]),
              }),
            };
          }),
        }) as any,
    );
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.delete).mockReturnValue({ where: deleteWhere } as any);
    return { updateSets, deleteWhere };
  }

  it("refunds the use and removes the download key when the Windows installer cannot be built", async () => {
    // Non-https server: serveInstaller answers 400 after the claim.
    process.env.PUBLIC_API_URL = "http://self-hosted.example.com:8080";
    const { updateSets, deleteWhere } = wireRedemption({ platform: "windows" });

    const res = await app.request("/s/refund12345");

    expect(res.status).toBe(400);
    // Two updates: the claim (+1) and the refund (-1).
    expect(updateSets).toHaveLength(2);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it("refunds the use when the MSI cannot be fetched", async () => {
    const { fetchRegularMsi } = await import("../services/installerBuilder");
    vi.mocked(fetchRegularMsi).mockRejectedValueOnce(new Error("GitHub 404"));
    const issueSpy = vi
      .spyOn(installerBootstrapTokenIssuance, "issueBootstrapTokenForKey")
      .mockResolvedValueOnce({
        id: "btok-r",
        token: "REFUND1234",
        expiresAt: new Date(Date.now() + 3_600_000),
        parentKeyName: "Test Key",
      });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { updateSets, deleteWhere } = wireRedemption({ platform: "windows" });

    const res = await app.request("/s/refund12345");

    expect(res.status).toBe(503);
    expect(updateSets).toHaveLength(2);
    // Deleting the download key cascades the bootstrap token issued from it.
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    issueSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("refunds the use when the macOS build fails", async () => {
    const { buildMacosInstallerZip } = await import("../services/installerBuilder");
    vi.mocked(buildMacosInstallerZip).mockRejectedValueOnce(new Error("boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { updateSets, deleteWhere } = wireRedemption({ platform: "macos" });

    const res = await app.request("/s/refund12345");

    expect(res.status).toBe(500);
    expect(updateSets).toHaveLength(2);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("keeps the use when the installer is served", async () => {
    const issueSpy = vi
      .spyOn(installerBootstrapTokenIssuance, "issueBootstrapTokenForKey")
      .mockResolvedValueOnce({
        id: "btok-ok",
        token: "SERVED1234",
        expiresAt: new Date(Date.now() + 3_600_000),
        parentKeyName: "Test Key",
      });
    const { updateSets, deleteWhere } = wireRedemption({ platform: "windows" });

    const res = await app.request("/s/refund12345");

    expect(res.status).toBe(200);
    expect(updateSets).toHaveLength(1);
    expect(deleteWhere).not.toHaveBeenCalled();
    issueSpy.mockRestore();
  });

  it("logs a refund that could not be written instead of swallowing it", async () => {
    process.env.PUBLIC_API_URL = "http://self-hosted.example.com:8080";
    wireRedemption({ platform: "windows", failRefund: true });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await app.request("/s/refund12345");

    expect(res.status).toBe(400);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/could not refund/i),
      expect.objectContaining({ keyId: KEY_ID }),
    );
    errSpy.mockRestore();
  });
});

