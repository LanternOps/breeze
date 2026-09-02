import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { generateKeyPairSync, sign } from "node:crypto";

// Real eq/and are opaque drizzle-orm SQL AST builders that aren't easy to
// assert on directly. Spy-wrap them (mirrors binarySync.test.ts) so
// edition-scoping tests can inspect exactly which columns/values a route
// built into its WHERE clause, without changing any chain shape the other
// (unmodified) tests in this file already rely on.
const drizzleSpies = vi.hoisted(() => ({
  eq: vi.fn((column: unknown, value: unknown) => ({ __op: "eq", column, value })),
  and: vi.fn((...clauses: unknown[]) => ({ __op: "and", clauses })),
}));
vi.mock("drizzle-orm", async (importActual) => {
  const actual = await importActual<typeof import("drizzle-orm")>();
  return { ...actual, eq: drizzleSpies.eq, and: drizzleSpies.and };
});

vi.mock("../db", () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(
    async (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  ),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}));

// #3499: the component=backup rewrite guard asks this resolver what the
// versionless download route will actually serve. Default to "no promoted
// row", which makes the guard fall back to comparing against the env version —
// the behavior every pre-existing test in this file was written against.
vi.mock("../services/promotedAgentVersion", () => ({
  getPromotedComponentVersion: vi.fn(async () => null),
}));

vi.mock("../services/manifestSigning", () => ({
  // Simulate no DB-provisioned deployment keys by default so tests that
  // don't set env vars still get a soft-pass (no env + no DB = empty keyset).
  getActivePublicKeys: vi.fn().mockResolvedValue([]),
  getActiveTrustKeyset: vi.fn().mockResolvedValue([]),
  ensureActiveSigningKey: vi.fn().mockResolvedValue({ keyId: "test-key", publicKeyB64: "" }),
  signManifest: vi.fn().mockResolvedValue("test-signature"),
}));

// #4262: the sync-github route now classifies SSRF-guard refusals. Mock the
// service so the route's error branches can be driven directly, and the Sentry
// capture so it can be asserted without a DSN.
vi.mock("../services/binarySync", () => ({
  syncFromGitHub: vi.fn(),
}));
vi.mock("../services/sentry", () => ({
  captureException: vi.fn(),
}));
vi.mock("../services/auditEvents", () => ({
  writeRouteAudit: vi.fn(),
}));

// Platform-admin gate for the promote/list routes. Toggle `platformAdminAllow`
// per-test: when false the middleware throws a 403 HTTPException exactly like
// the real one does for a non-platform-admin caller.
const platformAdminState = vi.hoisted(() => ({ allow: true }));
vi.mock("../middleware/platformAdmin", () => ({
  platformAdminMiddleware: vi.fn(async (_c: any, next: any) => {
    if (!platformAdminState.allow) {
      const { HTTPException } = await import("hono/http-exception");
      throw new HTTPException(403, {
        message: "platform admin access required",
      });
    }
    await next();
  }),
}));

vi.mock("../middleware/auth", () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => vi.fn(async (_c: any, next: any) => next()),
  requirePermission: () => vi.fn(async (_c: any, next: any) => next()),
  requireMfa: () => vi.fn(async (_c: any, next: any) => next()),
}));

import {
  agentVersionRoutes,
  validateReleaseManifest,
  verifyEd25519ManifestSignature,
  canonicalReleaseAssetName,
} from "./agentVersions";
import { db } from "../db";
import { agentVersions } from "../db/schema";
import * as manifestSigning from "../services/manifestSigning";
import { writeRouteAudit } from "../services/auditEvents";
import { syncFromGitHub } from "../services/binarySync";
import { captureException } from "../services/sentry";
import { ResponseTooLargeError, SsrfBlockedError } from "../services/urlSafety";
import { getPromotedComponentVersion } from "../services/promotedAgentVersion";
import { requiredPlatformTrustFor } from "../services/releaseAssetTrust";

// Recursively searches an and()/eq() spy tree (see drizzleSpies above) for an
// eq(agentVersions.edition, expected) leaf clause.
function hasEditionClause(node: unknown, expected: string): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as { __op?: string; column?: unknown; value?: unknown; clauses?: unknown[] };
  if (n.__op === "eq") {
    return n.column === agentVersions.edition && n.value === expected;
  }
  if (n.__op === "and" && Array.isArray(n.clauses)) {
    return n.clauses.some((c) => hasEditionClause(c, expected));
  }
  return false;
}

function makeSignedReleaseManifest(overrides: Record<string, unknown> = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPublicKey = publicDer.subarray(publicDer.length - 32);
  const manifest = JSON.stringify({
    version: "1.0.0",
    component: "agent",
    platform: "linux",
    arch: "amd64",
    url: "https://s3.example.com/agent-1.0.0",
    checksum: "b".repeat(64),
    size: 45000000,
    ...overrides,
  });

  return {
    manifest,
    signature: sign(null, Buffer.from(manifest, "utf8"), privateKey).toString(
      "base64",
    ),
    publicKey: rawPublicKey.toString("base64"),
  };
}

function makeSignedReleaseArtifactManifest(args: {
  assetName: string;
  checksum: string;
  size: number;
  release?: string;
}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPublicKey = publicDer.subarray(publicDer.length - 32);
  const manifest = JSON.stringify({
    schemaVersion: 1,
    repository: "LanternOps/breeze",
    release: args.release ?? "v1.0.0",
    assets: [
      {
        name: args.assetName,
        sha256: args.checksum,
        size: args.size,
        platformTrust:
          requiredPlatformTrustFor(args.assetName) ??
          "release-workflow-produced",
      },
    ],
  });

  return {
    manifest,
    signature: sign(null, Buffer.from(manifest, "utf8"), privateKey).toString(
      "base64",
    ),
    publicKey: rawPublicKey.toString("base64"),
  };
}

// POST /agent-versions now requires a signed release manifest (issue #3544).
// With no trust roots configured (the default in this suite — no env keys,
// getActivePublicKeys mocked to []), verifyEd25519ManifestSignature soft-
// passes any signature string, so tests only need the manifest's metadata
// fields to exactly match the submitted payload. Reuses the exact-match
// contract from validateReleaseManifest's non-schemaVersion-1 branch.
function withValidManifest(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const manifest = JSON.stringify({
    version: payload.version,
    component: payload.component ?? "agent",
    platform: payload.platform,
    arch: payload.architecture,
    url: payload.downloadUrl,
    checksum: payload.checksum,
  });
  return {
    ...payload,
    releaseManifest: manifest,
    manifestSignature: "test-signature",
  };
}

// Same idea for POST /agent-versions/promote's target-row select mock: the
// row shape validateReleaseManifest needs (downloadUrl/checksum/manifest/
// signature) plus a manifest whose fields match the row exactly.
function makeValidatedTargetRow(row: {
  component: string;
  platform: string;
  architecture: string;
  version: string;
}) {
  const downloadUrl = `https://s3.example.com/${row.component}-${row.version}`;
  const checksum = "f".repeat(64);
  const manifest = JSON.stringify({
    version: row.version,
    component: row.component,
    platform: row.platform,
    arch: row.architecture,
    url: downloadUrl,
    checksum,
  });
  return {
    ...row,
    downloadUrl,
    checksum,
    fileSize: null,
    releaseManifest: manifest,
    manifestSignature: "test-signature",
  };
}

