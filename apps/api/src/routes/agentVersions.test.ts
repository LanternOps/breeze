import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { generateKeyPairSync, sign } from "node:crypto";

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
  },
}));

vi.mock("../services/manifestSigning", () => ({
  // Simulate no DB-provisioned deployment keys by default so tests that
  // don't set env vars still get a soft-pass (no env + no DB = empty keyset).
  getActivePublicKeys: vi.fn().mockResolvedValue([]),
  getActiveTrustKeyset: vi.fn().mockResolvedValue([]),
  ensureActiveSigningKey: vi.fn().mockResolvedValue({ keyId: "test-key", publicKeyB64: "" }),
  signManifest: vi.fn().mockResolvedValue("test-signature"),
}));

vi.mock("../services/auditEvents", () => ({
  writeRouteAudit: vi.fn(),
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
} from "./agentVersions";
import { db } from "../db";
import * as manifestSigning from "../services/manifestSigning";

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
        platformTrust: "release-workflow-produced",
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

describe("agentVersions routes", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_UPDATE_MANIFEST_PUBLIC_KEYS;
    delete process.env.BREEZE_UPDATE_MANIFEST_PUBLIC_KEYS;
    delete process.env.RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
    delete process.env.BREEZE_RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS;
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

  describe("GET /agent-versions/latest", () => {
    it("should return latest version for platform/arch", async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
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
            ]),
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

    it("should return 404 when no version exists", async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(
        "/agent-versions/latest?platform=linux&arch=arm64",
      );

      expect(res.status).toBe(404);
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

    it("keeps canonical github URL for component=helper (download route is agent-only)", async () => {
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
        expect(body.url).toBe(canonical);
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
        body: JSON.stringify({
          version: "1.0.0",
          platform: "linux",
          architecture: "amd64",
          downloadUrl: "https://s3.example.com/agent-1.0.0",
          checksum: "c".repeat(64),
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.version).toBe("1.0.0");
      expect(body.platform).toBe("linux");
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
        body: JSON.stringify({
          version: "2.0.0",
          platform: "linux",
          architecture: "amd64",
          downloadUrl: "https://s3.example.com/agent-2.0.0",
          checksum: "d".repeat(64),
          isLatest: true,
        }),
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
