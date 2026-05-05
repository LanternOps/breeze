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

vi.mock("../services/auditEvents", () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock("../middleware/auth", () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => vi.fn(async (_c: any, next: any) => next()),
  requirePermission: () => vi.fn(async (_c: any, next: any) => next()),
  requireMfa: () => vi.fn(async (_c: any, next: any) => next()),
}));

import { agentVersionRoutes } from "./agentVersions";
import { db } from "../db";

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