describe("agentVersions routes", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks clears calls but KEEPS implementations, so a
    // mockResolvedValue set by one backup-guard test would leak into every
    // later one and silently stop it exercising the branch its name claims.
    vi.mocked(getPromotedComponentVersion).mockReset();
    vi.mocked(getPromotedComponentVersion).mockResolvedValue(null);
    platformAdminState.allow = true;
    delete process.env.AGENT_UPDATE_MANIFEST_PUBLIC_KEYS;
    delete process.env.BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS;
    delete process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
    delete process.env.BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
    delete process.env.BINARY_EDITION;
    app = new Hono();
    // Inject mock auth context
    app.use(async (c: any, next: any) => {
      c.set("auth", {
        user: { id: "admin-1" },
        orgId: "org-1",
        scope: "system",
      });
      await next();
    });
    app.route("/agent-versions", agentVersionRoutes);
  });

  // Helper: build a db.select chain that resolves to `rows` for a single
  // .from().where() lookup, and a configurable one for the promote endpoint's
  // multiple sequential selects.
  function selectResolving(rows: unknown[]) {
    // `where()` must be awaitable on its own (the promote target-rows query has
    // no .limit()) AND expose .limit() (the in-tx "current isLatest" lookup)
    // AND expose .orderBy() (the edition-scoped /pinnable query).
    const whereResult: any = Promise.resolve(rows);
    whereResult.limit = vi.fn().mockResolvedValue(rows);
    whereResult.orderBy = vi.fn().mockResolvedValue(rows);
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(whereResult),
        orderBy: vi.fn().mockResolvedValue(rows),
      }),
    };
  }

  describe("POST /agent-versions/sync-github — guard-refusal classification (#4262)", () => {
    it("answers 502 and does NOT leak the resolved internal address", async () => {
      // The refusal message and .resolvedIps both name internal addresses.
      // Pre-#4262 the raw err.message was echoed straight into the body; the
      // route must now return a fixed operator-facing string instead. This is
      // the assertion most at risk of being silently refactored away, because
      // "just echo the error" reads like an improvement.
      vi.mocked(syncFromGitHub).mockRejectedValue(
        new SsrfBlockedError(
          "all resolved IPs for api.github.com are private/loopback/link-local",
          { hostname: "api.github.com", resolvedIps: ["10.1.2.3", "169.254.169.254"] },
        ),
      );

      const res = await app.request("/agent-versions/sync-github", {
        method: "POST",
      });

      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/private or link-local/i);
      // The whole point: no internal address reaches the client.
      expect(body.error).not.toMatch(/10\.1\.2\.3|169\.254\.169\.254/);
      // …but it IS escalated server-side, since the catch otherwise loses it.
      expect(vi.mocked(captureException)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(captureException).mock.calls[0]?.[2]).toMatchObject({
        release_sync_failure_reason: "ssrf-blocked",
      });
    });

    it("answers 502 on a body-ceiling abort", async () => {
      vi.mocked(syncFromGitHub).mockRejectedValue(
        new ResponseTooLargeError(1024 * 1024),
      );

      const res = await app.request("/agent-versions/sync-github", {
        method: "POST",
      });

      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/1048576-byte limit/);
      expect(vi.mocked(captureException).mock.calls[0]?.[2]).toMatchObject({
        release_sync_failure_reason: "response-too-large",
      });
    });

    it("leaves the pre-existing generic classification alone", async () => {
      // Guards against over-reach: a plain failure must still take the original
      // 422 path, not be swept into the new 502 branches.
      vi.mocked(syncFromGitHub).mockRejectedValue(
        new Error("something mundane broke"),
      );

      const res = await app.request("/agent-versions/sync-github", {
        method: "POST",
      });

      expect(res.status).toBe(422);
      expect((await res.json() as { error: string }).error).toBe(
        "something mundane broke",
      );
      expect(vi.mocked(captureException)).not.toHaveBeenCalled();
    });
  });

  describe("GET /agent-versions (platform-admin list)", () => {
    it("non-platform-admin → 403", async () => {
      platformAdminState.allow = false;
      const res = await app.request("/agent-versions");
      expect(res.status).toBe(403);
    });

    it("lists registered versions and the promoted set", async () => {
      vi.mocked(db.select).mockReturnValue(
        selectResolving([
          {
            id: "v1",
            version: "0.70.0",
            platform: "linux",
            architecture: "amd64",
            component: "agent",
            isLatest: true,
            fileSize: BigInt(100),
            releaseNotes: null,
            createdAt: new Date("2026-06-20"),
          },
          {
            id: "v2",
            version: "0.71.0",
            platform: "linux",
            architecture: "amd64",
            component: "agent",
            isLatest: false,
            fileSize: BigInt(200),
            releaseNotes: null,
            createdAt: new Date("2026-06-22"),
          },
        ]) as any,
      );

      const res = await app.request("/agent-versions");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.versions).toHaveLength(2);
      // fileSize serialized to number.
      expect(body.versions[0].fileSize).toBe(100);
      // promoted map only includes the isLatest row.
      expect(body.promoted).toEqual([
        {
          component: "agent",
          platform: "linux",
          architecture: "amd64",
          version: "0.70.0",
        },
      ]);
    });
  });

  describe("GET /agent-versions/pinnable (#2124)", () => {
    it("returns distinct agent + watchdog versions and the promoted set, excluding non-pinnable components", async () => {
      vi.mocked(db.select).mockReturnValue(
        selectResolving([
          // newest-first order (createdAt desc) drives dedupe
          { version: "0.88.0", component: "agent", isLatest: true },
          { version: "0.88.0", component: "agent", isLatest: true }, // dupe (other arch)
          { version: "0.87.0", component: "agent", isLatest: false },
          { version: "0.88.0", component: "watchdog", isLatest: true },
          { version: "0.50.0", component: "helper", isLatest: true }, // NOT pinnable
        ]) as any,
      );

      const res = await app.request("/agent-versions/pinnable");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.components.agent.versions).toEqual(["0.88.0", "0.87.0"]);
      expect(body.components.agent.promoted).toEqual(["0.88.0"]);
      expect(body.components.watchdog.versions).toEqual(["0.88.0"]);
      expect(body.components.watchdog.promoted).toEqual(["0.88.0"]);
      // helper is not a pinnable component → absent from the response entirely.
      expect(body.components).not.toHaveProperty("helper");
    });
  });

  describe("POST /agent-versions/promote", () => {
    // Build a fake transaction whose tx.select/tx.update record calls so we can
    // assert demote-then-promote happened. `priorByTuple` controls what the
    // "current isLatest" lookup returns inside the tx.
    function makeTx(prior: { version: string } | undefined) {
      const updateSet = vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });
      const txUpdate = vi.fn().mockReturnValue({ set: updateSet });
      const txSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(prior ? [prior] : []),
          }),
        }),
      });
      return { tx: { update: txUpdate, select: txSelect }, updateSet, txUpdate };
    }

    it("non-platform-admin → 403", async () => {
      platformAdminState.allow = false;
      const res = await app.request("/agent-versions/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: "0.71.0" }),
      });
      expect(res.status).toBe(403);
    });

    it("404 when the version has no registered rows", async () => {
      vi.mocked(db.select).mockReturnValue(selectResolving([]) as any);

      const res = await app.request("/agent-versions/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: "9.9.9" }),
      });
      expect(res.status).toBe(404);
    });

    it("promotes all components of a version atomically (demote old + promote new) and audits", async () => {
      // The pre-tx target-rows lookup: two components on the same platform/arch.
      vi.mocked(db.select).mockReturnValue(
        selectResolving([
          makeValidatedTargetRow({ component: "agent", platform: "linux", architecture: "amd64", version: "0.71.0" }),
          makeValidatedTargetRow({ component: "watchdog", platform: "linux", architecture: "amd64", version: "0.71.0" }),
        ]) as any,
      );

      const { tx, txUpdate } = makeTx({ version: "0.70.0" });
      vi.mocked(db.transaction).mockImplementation(
        async (fn: any) => fn(tx) as any,
      );

      const res = await app.request("/agent-versions/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: "0.71.0" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      // Promoted both tuples.
      expect(body.promoted).toEqual(
        expect.arrayContaining([
          {
            component: "agent",
            platform: "linux",
            architecture: "amd64",
            version: "0.71.0",
          },
          {
            component: "watchdog",
            platform: "linux",
            architecture: "amd64",
            version: "0.71.0",
          },
        ]),
      );
      // Prior target recorded as demoted.
      expect(body.demoted).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ component: "agent", version: "0.70.0" }),
          expect.objectContaining({ component: "watchdog", version: "0.70.0" }),
        ]),
      );

      // Each tuple ran a demote UPDATE (isLatest:false) AND a promote UPDATE
      // (isLatest:true) → 2 tuples × 2 updates = 4 update calls.
      expect(txUpdate).toHaveBeenCalledTimes(4);

      // Audit row written for the promotion.
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "agent_version.promote",
          resourceName: "0.71.0",
          details: expect.objectContaining({
            version: "0.71.0",
            component: "all",
          }),
        }),
      );
    });

    it("promotes only the requested single component", async () => {
      vi.mocked(db.select).mockReturnValue(
        selectResolving([
          makeValidatedTargetRow({ component: "agent", platform: "linux", architecture: "amd64", version: "0.71.0" }),
        ]) as any,
      );

      const { tx, txUpdate } = makeTx({ version: "0.70.0" });
      vi.mocked(db.transaction).mockImplementation(
        async (fn: any) => fn(tx) as any,
      );

      const res = await app.request("/agent-versions/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: "0.71.0", component: "agent" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.promoted).toEqual([
        {
          component: "agent",
          platform: "linux",
          architecture: "amd64",
          version: "0.71.0",
        },
      ]);
      // One tuple → demote + promote = 2 update calls.
      expect(txUpdate).toHaveBeenCalledTimes(2);
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          details: expect.objectContaining({ component: "agent" }),
        }),
      );
    });

    it("scopes the target-rows lookup and the tx demote/promote to this server's edition", async () => {
      process.env.BINARY_EDITION = "hosted";

      const targetRowsWhere = vi.fn().mockResolvedValue([
        makeValidatedTargetRow({ component: "agent", platform: "linux", architecture: "amd64", version: "0.71.0" }),
      ]);
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({ where: targetRowsWhere }),
      } as any);

      const { tx, txUpdate, updateSet } = makeTx({ version: "0.70.0" });
      vi.mocked(db.transaction).mockImplementation(
        async (fn: any) => fn(tx) as any,
      );

      const res = await app.request("/agent-versions/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: "0.71.0", component: "agent" }),
      });
      delete process.env.BINARY_EDITION;

      expect(res.status).toBe(200);
      // Pre-tx target-rows lookup scoped to edition=hosted.
      const targetRowsWhereArg = targetRowsWhere.mock.calls[0]?.[0];
      expect(hasEditionClause(targetRowsWhereArg, "hosted")).toBe(true);

      // In-tx demote (.set({isLatest:false}).where(...)) and promote
      // (.set({isLatest:true}).where(...)) share the same mocked `where` fn
      // (makeTx's updateSet always returns the same object) — both calls
      // must carry the edition scope.
      expect(txUpdate).toHaveBeenCalledTimes(2);
      const sharedWhereMock = updateSet.mock.results[0]?.value.where;
      expect(sharedWhereMock.mock.calls.length).toBe(2);
      for (const call of sharedWhereMock.mock.calls) {
        expect(hasEditionClause(call[0], "hosted")).toBe(true);
      }
    });

    // breeze-backup's version is slaved to the agent's (it has no separate
    // pin — see agentVersionPins.ts, deliberately agent+watchdog only), so
    // its is_latest must stay in lockstep with whatever the fleet promotes
    // to. The target-rows lookup when `component` is omitted has no
    // component filter at all (`eq(agentVersions.version, version)`), so it
    // was already generic — this proves backup rows ride along rather than
    // needing a hardcoded component list.
    it("promoting with component omitted includes backup rows alongside agent/watchdog", async () => {
      vi.mocked(db.select).mockReturnValue(
        selectResolving([
          makeValidatedTargetRow({ component: "agent", platform: "linux", architecture: "amd64", version: "0.71.0" }),
          makeValidatedTargetRow({ component: "watchdog", platform: "linux", architecture: "amd64", version: "0.71.0" }),
          makeValidatedTargetRow({ component: "backup", platform: "linux", architecture: "amd64", version: "0.71.0" }),
        ]) as any,
      );

      const { tx } = makeTx({ version: "0.70.0" });
      vi.mocked(db.transaction).mockImplementation(
        async (fn: any) => fn(tx) as any,
      );

      const res = await app.request("/agent-versions/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: "0.71.0" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.promoted).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ component: "backup", version: "0.71.0" }),
        ]),
      );
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          details: expect.objectContaining({
            components: expect.arrayContaining(["backup"]),
          }),
        }),
      );
    });

    // Regression coverage for issue #3544: promote must refuse a target row
    // that GET /:version/download would itself reject, BEFORE the demotion
    // transaction runs — otherwise the fleet's currently-working upgrade
    // target gets stripped on behalf of a promotion that's about to fail.
    it("409s with signed_release_manifest_required when a target row has a NULL release manifest, and never runs the demotion transaction", async () => {
      vi.mocked(db.select).mockReturnValue(
        selectResolving([
          {
            component: "agent",
            platform: "linux",
            architecture: "amd64",
            version: "0.71.0",
            downloadUrl: "https://s3.example.com/agent-0.71.0",
            checksum: "f".repeat(64),
            fileSize: null,
            releaseManifest: null,
            manifestSignature: null,
          },
        ]) as any,
      );

      const res = await app.request("/agent-versions/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: "0.71.0", component: "agent" }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe("Release manifest is not trusted");
      expect(body.reason).toBe("signed_release_manifest_required");
      expect(body.invalidTargets).toEqual([
        {
          component: "agent",
          platform: "linux",
          architecture: "amd64",
          reason: "signed_release_manifest_required",
        },
      ]);
      // The demotion/promotion transaction never ran — the previously
      // promoted row for this slot is untouched.
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it("409s when only SOME target rows fail validation — any failure rejects the whole promotion, never a partial one", async () => {
      vi.mocked(db.select).mockReturnValue(
        selectResolving([
          makeValidatedTargetRow({ component: "agent", platform: "linux", architecture: "amd64", version: "0.71.0" }),
          {
            component: "watchdog",
            platform: "linux",
            architecture: "amd64",
            version: "0.71.0",
            downloadUrl: "https://s3.example.com/watchdog-0.71.0",
            checksum: "f".repeat(64),
            fileSize: null,
            releaseManifest: null,
            manifestSignature: null,
          },
        ]) as any,
      );

      const res = await app.request("/agent-versions/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: "0.71.0" }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.reason).toBe("signed_release_manifest_required");
      expect(body.invalidTargets).toEqual([
        expect.objectContaining({ component: "watchdog", reason: "signed_release_manifest_required" }),
      ]);
      // Even the valid "agent" slot must not be promoted — the whole
      // operation is atomic across its target rows.
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it("still succeeds when every target row carries a valid signed manifest (happy-path regression guard)", async () => {
      vi.mocked(db.select).mockReturnValue(
        selectResolving([
          makeValidatedTargetRow({ component: "agent", platform: "linux", architecture: "amd64", version: "0.71.0" }),
          makeValidatedTargetRow({ component: "watchdog", platform: "linux", architecture: "amd64", version: "0.71.0" }),
        ]) as any,
      );

      const { tx } = makeTx({ version: "0.70.0" });
      vi.mocked(db.transaction).mockImplementation(
        async (fn: any) => fn(tx) as any,
      );

      const res = await app.request("/agent-versions/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: "0.71.0" }),
      });

      expect(res.status).toBe(200);
      expect(db.transaction).toHaveBeenCalled();
      const body = await res.json();
      expect(body.promoted).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ component: "agent", version: "0.71.0" }),
          expect.objectContaining({ component: "watchdog", version: "0.71.0" }),
        ]),
      );
    });
  });

  describe("GET /agent-versions/latest", () => {
    it("should return latest version for platform/arch", async () => {
      const rows = [
        {
          version: "1.2.0",
          downloadUrl: "https://s3.example.com/agent-1.2.0-linux-amd64",
          checksum: "a".repeat(64),
          releaseManifest: null,
          manifestSignature: null,
          signingKeyId: null,
          fileSize: BigInt(45000000),
          releaseNotes: "Bug fixes",
        },
      ];
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          // .orderBy() is the created_at tiebreak that keeps this endpoint in
          // lockstep with services/promotedAgentVersion.ts (#3499).
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(rows),
            }),
          }),
        }),
      } as any);

      const res = await app.request(
        "/agent-versions/latest?platform=linux&arch=amd64",
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.version).toBe("1.2.0");
      expect(body.downloadUrl).toContain("agent-1.2.0");
      expect(body.checksum).toBe("a".repeat(64));
      expect(body.fileSize).toBe(45000000);
      expect(body.releaseNotes).toBe("Bug fixes");
    });

    it("orders by created_at DESC, matching the resolver that serves the bytes (#3499)", async () => {
      // This endpoint hands out the checksum; services/promotedAgentVersion.ts
      // resolves the bytes it is verified against. Nothing in the schema
      // enforces one isLatest row per (component, platform, arch, edition) —
      // the invariant is demote-then-insert, not a unique constraint. If only
      // one of the two ordered, a duplicate promoted row would make them
      // select DIFFERENT rows: a checksum for a release the download route
      // does not serve, silently. That is #3499 again.
      const orderByMock = vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ orderBy: orderByMock }),
        }),
      } as any);

      await app.request("/agent-versions/latest?platform=linux&arch=amd64");

      expect(orderByMock).toHaveBeenCalledTimes(1);
    });

    it("should return 404 when no version exists", async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as any);

      const res = await app.request(
        "/agent-versions/latest?platform=linux&arch=arm64",
      );

      expect(res.status).toBe(404);
    });

    it("scopes the lookup to this server's own edition (default self-host)", async () => {
      const whereMock = vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({ where: whereMock }),
      } as any);

      delete process.env.BINARY_EDITION;
      await app.request("/agent-versions/latest?platform=linux&arch=amd64");

      const whereArg = whereMock.mock.calls[0]?.[0];
      expect(hasEditionClause(whereArg, "self-host")).toBe(true);
    });

    it("scopes the lookup to BINARY_EDITION=hosted when configured", async () => {
      const whereMock = vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      });
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({ where: whereMock }),
      } as any);

      process.env.BINARY_EDITION = "hosted";
      await app.request("/agent-versions/latest?platform=linux&arch=amd64");
      delete process.env.BINARY_EDITION;

      const whereArg = whereMock.mock.calls[0]?.[0];
      expect(hasEditionClause(whereArg, "hosted")).toBe(true);
    });

    it("should reject invalid platform", async () => {
      const res = await app.request(
        "/agent-versions/latest?platform=bsd&arch=amd64",
      );

      expect(res.status).toBe(400);
    });

    it("should reject missing query params", async () => {
      const res = await app.request("/agent-versions/latest");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /agent-versions/:version/download", () => {
    it("should return JSON with download URL and checksum", async () => {
      const checksum = "b".repeat(64);
      const signed = makeSignedReleaseManifest();

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "1.0.0",
                platform: "linux",
                architecture: "amd64",
                component: "agent",
                downloadUrl: "https://s3.example.com/agent-1.0.0",
                checksum,
                fileSize: BigInt(45000000),
                releaseManifest: signed.manifest,
                manifestSignature: signed.signature,
                signingKeyId: "test-key",
              },
            ]),
          }),
        }),
      } as any);

      const res = await app.request(
        "/agent-versions/1.0.0/download?platform=linux&arch=amd64",
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toBe("https://s3.example.com/agent-1.0.0");
      expect(body.checksum).toBe(checksum);
      expect(body.manifest).toBe(signed.manifest);
      expect(body.manifestSignature).toBe(signed.signature);
    });

    it("rejects tampered release manifests when a trust root is configured", async () => {
      const signed = makeSignedReleaseManifest();
      process.env.AGENT_UPDATE_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "1.0.0",
                platform: "linux",
                architecture: "amd64",
                component: "agent",
                downloadUrl: "https://s3.example.com/agent-1.0.0",
                checksum: "c".repeat(64),
                fileSize: BigInt(45000000),
                releaseManifest: signed.manifest,
                manifestSignature: signed.signature,
                signingKeyId: "test-key",
              },
            ]),
          }),
        }),
      } as any);

      const res = await app.request(
        "/agent-versions/1.0.0/download?platform=linux&arch=amd64",
      );

      delete process.env.AGENT_UPDATE_MANIFEST_PUBLIC_KEYS;

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.reason).toBe("release_manifest_metadata_mismatch");
    });

    it("rejects with invalid_release_manifest_signature when signature is fabricated (#641 — signature checked before metadata)", async () => {
      // A trust root is configured (so the signature path actually runs),
      // but the supplied signature is all zeros. Even though the manifest
      // metadata would mismatch the DB row, the route MUST return
      // `invalid_release_manifest_signature` first so we never leak the
      // more specific metadata-mismatch reason to an attacker who never
      // held a valid signing key.
      const signed = makeSignedReleaseManifest();
      process.env.AGENT_UPDATE_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      const fabricatedSignature = Buffer.alloc(64, 0).toString("base64");

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "1.0.0",
                platform: "linux",
                architecture: "amd64",
                component: "agent",
                downloadUrl: "https://s3.example.com/agent-1.0.0",
                // Metadata that would mismatch the manifest body — but we
                // should never get far enough to learn that.
                checksum: "c".repeat(64),
                fileSize: BigInt(45000000),
                releaseManifest: signed.manifest,
                manifestSignature: fabricatedSignature,
                signingKeyId: "test-key",
              },
            ]),
          }),
        }),
      } as any);

      const res = await app.request(
        "/agent-versions/1.0.0/download?platform=linux&arch=amd64",
      );

      delete process.env.AGENT_UPDATE_MANIFEST_PUBLIC_KEYS;

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.reason).toBe("invalid_release_manifest_signature");
    });

    it("serves GitHub release artifact manifests after verifying the signed asset checksum", async () => {
      const checksum = "e".repeat(64);
      const signed = makeSignedReleaseArtifactManifest({
        assetName: "breeze-agent-linux-amd64",
        checksum,
        size: 1234,
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "1.0.0",
                platform: "linux",
                architecture: "amd64",
                component: "agent",
                downloadUrl:
                  "https://github.com/LanternOps/breeze/releases/download/v1.0.0/breeze-agent-linux-amd64",
                checksum,
                fileSize: BigInt(1234),
                releaseManifest: signed.manifest,
                manifestSignature: signed.signature,
                signingKeyId: "release-artifact-manifest-ed25519",
              },
            ]),
          }),
        }),
      } as any);

      const res = await app.request(
        "/agent-versions/1.0.0/download?platform=linux&arch=amd64",
      );

      delete process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.checksum).toBe(checksum);
      expect(body.manifest).toBe(signed.manifest);
      expect(body.manifestSignature).toBe(signed.signature);
    });

    it("rewrites downloadUrl to server-relative when PUBLIC_API_URL is set (#646 — hosted SaaS auto-update fix)", async () => {
      const checksum = "b".repeat(64);
      const signed = makeSignedReleaseManifest({
        platform: "windows",
        arch: "amd64",
        url: "https://github.com/LanternOps/breeze/releases/download/v1.0.0/breeze-agent-windows-amd64.exe",
        checksum,
        size: 1234,
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "1.0.0",
                platform: "windows",
                architecture: "amd64",
                component: "agent",
                downloadUrl:
                  "https://github.com/LanternOps/breeze/releases/download/v1.0.0/breeze-agent-windows-amd64.exe",
                checksum,
                fileSize: BigInt(1234),
                releaseManifest: signed.manifest,
                manifestSignature: signed.signature,
                signingKeyId: "test-key",
              },
            ]),
          }),
        }),
      } as any);

      process.env.PUBLIC_API_URL = "https://us.example.com";
      try {
        const res = await app.request(
          "/agent-versions/1.0.0/download?platform=windows&arch=amd64",
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        // Server-relative URL so the agent's downloadFromURL host check
        // passes. The actual binary is served via /agents/download/:os/:arch
        // (which 302s to github in BINARY_SOURCE=github mode).
        expect(body.url).toBe(
          "https://us.example.com/api/v1/agents/download/windows/amd64",
        );
        expect(body.checksum).toBe(checksum);
        // Manifest stays unmodified — its url field still references the
        // canonical github URL. The agent (v0.65.10+) accepts the mismatch
        // because checksum is the trust binding.
        expect(body.manifest).toBe(signed.manifest);
      } finally {
        delete process.env.PUBLIC_API_URL;
      }
    });

    it("rewrites user-helper downloadUrl to the server-relative user-helper route (#1878 — sibling of #646)", async () => {
      const checksum = "c".repeat(64);
      const signed = makeSignedReleaseManifest({
        component: "user-helper",
        platform: "windows",
        arch: "amd64",
        url: "https://github.com/LanternOps/breeze/releases/download/v1.0.0/breeze-user-helper-windows-amd64.exe",
        checksum,
        size: 1234,
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "1.0.0",
                platform: "windows",
                architecture: "amd64",
                component: "user-helper",
                downloadUrl:
                  "https://github.com/LanternOps/breeze/releases/download/v1.0.0/breeze-user-helper-windows-amd64.exe",
                checksum,
                fileSize: BigInt(1234),
                releaseManifest: signed.manifest,
                manifestSignature: signed.signature,
                signingKeyId: "test-key",
              },
            ]),
          }),
        }),
      } as any);

      process.env.PUBLIC_API_URL = "https://us.example.com";
      try {
        const res = await app.request(
          "/agent-versions/1.0.0/download?platform=windows&arch=amd64&component=user-helper",
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        // The bug (#1878): user-helper fell through to null in
        // buildServerRelativeAgentDownloadUrl, so the response handed back the
        // canonical github.com asset URL — which the agent's host-equality check
        // rejects. It must resolve to the user-helper route, which is distinct
        // from the Tauri /helper app route.
        expect(body.url).toBe(
          "https://us.example.com/api/v1/agents/download/user-helper/windows/amd64",
        );
        expect(body.url).not.toContain("github.com");
        expect(body.checksum).toBe(checksum);
      } finally {
        delete process.env.PUBLIC_API_URL;
      }
    });

    it("maps platform=macos to /darwin in the server-relative URL", async () => {
      const checksum = "b".repeat(64);
      const signed = makeSignedReleaseManifest({
        platform: "macos",
        arch: "arm64",
        url: "https://github.com/LanternOps/breeze/releases/download/v1.0.0/breeze-agent-darwin-arm64",
        checksum,
        size: 1234,
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "1.0.0",
                platform: "macos",
                architecture: "arm64",
                component: "agent",
                downloadUrl:
                  "https://github.com/LanternOps/breeze/releases/download/v1.0.0/breeze-agent-darwin-arm64",
                checksum,
                fileSize: BigInt(1234),
                releaseManifest: signed.manifest,
                manifestSignature: signed.signature,
                signingKeyId: "test-key",
              },
            ]),
          }),
        }),
      } as any);

      process.env.PUBLIC_API_URL = "https://us.example.com";
      try {
        const res = await app.request(
          "/agent-versions/1.0.0/download?platform=darwin&arch=arm64",
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.url).toBe(
          "https://us.example.com/api/v1/agents/download/darwin/arm64",
        );
      } finally {
        delete process.env.PUBLIC_API_URL;
      }
    });

    it("rewrites downloadUrl to server-relative for component=helper (helper RCE fix: keep verified download on the trusted control-plane origin)", async () => {
      const canonical =
        "https://github.com/LanternOps/breeze/releases/download/v1.0.0/breeze-helper-windows.msi";
      const checksum = "b".repeat(64);
      const signed = makeSignedReleaseManifest({
        component: "helper",
        platform: "windows",
        arch: "amd64",
        url: canonical,
        checksum,
        size: 1234,
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "1.0.0",
                platform: "windows",
                architecture: "amd64",
                component: "helper",
                downloadUrl: canonical,
                checksum,
                fileSize: BigInt(1234),
                releaseManifest: signed.manifest,
                manifestSignature: signed.signature,
                signingKeyId: "test-key",
              },
            ]),
          }),
        }),
      } as any);

      process.env.PUBLIC_API_URL = "https://us.example.com";
      try {
        const res = await app.request(
          "/agent-versions/1.0.0/download?platform=windows&arch=amd64&component=helper",
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        // Server-relative so the agent's verified downloader (host==ServerURL)
        // accepts it; the /agents/download/helper/:os/:arch route 302s to github
        // server-side, and the signed-manifest SHA-256 binds the bytes.
        expect(body.url).toBe(
          "https://us.example.com/api/v1/agents/download/helper/windows/amd64",
        );
        // Manifest is unmodified; its url field still references the canonical
        // github asset. Checksum is the trust binding.
        expect(body.checksum).toBe(checksum);
        expect(body.manifest).toBe(signed.manifest);
      } finally {
        delete process.env.PUBLIC_API_URL;
      }
    });

    it("rewrites downloadUrl to server-relative for component=watchdog (so the agent host-match guard accepts the watchdog download)", async () => {
      const canonical =
        "https://github.com/LanternOps/breeze/releases/download/v1.0.0/breeze-watchdog-linux-amd64";
      const checksum = "c".repeat(64);
      const signed = makeSignedReleaseManifest({
        component: "watchdog",
        platform: "linux",
        arch: "amd64",
        url: canonical,
        checksum,
        size: 2048,
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "1.0.0",
                platform: "linux",
                architecture: "amd64",
                component: "watchdog",
                downloadUrl: canonical,
                checksum,
                fileSize: BigInt(2048),
                releaseManifest: signed.manifest,
                manifestSignature: signed.signature,
                signingKeyId: "test-key",
              },
            ]),
          }),
        }),
      } as any);

      process.env.PUBLIC_API_URL = "https://us.example.com";
      try {
        const res = await app.request(
          "/agent-versions/1.0.0/download?platform=linux&arch=amd64&component=watchdog",
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.url).toBe(
          "https://us.example.com/api/v1/agents/download/watchdog/linux/amd64",
        );
        expect(body.checksum).toBe(checksum);
        expect(body.manifest).toBe(signed.manifest);
      } finally {
        delete process.env.PUBLIC_API_URL;
      }
    });

    it("rewrites downloadUrl to server-relative for component=backup when the row IS the server's current version (and implicitly proves componentEnum accepts \"backup\" — an unrecognized value would 400 before reaching this handler)", async () => {
      const canonical =
        "https://github.com/LanternOps/breeze/releases/download/v1.0.0/breeze-backup-linux-amd64";
      const checksum = "c".repeat(64);
      const signed = makeSignedReleaseManifest({
        component: "backup",
        platform: "linux",
        arch: "amd64",
        url: canonical,
        checksum,
        size: 2048,
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "1.0.0",
                platform: "linux",
                architecture: "amd64",
                component: "backup",
                downloadUrl: canonical,
                checksum,
                fileSize: BigInt(2048),
                releaseManifest: signed.manifest,
                manifestSignature: signed.signature,
                signingKeyId: "test-key",
                isLatest: true,
              },
            ]),
          }),
        }),
      } as any);

      process.env.PUBLIC_API_URL = "https://us.example.com";
      process.env.BINARY_VERSION = "1.0.0";
      try {
        const res = await app.request(
          "/agent-versions/1.0.0/download?platform=linux&arch=amd64&component=backup",
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.url).toBe(
          "https://us.example.com/api/v1/agents/download/backup/linux/amd64",
        );
        expect(body.checksum).toBe(checksum);
        expect(body.manifest).toBe(signed.manifest);
      } finally {
        delete process.env.PUBLIC_API_URL;
        delete process.env.BINARY_VERSION;
      }
    });

    // #3499 inverted this case. The versionless /download/backup/:os/:arch
    // route used to serve the server's env version (BINARY_VERSION), so a
    // promoted row that the env had moved past was NOT servable by it and the
    // rewrite had to be withheld — the guard tested the env version and
    // isLatest was explicitly not sufficient. The route now serves the
    // promoted row, so this row IS exactly what it serves and the rewrite is
    // correct. This is the deploy-to-promote window (AGENT_AUTO_PROMOTE=false,
    // server on 1.1.0, fleet still promoted to 1.0.0) that used to hand out
    // mismatched bytes. The guard no longer restates either rule: it asks the
    // route's own resolver what will be served and compares.
    it("rewrites component=backup when the row IS the promoted isLatest row, even though the server's env version has moved ahead (#3499)", async () => {
      const canonical =
        "https://github.com/LanternOps/breeze/releases/download/v1.0.0/breeze-backup-linux-amd64";
      const checksum = "f".repeat(64);
      const signed = makeSignedReleaseManifest({
        component: "backup",
        platform: "linux",
        arch: "amd64",
        url: canonical,
        checksum,
        size: 2048,
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "1.0.0",
                platform: "linux",
                architecture: "amd64",
                component: "backup",
                downloadUrl: canonical,
                checksum,
                fileSize: BigInt(2048),
                releaseManifest: signed.manifest,
                manifestSignature: signed.signature,
                signingKeyId: "test-key",
                // Promoted in the DB even though the server has already
                // deployed a newer version (AGENT_AUTO_PROMOTE=false, so
                // 1.1.0 is not the fleet target yet). Since #3499 the
                // versionless route resolves this promoted row, so it serves
                // exactly these bytes — rewrite is correct.
                isLatest: true,
              },
            ]),
          }),
        }),
      } as any);

      // The versionless route resolves the promoted row — this one — even
      // though the server's own env version has moved ahead to 1.1.0.
      vi.mocked(getPromotedComponentVersion).mockResolvedValue("1.0.0");

      process.env.PUBLIC_API_URL = "https://us.example.com";
      process.env.BINARY_VERSION = "1.1.0";
      try {
        const res = await app.request(
          "/agent-versions/1.0.0/download?platform=linux&arch=amd64&component=backup",
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        // Server-relative versionless route: it now resolves this same
        // promoted row, so the bytes it serves match this row's checksum.
        expect(body.url).toBe(
          "https://us.example.com/api/v1/agents/download/backup/linux/amd64",
        );
        expect(body.checksum).toBe(checksum);
      } finally {
        delete process.env.PUBLIC_API_URL;
        delete process.env.BINARY_VERSION;
      }
    });

    // Design: breeze-backup's version is slaved to the agent's, and agents
    // request it by EXACT version. buildServerRelativeAgentDownloadUrl points
    // at the versionless /download/backup/:os/:arch route, which can only ever
    // serve ONE release — since #3499, the promoted (isLatest) row. Rewriting
    // a non-promoted backup version to that route would silently hand the
    // agent DIFFERENT bytes than the version it pinned — the updater's
    // checksum/manifest check then (correctly) rejects them, and the agent
    // can never heal. So the rewrite must be gated to rows the versionless
    // route would actually serve.
    it("does NOT rewrite component=backup when the row is neither promoted nor the server's current version — returns the stored immutable URL untouched", async () => {
      const canonical =
        "https://github.com/LanternOps/breeze/releases/download/v0.90.0/breeze-backup-linux-amd64";
      const checksum = "d".repeat(64);
      const signed = makeSignedReleaseManifest({
        component: "backup",
        platform: "linux",
        arch: "amd64",
        version: "0.90.0",
        url: canonical,
        checksum,
        size: 2048,
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "0.90.0",
                platform: "linux",
                architecture: "amd64",
                component: "backup",
                downloadUrl: canonical,
                checksum,
                fileSize: BigInt(2048),
                releaseManifest: signed.manifest,
                manifestSignature: signed.signature,
                signingKeyId: "test-key",
                isLatest: false,
              },
            ]),
          }),
        }),
      } as any);

      // Server currently considers a DIFFERENT version current — the
      // versionless route would serve that, not 0.90.0.
      process.env.PUBLIC_API_URL = "https://us.example.com";
      process.env.BINARY_VERSION = "1.0.0";
      try {
        const res = await app.request(
          "/agent-versions/0.90.0/download?platform=linux&arch=amd64&component=backup",
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        // Stored canonical (immutable GitHub asset) URL, NOT the
        // server-relative versionless route.
        expect(body.url).toBe(canonical);
        expect(body.checksum).toBe(checksum);
      } finally {
        delete process.env.PUBLIC_API_URL;
        delete process.env.BINARY_VERSION;
      }
    });

    // The other half of the #3499 change. Once a row IS promoted, matching the
    // server's env version no longer makes a different row servable by the
    // versionless route — that route serves the promoted one. So a
    // non-promoted row keeps the stored immutable URL: the agent's
    // host-equality check refuses the canonical github URL and simply does not
    // heal, rather than downloading the promoted version's bytes against this
    // row's checksum.
    it("does NOT rewrite component=backup when the row merely matches the server's env version but another row is promoted (#3499)", async () => {
      const canonical =
        "https://github.com/LanternOps/breeze/releases/download/v1.0.0/breeze-backup-linux-amd64";
      const checksum = "e".repeat(64);
      const signed = makeSignedReleaseManifest({
        component: "backup",
        platform: "linux",
        arch: "amd64",
        url: canonical,
        checksum,
        size: 2048,
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "1.0.0",
                platform: "linux",
                architecture: "amd64",
                component: "backup",
                downloadUrl: canonical,
                checksum,
                fileSize: BigInt(2048),
                releaseManifest: signed.manifest,
                manifestSignature: signed.signature,
                signingKeyId: "test-key",
                // Matches BINARY_VERSION, but is NOT the promoted row — since
                // #3499 the versionless route serves whatever is promoted, not
                // this. Must NOT rewrite.
                isLatest: false,

              },
            ]),
          }),
        }),
      } as any);

      // 1.1.0 is promoted, so that — not this row — is what the versionless
      // route serves, even though this row matches BINARY_VERSION.
      vi.mocked(getPromotedComponentVersion).mockResolvedValue("1.1.0");

      process.env.PUBLIC_API_URL = "https://us.example.com";
      process.env.BINARY_VERSION = "1.0.0";
      try {
        const res = await app.request(
          "/agent-versions/1.0.0/download?platform=linux&arch=amd64&component=backup",
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        // Stored canonical (immutable GitHub asset) URL, NOT the
        // server-relative versionless route.
        expect(body.url).toBe(canonical);
        expect(body.checksum).toBe(checksum);
      } finally {
        delete process.env.PUBLIC_API_URL;
        delete process.env.BINARY_VERSION;
      }
    });

    // The guard must mirror the download route's BINARY_SOURCE branch, not
    // just its github half. In local mode that route streams ONE unversioned
    // file from disk/S3 whose version is the binaries-volume build — the env
    // version — and never consults the promoted row. Deriving the promoted row
    // here would withhold the rewrite (and cost a pointless query) whenever the
    // promoted row differs from the disk build, e.g. AGENT_AUTO_PROMOTE=false
    // or after a rollback via POST /agent-versions/promote, silently ending
    // backup self-heal for those deployments.
    it("compares against the env version in local mode, without consulting the promoted row", async () => {
      const canonical =
        "https://github.com/LanternOps/breeze/releases/download/v1.0.0/breeze-backup-linux-amd64";
      const checksum = "c".repeat(64);
      const signed = makeSignedReleaseManifest({
        component: "backup",
        platform: "linux",
        arch: "amd64",
        url: canonical,
        checksum,
        size: 2048,
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "1.0.0",
                platform: "linux",
                architecture: "amd64",
                component: "backup",
                downloadUrl: canonical,
                checksum,
                fileSize: BigInt(2048),
                releaseManifest: signed.manifest,
                manifestSignature: signed.signature,
                signingKeyId: "test-key",
                // Not promoted — 1.1.0 is. In github mode that would withhold
                // the rewrite; in local mode the disk build is what matters.
                isLatest: false,
              },
            ]),
          }),
        }),
      } as any);
      vi.mocked(getPromotedComponentVersion).mockResolvedValue("1.1.0");

      process.env.BINARY_SOURCE = "local";
      process.env.PUBLIC_API_URL = "https://us.example.com";
      process.env.BINARY_VERSION = "1.0.0";
      try {
        const res = await app.request(
          "/agent-versions/1.0.0/download?platform=linux&arch=amd64&component=backup",
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.url).toBe(
          "https://us.example.com/api/v1/agents/download/backup/linux/amd64",
        );
        expect(getPromotedComponentVersion).not.toHaveBeenCalled();
      } finally {
        delete process.env.BINARY_SOURCE;
        delete process.env.PUBLIC_API_URL;
        delete process.env.BINARY_VERSION;
      }
    });

    it("other components (agent) keep the unconditional rewrite regardless of isLatest — the backup guard does not affect them", async () => {
      const checksum = "b".repeat(64);
      const signed = makeSignedReleaseManifest();

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "1.0.0",
                platform: "linux",
                architecture: "amd64",
                component: "agent",
                downloadUrl: "https://s3.example.com/agent-1.0.0",
                checksum,
                fileSize: BigInt(45000000),
                releaseManifest: signed.manifest,
                manifestSignature: signed.signature,
                signingKeyId: "test-key",
                isLatest: false,
              },
            ]),
          }),
        }),
      } as any);

      process.env.PUBLIC_API_URL = "https://us.example.com";
      try {
        const res = await app.request(
          "/agent-versions/1.0.0/download?platform=linux&arch=amd64",
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.url).toBe(
          "https://us.example.com/api/v1/agents/download/linux/amd64",
        );
      } finally {
        delete process.env.PUBLIC_API_URL;
      }
    });

    it("rejects an unrecognized component value with 400 (componentEnum boundary)", async () => {
      const res = await app.request(
        "/agent-versions/1.0.0/download?platform=linux&arch=amd64&component=not-a-real-component",
      );
      expect(res.status).toBe(400);
    });

    it("maps platform=macos to /darwin in the server-relative helper URL", async () => {
      const canonical =
        "https://github.com/LanternOps/breeze/releases/download/v1.0.0/breeze-helper-macos.dmg";
      const checksum = "c".repeat(64);
      const signed = makeSignedReleaseManifest({
        component: "helper",
        platform: "macos",
        arch: "arm64",
        url: canonical,
        checksum,
        size: 1234,
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "1.0.0",
                platform: "macos",
                architecture: "arm64",
                component: "helper",
                downloadUrl: canonical,
                checksum,
                fileSize: BigInt(1234),
                releaseManifest: signed.manifest,
                manifestSignature: signed.signature,
                signingKeyId: "test-key",
              },
            ]),
          }),
        }),
      } as any);

      process.env.PUBLIC_API_URL = "https://us.example.com";
      try {
        const res = await app.request(
          "/agent-versions/1.0.0/download?platform=darwin&arch=arm64&component=helper",
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.url).toBe(
          "https://us.example.com/api/v1/agents/download/helper/darwin/arm64",
        );
      } finally {
        delete process.env.PUBLIC_API_URL;
      }
    });

    // Issue #816: the download route must serve a row for the new
    // component=user-helper value. Pre-fix the zod schema rejected this with
    // a 400 (component not in enum), which forced the agent to abort the
    // upgrade entirely instead of falling back to an agent-only swap.
    it("serves component=user-helper rows (#816)", async () => {
      const canonical =
        "https://github.com/LanternOps/breeze/releases/download/v1.0.0/breeze-user-helper-windows-amd64.exe";
      const checksum = "f".repeat(64);
      const signed = makeSignedReleaseArtifactManifest({
        assetName: "breeze-user-helper-windows-amd64.exe",
        checksum,
        size: 2048,
      });
      process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "1.0.0",
                platform: "windows",
                architecture: "amd64",
                component: "user-helper",
                downloadUrl: canonical,
                checksum,
                fileSize: BigInt(2048),
                releaseManifest: signed.manifest,
                manifestSignature: signed.signature,
                signingKeyId: "release-artifact-manifest-ed25519",
              },
            ]),
          }),
        }),
      } as any);

      try {
        const res = await app.request(
          "/agent-versions/1.0.0/download?platform=windows&arch=amd64&component=user-helper",
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        // user-helper is NOT routed through the server-relative proxy today
        // (the /agents/download/:os/:arch route is agent-only); the canonical
        // GitHub URL is returned as-is. See buildServerRelativeAgentDownloadUrl.
        expect(body.url).toBe(canonical);
        expect(body.checksum).toBe(checksum);
      } finally {
        delete process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
      }
    });

    it("should return 404 for unknown version", async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(
        "/agent-versions/99.0.0/download?platform=linux&arch=amd64",
      );

      expect(res.status).toBe(404);
    });

    // Issue #816 / PR #845: heartbeat.doUpgrade pre-downloads the user-helper
    // for in-place Windows upgrades and treats a 404 from this route as a
    // non-fatal "release predates #816, fall back to agent-only upgrade"
    // signal. This test pins the 404 contract for the (version, platform,
    // arch, component=user-helper) tuple that the agent's prefetchUserHelper
    // depends on. If the route ever started returning 200/400/500 here,
    // doUpgrade's fallback would break and we'd silently re-create the
    // #816 production failure.
    it("returns 404 when component=user-helper has no row (pins #845 agent fallback contract)", async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(
        "/agent-versions/1.0.0/download?platform=windows&arch=amd64&component=user-helper",
      );

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error?: string };
      // Body MUST include some error message — the agent treats this as
      // non-fatal, but droplet operators reading API logs need a human-
      // readable reason. Empty bodies make the failure invisible.
      expect(typeof body.error).toBe("string");
      expect(body.error?.length ?? 0).toBeGreaterThan(0);
    });
  });

  // The agent binds every release-manifest signature to the exact key ID the
  // API supplies (P1-UPD-001): an ID mismatch fails closed instead of falling
  // back to trying every trusted key. That makes signingKeyId load-bearing on
  // the download response — if it silently stops being emitted for a
  // component, every agent on that component drops to the compatibility path
  // (or, once require_manifest_signing_key_id is on, stops updating entirely).
  //
  // NOTE: there is no separate `/helper/download` or `/watchdog/download`
  // route — component is a query parameter on this one endpoint, and the agent
  // requests it that way (updater.downloadBinary). These three cases are the
  // per-component coverage those two route names were describing.
  describe("GET /agent-versions/:version/download — signingKeyId passthrough", () => {
    // Task 2 (#3836): the download path is now key-ID-aware, so each case
    // must configure trust that actually matches its claimed signingKeyId
    // (official ID -> RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS, deploy-* ->
    // the matching manifest_signing_keys row) for the manifest to verify —
    // exactly the binding this suite exists to prove is enforced.
    const cases = [
      {
        component: "agent",
        assetName: "breeze-agent-linux-amd64",
        signingKeyId: "release-artifact-manifest-ed25519",
        configureTrust: (signed: { publicKey: string }) => {
          process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
        },
      },
      {
        component: "helper",
        assetName: "breeze-helper-linux.AppImage",
        signingKeyId: "deploy-2026-07-23-helper",
        configureTrust: (signed: { publicKey: string }) => {
          vi.spyOn(manifestSigning, "getActiveTrustKeyset").mockResolvedValue([
            {
              keyId: "deploy-2026-07-23-helper",
              publicKeyB64: signed.publicKey,
              validFrom: new Date().toISOString(),
            },
          ]);
        },
      },
      {
        component: "watchdog",
        assetName: "breeze-watchdog-linux-amd64",
        signingKeyId: "release-artifact-manifest-ed25519",
        configureTrust: (signed: { publicKey: string }) => {
          process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;
        },
      },
    ];

    for (const tc of cases) {
      it(`returns signingKeyId for component=${tc.component}`, async () => {
        const canonical = `https://github.com/LanternOps/breeze/releases/download/v1.0.0/${tc.assetName}`;
        const checksum = "d".repeat(64);
        const signed = makeSignedReleaseManifest({
          component: tc.component,
          platform: "linux",
          arch: "amd64",
          url: canonical,
          checksum,
          size: 4096,
        });
        tc.configureTrust(signed);

        vi.mocked(db.select).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  version: "1.0.0",
                  platform: "linux",
                  architecture: "amd64",
                  component: tc.component,
                  downloadUrl: canonical,
                  checksum,
                  fileSize: BigInt(4096),
                  releaseManifest: signed.manifest,
                  manifestSignature: signed.signature,
                  signingKeyId: tc.signingKeyId,
                },
              ]),
            }),
          }),
        } as any);

        const res = await app.request(
          `/agent-versions/1.0.0/download?platform=linux&arch=amd64&component=${tc.component}`,
        );

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.signingKeyId).toBe(tc.signingKeyId);
        // The ID is only meaningful next to the manifest it names.
        expect(body.manifest).toBe(signed.manifest);
        expect(body.manifestSignature).toBe(signed.signature);
      });
    }

    // A row registered before signingKeyId existed (BINARY_SOURCE=local, or a
    // pre-upgrade sync) has a null key id. The response must carry that
    // through as an absent/null field rather than inventing one — the agent
    // treats "no id" as the compatibility path, and a fabricated id would fail
    // closed against a key it does not have.
    it("passes a null signingKeyId through rather than fabricating one", async () => {
      const checksum = "e".repeat(64);
      const signed = makeSignedReleaseManifest({ checksum });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                version: "1.0.0",
                platform: "linux",
                architecture: "amd64",
                component: "agent",
                downloadUrl: "https://s3.example.com/agent-1.0.0",
                checksum,
                fileSize: BigInt(45000000),
                releaseManifest: signed.manifest,
                manifestSignature: signed.signature,
                signingKeyId: null,
              },
            ]),
          }),
        }),
      } as any);

      const res = await app.request(
        "/agent-versions/1.0.0/download?platform=linux&arch=amd64",
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.signingKeyId ?? null).toBeNull();
    });
  });

  describe("POST /agent-versions", () => {
    it("should create a new version", async () => {
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            {
              id: "ver-1",
              version: "1.0.0",
              platform: "linux",
              architecture: "amd64",
              downloadUrl: "https://s3.example.com/agent-1.0.0",
              checksum: "c".repeat(64),
              releaseManifest: null,
              manifestSignature: null,
              signingKeyId: null,
              fileSize: null,
              releaseNotes: null,
              isLatest: false,
              createdAt: new Date("2026-02-15"),
            },
          ]),
        }),
      } as any);

      const res = await app.request("/agent-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withValidManifest({
            version: "1.0.0",
            platform: "linux",
            architecture: "amd64",
            downloadUrl: "https://s3.example.com/agent-1.0.0",
            checksum: "c".repeat(64),
          }),
        ),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.version).toBe("1.0.0");
      expect(body.platform).toBe("linux");
    });

    it("defaults edition to this server's own edition (self-host) when omitted", async () => {
      const insertValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          { id: "ver-ed-1", version: "1.0.0", edition: "self-host", isLatest: false },
        ]),
      });
      vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

      delete process.env.BINARY_EDITION;
      const res = await app.request("/agent-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withValidManifest({
            version: "1.0.0",
            platform: "linux",
            architecture: "amd64",
            downloadUrl: "https://s3.example.com/agent-1.0.0",
            checksum: "c".repeat(64),
          }),
        ),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.edition).toBe("self-host");
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ edition: "self-host" }),
      );
    });

    it("accepts an explicit edition and stamps it on the row", async () => {
      const insertValues = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          { id: "ver-ed-2", version: "1.0.0", edition: "hosted", isLatest: false },
        ]),
      });
      vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);

      const res = await app.request("/agent-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withValidManifest({
            version: "1.0.0",
            platform: "linux",
            architecture: "amd64",
            downloadUrl: "https://s3.example.com/agent-1.0.0",
            checksum: "c".repeat(64),
            edition: "hosted",
          }),
        ),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.edition).toBe("hosted");
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ edition: "hosted" }),
      );
    });

    it("rejects an unrecognized edition value", async () => {
      const res = await app.request("/agent-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "1.0.0",
          platform: "linux",
          architecture: "amd64",
          downloadUrl: "https://s3.example.com/agent-1.0.0",
          checksum: "c".repeat(64),
          edition: "enterprise",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("scopes the isLatest unset to the same edition on create", async () => {
      const updateWhere = vi.fn().mockResolvedValue(undefined);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({ where: updateWhere }),
      } as any);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            { id: "ver-ed-3", version: "3.0.0", edition: "hosted", isLatest: true },
          ]),
        }),
      } as any);

      const res = await app.request("/agent-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withValidManifest({
            version: "3.0.0",
            platform: "linux",
            architecture: "amd64",
            downloadUrl: "https://s3.example.com/agent-3.0.0",
            checksum: "e".repeat(64),
            isLatest: true,
            edition: "hosted",
          }),
        ),
      });

      expect(res.status).toBe(201);
      const whereArg = updateWhere.mock.calls[0]?.[0];
      expect(hasEditionClause(whereArg, "hosted")).toBe(true);
    });

    it("should unset previous latest when isLatest=true", async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            {
              id: "ver-2",
              version: "2.0.0",
              platform: "linux",
              architecture: "amd64",
              downloadUrl: "https://s3.example.com/agent-2.0.0",
              checksum: "d".repeat(64),
              releaseManifest: null,
              manifestSignature: null,
              signingKeyId: null,
              fileSize: null,
              releaseNotes: "Major release",
              isLatest: true,
              createdAt: new Date("2026-02-15"),
            },
          ]),
        }),
      } as any);

      const res = await app.request("/agent-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          withValidManifest({
            version: "2.0.0",
            platform: "linux",
            architecture: "amd64",
            downloadUrl: "https://s3.example.com/agent-2.0.0",
            checksum: "d".repeat(64),
            isLatest: true,
          }),
        ),
      });

      expect(res.status).toBe(201);
      // Verify db.update was called to unset previous latest
      expect(db.update).toHaveBeenCalled();
    });

    it("should reject invalid checksum length", async () => {
      const res = await app.request("/agent-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "1.0.0",
          platform: "linux",
          architecture: "amd64",
          downloadUrl: "https://s3.example.com/agent",
          checksum: "tooshort",
        }),
      });

      expect(res.status).toBe(400);
    });

    it("should reject invalid platform", async () => {
      const res = await app.request("/agent-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "1.0.0",
          platform: "freebsd",
          architecture: "amd64",
          downloadUrl: "https://s3.example.com/agent",
          checksum: "a".repeat(64),
        }),
      });

      expect(res.status).toBe(400);
    });

    // Regression coverage for issue #3544: a manifest-less row used to be
    // accepted silently at write time and only ever surfaced later as an
    // opaque 409 on every agent heartbeat trying to download it.
    it("422s with signed_release_manifest_required when releaseManifest/manifestSignature are omitted", async () => {
      const res = await app.request("/agent-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "1.0.0",
          platform: "linux",
          architecture: "amd64",
          downloadUrl: "https://s3.example.com/agent-1.0.0",
          checksum: "c".repeat(64),
        }),
      });

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe("Release manifest is not trusted");
      expect(body.reason).toBe("signed_release_manifest_required");
      // Rejected before any write.
      expect(db.insert).not.toHaveBeenCalled();
    });

    it("422s with invalid_release_manifest_json when the manifest is present but not valid JSON", async () => {
      const res = await app.request("/agent-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "1.0.0",
          platform: "linux",
          architecture: "amd64",
          downloadUrl: "https://s3.example.com/agent-1.0.0",
          checksum: "c".repeat(64),
          releaseManifest: "this is not json",
          manifestSignature: "test-signature",
        }),
      });

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe("Release manifest is not trusted");
      expect(body.reason).toBe("invalid_release_manifest_json");
      expect(db.insert).not.toHaveBeenCalled();
    });

    // Critical ordering property: a rejected isLatest:true row must NOT strip
    // the currently-working upgrade target off the fleet on its way to being
    // refused. The manifest check must run BEFORE the isLatest demotion.
    it("rejects isLatest:true with no manifest WITHOUT demoting the currently-promoted row (outage-prevention ordering, #3544)", async () => {
      const res = await app.request("/agent-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: "1.0.0",
          platform: "linux",
          architecture: "amd64",
          downloadUrl: "https://s3.example.com/agent-1.0.0",
          checksum: "c".repeat(64),
          isLatest: true,
        }),
      });

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.reason).toBe("signed_release_manifest_required");
      // The isLatest demotion UPDATE never ran, and neither did the insert.
      expect(db.update).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });
  });
});

describe("validateReleaseManifest — fail-closed behaviour (#625 C3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_UPDATE_MANIFEST_PUBLIC_KEYS;
    delete process.env.BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS;
    delete process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
    delete process.env.BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
  });

  it("fails closed when DB lookup throws and no env keys are configured", async () => {
    // Before this fix (C3), getUpdateManifestPublicKeys silently swallowed
    // the DB error, returned keys.length === 0, and verifyEd25519Manifest
    // Signature returned true — bypassing signature verification entirely.
    vi.spyOn(manifestSigning, "getActivePublicKeys").mockRejectedValue(
      new Error("connection refused"),
    );

    const result = await validateReleaseManifest({
      manifest: JSON.stringify({
        version: "0.65.9",
        component: "agent",
        platform: "linux",
        arch: "amd64",
        url: "http://x",
        checksum: "a".repeat(64),
        size: 1,
      }),
      signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      version: "0.65.9",
      platform: "linux",
      arch: "amd64",
      component: "agent",
      downloadUrl: "http://x",
      checksum: "a".repeat(64),
      fileSize: 1,
    });

    expect(result.ok).toBe(false);
  });

  it("soft-passes when DB returns no keys and no env keys are configured (hosted SaaS empty-keyset intent)", async () => {
    // Empty because neither env vars nor DB rows are set — this is the normal
    // hosted-SaaS state where agents trust the LanternOps build-time key
    // directly and the API has no deployment signing key. Must remain a
    // soft-pass so hosted agents can download updates.
    vi.spyOn(manifestSigning, "getActivePublicKeys").mockResolvedValue([]);

    const manifestObj = {
      version: "0.65.9",
      component: "agent",
      platform: "linux",
      arch: "amd64",
      url: "http://x",
      checksum: "a".repeat(64),
      size: 1,
    };

    const result = await validateReleaseManifest({
      manifest: JSON.stringify(manifestObj),
      // Signature is ignored when keyset is intentionally empty (soft-pass).
      signature: "A".repeat(88),
      version: "0.65.9",
      platform: "linux",
      arch: "amd64",
      component: "agent",
      downloadUrl: "http://x",
      checksum: "a".repeat(64),
      fileSize: 1,
    });

    expect(result.ok).toBe(true);
  });
});

describe("verifyEd25519ManifestSignature — empty-keyset opt-in (#643)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_UPDATE_MANIFEST_PUBLIC_KEYS;
    delete process.env.BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS;
    vi.spyOn(manifestSigning, "getActivePublicKeys").mockResolvedValue([]);
  });

  it("fails closed by default when no trust roots are configured", async () => {
    const result = await verifyEd25519ManifestSignature(
      "{\"foo\":1}",
      "A".repeat(88),
    );
    expect(result).toBe(false);
  });

  it("returns true when caller explicitly opts into the empty-keyset soft-pass", async () => {
    const result = await verifyEd25519ManifestSignature(
      "{\"foo\":1}",
      "A".repeat(88),
      { allowEmptyKeysetSoftPass: true },
    );
    expect(result).toBe(true);
  });

  it("still fails closed on DB load failure even when caller opts in", async () => {
    vi.spyOn(manifestSigning, "getActivePublicKeys").mockRejectedValue(
      new Error("connection refused"),
    );
    const result = await verifyEd25519ManifestSignature(
      "{\"foo\":1}",
      "A".repeat(88),
      { allowEmptyKeysetSoftPass: true },
    );
    expect(result).toBe(false);
  });

  it("does NOT soft-pass when keyset is configured — forged signature still rejected even with opt-in", async () => {
    // Generate a real keypair and register its pubkey via env, but then call
    // verify with a forged (random) signature. The opt-in must ONLY kick in
    // when the keyset is genuinely empty; once any trust root is configured,
    // a bad signature is still a bad signature.
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const rawPublicKey = publicDer.subarray(publicDer.length - 32);
    process.env.AGENT_UPDATE_MANIFEST_PUBLIC_KEYS = rawPublicKey.toString("base64");

    const forgedSignature = Buffer.alloc(64, 0xab).toString("base64");
    const result = await verifyEd25519ManifestSignature(
      "{\"foo\":1}",
      forgedSignature,
      { allowEmptyKeysetSoftPass: true },
    );
    expect(result).toBe(false);
  });
});

// D1 (#3836): canonicalReleaseAssetName must reproduce EXACTLY the filenames
// binarySync.ts's scanBinaryDir/parseBinaryFilename (agent/watchdog/backup)
// and USER_HELPER_TARGETS (user-helper) produce — every case below is
// cross-checked against those sources, not invented independently.
// component="helper" is deliberately always null: its real registration is
// HELPER_TARGETS (binarySync.ts ~line 59), a per-OS (not per-arch) asset
// name (windows -> breeze-helper-windows.msi, darwin (both arches, same
// file) -> breeze-helper-macos.dmg, linux -> breeze-helper-linux.AppImage) —
// see the controller-review regression test below for why an earlier
// version of this function (returning "breeze-desktop-helper-darwin-<arch>"
// for helper/macos) was WRONG and would have 409'd real
// BINARY_SOURCE=github helper rows.
describe("canonicalReleaseAssetName (D1, #3836)", () => {
  const cases: Array<[string, string, string, string | null]> = [
    // agent — windows/linux/darwin, both arches. Also proves "macos" (the DB
    // platform value) and "darwin" (the wire/manifest value some callers use)
    // both resolve to the same on-disk name.
    ["agent", "windows", "amd64", "breeze-agent-windows-amd64.exe"],
    ["agent", "windows", "arm64", "breeze-agent-windows-arm64.exe"],
    ["agent", "linux", "amd64", "breeze-agent-linux-amd64"],
    ["agent", "linux", "arm64", "breeze-agent-linux-arm64"],
    ["agent", "macos", "amd64", "breeze-agent-darwin-amd64"],
    ["agent", "macos", "arm64", "breeze-agent-darwin-arm64"],
    ["agent", "darwin", "amd64", "breeze-agent-darwin-amd64"],

    // watchdog — same shape as agent (WATCHDOG_TARGETS = AGENT_TARGETS).
    ["watchdog", "windows", "amd64", "breeze-watchdog-windows-amd64.exe"],
    ["watchdog", "linux", "amd64", "breeze-watchdog-linux-amd64"],
    ["watchdog", "linux", "arm64", "breeze-watchdog-linux-arm64"],
    ["watchdog", "macos", "amd64", "breeze-watchdog-darwin-amd64"],
    ["watchdog", "macos", "arm64", "breeze-watchdog-darwin-arm64"],

    // backup — same shape as agent (BACKUP_TARGETS = AGENT_TARGETS).
    ["backup", "windows", "amd64", "breeze-backup-windows-amd64.exe"],
    ["backup", "linux", "amd64", "breeze-backup-linux-amd64"],
    ["backup", "linux", "arm64", "breeze-backup-linux-arm64"],
    ["backup", "macos", "amd64", "breeze-backup-darwin-amd64"],
    ["backup", "macos", "arm64", "breeze-backup-darwin-arm64"],

    // user-helper — Windows only (USER_HELPER_TARGETS).
    ["user-helper", "windows", "amd64", "breeze-user-helper-windows-amd64.exe"],
    ["user-helper", "windows", "arm64", "breeze-user-helper-windows-arm64.exe"],
    ["user-helper", "macos", "amd64", null],
    ["user-helper", "linux", "amd64", null],

    // helper — always null (see the describe-block comment above): the real
    // asset name (breeze-helper-macos.dmg / -windows.msi / -linux.AppImage)
    // is per-OS, not per-arch, so it must resolve via the URL-basename
    // fallback instead.
    ["helper", "macos", "amd64", null],
    ["helper", "macos", "arm64", null],
    ["helper", "windows", "amd64", null],
    ["helper", "linux", "amd64", null],

    // Unknown component/platform/arch — every unrecognized shape falls back
    // to the caller's assetNameFromDownloadUrl, never fabricates a name.
    ["viewer", "windows", "amd64", null],
    ["not-a-real-component", "linux", "amd64", null],
    ["agent", "solaris", "amd64", null],
    ["agent", "linux", "mips", null],
  ];

  it.each(cases)(
    "component=%s platform=%s arch=%s -> %s",
    (component, platform, arch, expected) => {
      expect(canonicalReleaseAssetName(component, platform, arch)).toBe(expected);
    },
  );
});

// D3 (#3836): the schema-v1 catch in validateReleaseManifest used to
// collapse EVERY throw from verifyReleaseArtifactManifestAsset into
// invalid_release_manifest_signature. These tests pin the split to typed
// errors exported from releaseArtifactManifest.ts.
describe("validateReleaseManifest — schema-v1 reason split (D3, #3836)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
    delete process.env.BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
  });

  function makeSignedSchemaV1Manifest(
    assets: Array<{
      name: string;
      sha256: string;
      size: number;
      platformTrust?: string;
      edition?: string;
    }>,
    release = "v1.0.0",
  ) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    const rawPublicKey = publicDer.subarray(publicDer.length - 32);
    const manifest = JSON.stringify({
      schemaVersion: 1,
      repository: "LanternOps/breeze",
      release,
      assets,
    });
    return {
      manifest,
      signature: sign(null, Buffer.from(manifest, "utf8"), privateKey).toString(
        "base64",
      ),
      publicKey: rawPublicKey.toString("base64"),
    };
  }

  it("returns release_manifest_asset_lookup_failed when the canonical asset is absent from a validly-signed manifest", async () => {
    const signed = makeSignedSchemaV1Manifest([
      {
        name: "breeze-agent-windows-amd64.exe",
        sha256: "a".repeat(64),
        size: 10,
        platformTrust: requiredPlatformTrustFor("breeze-agent-windows-amd64.exe") ?? undefined,
      },
    ]);
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const result = await validateReleaseManifest({
      manifest: signed.manifest,
      signature: signed.signature,
      version: "1.0.0",
      platform: "linux",
      arch: "amd64",
      component: "agent",
      // Deliberately irrelevant: D1 makes the canonical (component, platform,
      // arch) shape win over the URL basename, so this URL is never consulted.
      downloadUrl: "https://s3.example.com/agent-1.0.0",
      checksum: "b".repeat(64),
    });

    expect(result).toEqual({
      ok: false,
      reason: "release_manifest_asset_lookup_failed",
    });
  });

  it("returns release_asset_not_distributable when the asset entry fails the platform-trust policy check", async () => {
    const assetName = "breeze-agent-windows-amd64.exe";
    const checksum = "c".repeat(64);
    const signed = makeSignedSchemaV1Manifest([
      // Windows .exe requires "windows-authenticode-required"; "none" with no
      // edition claim is refused by assertDistributableReleaseAsset.
      { name: assetName, sha256: checksum, size: 10, platformTrust: "none" },
    ]);
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = signed.publicKey;

    const result = await validateReleaseManifest({
      manifest: signed.manifest,
      signature: signed.signature,
      version: "1.0.0",
      platform: "windows",
      arch: "amd64",
      component: "agent",
      downloadUrl: "https://s3.example.com/agent-1.0.0",
      checksum,
    });

    expect(result).toEqual({
      ok: false,
      reason: "release_asset_not_distributable",
    });
  });

  it("#641 — a forged signature still returns invalid_release_manifest_signature even though the asset would otherwise fail lookup", async () => {
    // The manifest is well-formed but does NOT include the asset a valid
    // signature would need to cover — if signature verification were skipped
    // or ran second, this would leak release_manifest_asset_lookup_failed to
    // an attacker who never held the signing key. It must not: verify
    // ReleaseArtifactManifestAsset checks the signature before ever
    // attempting the lookup.
    const attacker = generateKeyPairSync("ed25519");
    const trusted = generateKeyPairSync("ed25519");
    const manifest = JSON.stringify({
      schemaVersion: 1,
      repository: "LanternOps/breeze",
      release: "v1.0.0",
      assets: [{ name: "breeze-agent-windows-amd64.exe", sha256: "a".repeat(64), size: 10 }],
    });
    const forgedSignature = sign(
      null,
      Buffer.from(manifest, "utf8"),
      attacker.privateKey,
    ).toString("base64");
    const trustedPublicDer = trusted.publicKey.export({
      format: "der",
      type: "spki",
    }) as Buffer;
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = trustedPublicDer
      .subarray(trustedPublicDer.length - 32)
      .toString("base64");

    const result = await validateReleaseManifest({
      manifest,
      signature: forgedSignature,
      version: "1.0.0",
      platform: "linux", // resolves to breeze-agent-linux-amd64 — not in `assets` above
      arch: "amd64",
      component: "agent",
      downloadUrl: "https://s3.example.com/agent-1.0.0",
      checksum: "b".repeat(64),
    });

    expect(result).toEqual({
      ok: false,
      reason: "invalid_release_manifest_signature",
    });
  });
});

// Task 2 (#3836): key-ID-aware dispatch for validateReleaseManifest.
// Mirrors the agent's exact-ID semantics (agent/internal/updater/
// updater.go verifyManifestSignature, ~line 769): an explicit signingKeyId
// binds verification to that ONE key — never a fallback across the whole
// trusted set. Before this, the legacy (non schema-v1) branch checked a
// row's signature against the UNION of env keys and every DB deployment
// key regardless of what signingKeyId claimed, so a row stamped with the
// official key ID but actually signed by a per-deployment key (or
// vice-versa) passed the server even though a real agent's exact-ID
// lookup would reject it.
describe("validateReleaseManifest — key-ID-aware dispatch (Task 2, #3836)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_UPDATE_MANIFEST_PUBLIC_KEYS;
    delete process.env.BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS;
    delete process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
    delete process.env.BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
    vi.spyOn(manifestSigning, "getActiveTrustKeyset").mockResolvedValue([]);
  });

  function rawPub(publicKey: { export: (opts: { format: "der"; type: "spki" }) => Buffer }): Buffer {
    const der = publicKey.export({ format: "der", type: "spki" });
    return der.subarray(der.length - 32);
  }

  function legacyManifest() {
    return JSON.stringify({
      version: "1.0.0",
      component: "agent",
      platform: "linux",
      arch: "amd64",
      url: "https://s3.example.com/agent-1.0.0",
      checksum: "b".repeat(64),
      size: 45000000,
    });
  }

  const legacyArgsBase = {
    version: "1.0.0",
    platform: "linux",
    arch: "amd64",
    component: "agent",
    downloadUrl: "https://s3.example.com/agent-1.0.0",
    checksum: "b".repeat(64),
    fileSize: 45000000,
  };

  it("REJECTS a row stamped with the official key ID but signed by a DB-trusted deployment key (the exact bug this task closes)", async () => {
    const deployKey = generateKeyPairSync("ed25519");
    const manifest = legacyManifest();
    const signature = sign(null, Buffer.from(manifest, "utf8"), deployKey.privateKey).toString("base64");

    // The deploy key IS otherwise trusted (present in manifest_signing_keys)
    // — that's the point: a legitimately-trusted key must still be rejected
    // when it isn't the ONE key the claimed ID names.
    vi.spyOn(manifestSigning, "getActiveTrustKeyset").mockResolvedValue([
      {
        keyId: "deploy-2026-08-01-aaaa",
        publicKeyB64: rawPub(deployKey.publicKey).toString("base64"),
        validFrom: new Date().toISOString(),
      },
    ]);

    const result = await validateReleaseManifest({
      ...legacyArgsBase,
      manifest,
      signature,
      signingKeyId: "release-artifact-manifest-ed25519",
    });

    expect(result).toEqual({ ok: false, reason: "invalid_release_manifest_signature" });
  });

  it("ACCEPTS a row stamped with the official key ID when signed by a genuinely official (RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS) key", async () => {
    const official = generateKeyPairSync("ed25519");
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = rawPub(official.publicKey).toString("base64");
    const manifest = legacyManifest();
    const signature = sign(null, Buffer.from(manifest, "utf8"), official.privateKey).toString("base64");

    const result = await validateReleaseManifest({
      ...legacyArgsBase,
      manifest,
      signature,
      signingKeyId: "release-artifact-manifest-ed25519",
    });

    expect(result).toEqual({ ok: true });
  });

  it("REJECTS a row stamped with the official key ID when no official key is configured, even with DB deployment keys present", async () => {
    const deployKey = generateKeyPairSync("ed25519");
    const manifest = legacyManifest();
    const signature = sign(null, Buffer.from(manifest, "utf8"), deployKey.privateKey).toString("base64");
    vi.spyOn(manifestSigning, "getActiveTrustKeyset").mockResolvedValue([
      {
        keyId: "deploy-2026-08-01-aaaa",
        publicKeyB64: rawPub(deployKey.publicKey).toString("base64"),
        validFrom: new Date().toISOString(),
      },
    ]);

    const result = await validateReleaseManifest({
      ...legacyArgsBase,
      manifest,
      signature,
      signingKeyId: "release-artifact-manifest-ed25519",
    });

    expect(result).toEqual({ ok: false, reason: "invalid_release_manifest_signature" });
  });

  it("REJECTS a row stamped with a deploy-* key ID when signed by the OFFICIAL key instead of that DB key row (vice-versa case)", async () => {
    const official = generateKeyPairSync("ed25519");
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = rawPub(official.publicKey).toString("base64");
    const manifest = legacyManifest();
    const signature = sign(null, Buffer.from(manifest, "utf8"), official.privateKey).toString("base64");

    // A DIFFERENT deploy key row exists under the claimed ID — its actual
    // public key never signed this manifest.
    const otherDeployKey = generateKeyPairSync("ed25519");
    vi.spyOn(manifestSigning, "getActiveTrustKeyset").mockResolvedValue([
      {
        keyId: "deploy-2026-08-01-aaaa",
        publicKeyB64: rawPub(otherDeployKey.publicKey).toString("base64"),
        validFrom: new Date().toISOString(),
      },
    ]);

    const result = await validateReleaseManifest({
      ...legacyArgsBase,
      manifest,
      signature,
      signingKeyId: "deploy-2026-08-01-aaaa",
    });

    expect(result).toEqual({ ok: false, reason: "invalid_release_manifest_signature" });
  });

  it("ACCEPTS a row stamped with a deploy-* key ID when signed by exactly that DB key row", async () => {
    const deployKey = generateKeyPairSync("ed25519");
    const manifest = legacyManifest();
    const signature = sign(null, Buffer.from(manifest, "utf8"), deployKey.privateKey).toString("base64");
    vi.spyOn(manifestSigning, "getActiveTrustKeyset").mockResolvedValue([
      {
        keyId: "deploy-2026-08-01-aaaa",
        publicKeyB64: rawPub(deployKey.publicKey).toString("base64"),
        validFrom: new Date().toISOString(),
      },
    ]);

    const result = await validateReleaseManifest({
      ...legacyArgsBase,
      manifest,
      signature,
      signingKeyId: "deploy-2026-08-01-aaaa",
    });

    expect(result).toEqual({ ok: true });
  });

  it("REJECTS a deploy-* key ID with no matching manifest_signing_keys row (rotated out / never existed)", async () => {
    const deployKey = generateKeyPairSync("ed25519");
    const manifest = legacyManifest();
    const signature = sign(null, Buffer.from(manifest, "utf8"), deployKey.privateKey).toString("base64");
    vi.spyOn(manifestSigning, "getActiveTrustKeyset").mockResolvedValue([]);

    const result = await validateReleaseManifest({
      ...legacyArgsBase,
      manifest,
      signature,
      signingKeyId: "deploy-2026-08-01-aaaa",
    });

    expect(result).toEqual({ ok: false, reason: "invalid_release_manifest_signature" });
  });

  it("REJECTS a deploy-* key ID when getActiveTrustKeyset (manifest_signing_keys lookup) fails outright", async () => {
    // Fix round 1 review finding: the try/catch around getActiveTrustKeyset
    // in verifyManifestSignatureForSigningKeyId's deploy-* branch had no
    // test. A transient DB failure while resolving the ONE key a deploy-*
    // signingKeyId names must fail closed, not silently fall through to a
    // wider trust set.
    const deployKey = generateKeyPairSync("ed25519");
    const manifest = legacyManifest();
    const signature = sign(null, Buffer.from(manifest, "utf8"), deployKey.privateKey).toString("base64");
    vi.spyOn(manifestSigning, "getActiveTrustKeyset").mockRejectedValue(
      new Error("connection refused"),
    );

    const result = await validateReleaseManifest({
      ...legacyArgsBase,
      manifest,
      signature,
      signingKeyId: "deploy-2026-08-01-aaaa",
    });

    expect(result).toEqual({ ok: false, reason: "invalid_release_manifest_signature" });
  });

  it("REJECTS a deploy-* key ID whose matched manifest_signing_keys row decodes to a non-32-byte key (corrupted row)", async () => {
    // Optional coverage (fix round 1 review): the rawKey.length !== 32 guard
    // in verifyEd25519SignatureAgainstSingleRawKey.
    const deployKey = generateKeyPairSync("ed25519");
    const manifest = legacyManifest();
    const signature = sign(null, Buffer.from(manifest, "utf8"), deployKey.privateKey).toString("base64");
    vi.spyOn(manifestSigning, "getActiveTrustKeyset").mockResolvedValue([
      {
        keyId: "deploy-2026-08-01-aaaa",
        publicKeyB64: Buffer.from("too-short").toString("base64"),
        validFrom: new Date().toISOString(),
      },
    ]);

    const result = await validateReleaseManifest({
      ...legacyArgsBase,
      manifest,
      signature,
      signingKeyId: "deploy-2026-08-01-aaaa",
    });

    expect(result).toEqual({ ok: false, reason: "invalid_release_manifest_signature" });
  });

  it("keeps the legacy whole-set behavior unchanged for absent/unrecognized signingKeyId (no ID narrowing applies)", async () => {
    const trusted = generateKeyPairSync("ed25519");
    process.env.AGENT_UPDATE_MANIFEST_PUBLIC_KEYS = rawPub(trusted.publicKey).toString("base64");
    const manifest = legacyManifest();
    const signature = sign(null, Buffer.from(manifest, "utf8"), trusted.privateKey).toString("base64");

    const result = await validateReleaseManifest({
      ...legacyArgsBase,
      manifest,
      signature,
      // no signingKeyId at all
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects a schema-v1 row whose stamped key ID is NOT the official ID, even though the signature verifies under the official key (schema-v1 can only ever prove official provenance)", async () => {
    const official = generateKeyPairSync("ed25519");
    process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS = rawPub(official.publicKey).toString("base64");

    const manifest = JSON.stringify({
      schemaVersion: 1,
      repository: "LanternOps/breeze",
      release: "v1.0.0",
      assets: [
        {
          name: "breeze-agent-linux-amd64",
          sha256: "a".repeat(64),
          size: 10,
          platformTrust: requiredPlatformTrustFor("breeze-agent-linux-amd64") ?? undefined,
        },
      ],
    });
    const signature = sign(null, Buffer.from(manifest, "utf8"), official.privateKey).toString("base64");

    const result = await validateReleaseManifest({
      manifest,
      signature,
      signingKeyId: "deploy-2026-08-01-aaaa",
      version: "1.0.0",
      platform: "linux",
      arch: "amd64",
      component: "agent",
      downloadUrl: "https://s3.example.com/agent-1.0.0",
      checksum: "a".repeat(64),
    });

    expect(result).toEqual({ ok: false, reason: "invalid_release_manifest_signature" });
  });
});
