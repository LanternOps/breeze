import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => vi.fn(async (_c: any, next: any) => next()),
}));

import { agentVersionRoutes } from './agentVersions';
import { db } from '../db';

describe('agentVersions routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    // Inject mock auth context
    app.use(async (c: any, next: any) => {
      c.set('auth', {
        user: { id: 'admin-1' },
        orgId: 'org-1',
        scope: 'system',
      });
      await next();
    });
    app.route('/agent-versions', agentVersionRoutes);
  });

  describe('GET /agent-versions/latest', () => {
    it('should return latest version for platform/arch', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              version: '1.2.0',
              downloadUrl: 'https://s3.example.com/agent-1.2.0-linux-amd64',
              checksum: 'a'.repeat(64),
              fileSize: BigInt(45000000),
              releaseNotes: 'Bug fixes',
            }]),
          }),
        }),
      } as any);

      const res = await app.request(
        '/agent-versions/latest?platform=linux&arch=amd64',
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.version).toBe('1.2.0');
      expect(body.downloadUrl).toContain('agent-1.2.0');
      expect(body.checksum).toBe('a'.repeat(64));
      expect(body.fileSize).toBe(45000000);
      expect(body.releaseNotes).toBe('Bug fixes');
    });

    it('should return 404 when no version exists', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(
        '/agent-versions/latest?platform=linux&arch=arm64',
      );

      expect(res.status).toBe(404);
    });

    it('should reject invalid platform', async () => {
      const res = await app.request(
        '/agent-versions/latest?platform=bsd&arch=amd64',
      );

      expect(res.status).toBe(400);
    });

    it('should reject missing query params', async () => {
      const res = await app.request('/agent-versions/latest');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /agent-versions/:version/download', () => {
    it('should return JSON with download URL and checksum', async () => {
      const checksum = 'b'.repeat(64);

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              downloadUrl: 'https://s3.example.com/agent-1.0.0',
              checksum,
            }]),
          }),
        }),
      } as any);

      const res = await app.request(
        '/agent-versions/1.0.0/download?platform=linux&arch=amd64',
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.url).toBe('https://s3.example.com/agent-1.0.0');
      expect(body.checksum).toBe(checksum);
    });

    it('should return 404 for unknown version', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(
        '/agent-versions/99.0.0/download?platform=linux&arch=amd64',
      );

      expect(res.status).toBe(404);
    });
  });

  describe('POST /agent-versions', () => {
    it('should create a new version', async () => {
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'ver-1',
            version: '1.0.0',
            platform: 'linux',
            architecture: 'amd64',
            downloadUrl: 'https://s3.example.com/agent-1.0.0',
            checksum: 'c'.repeat(64),
            fileSize: null,
            releaseNotes: null,
            isLatest: false,
            createdAt: new Date('2026-02-15'),
          }]),
        }),
      } as any);

      const res = await app.request('/agent-versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: '1.0.0',
          platform: 'linux',
          architecture: 'amd64',
          downloadUrl: 'https://s3.example.com/agent-1.0.0',
          checksum: 'c'.repeat(64),
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.version).toBe('1.0.0');
      expect(body.platform).toBe('linux');
    });

    it('should unset previous latest when isLatest=true', async () => {
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as any);

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'ver-2',
            version: '2.0.0',
            platform: 'linux',
            architecture: 'amd64',
            downloadUrl: 'https://s3.example.com/agent-2.0.0',
            checksum: 'd'.repeat(64),
            fileSize: null,
            releaseNotes: 'Major release',
            isLatest: true,
            createdAt: new Date('2026-02-15'),
          }]),
        }),
      } as any);

      const res = await app.request('/agent-versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: '2.0.0',
          platform: 'linux',
          architecture: 'amd64',
          downloadUrl: 'https://s3.example.com/agent-2.0.0',
          checksum: 'd'.repeat(64),
          isLatest: true,
        }),
      });

      expect(res.status).toBe(201);
      // Verify db.update was called to unset previous latest
      expect(db.update).toHaveBeenCalled();
    });

    it('should reject invalid checksum length', async () => {
      const res = await app.request('/agent-versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: '1.0.0',
          platform: 'linux',
          architecture: 'amd64',
          downloadUrl: 'https://s3.example.com/agent',
          checksum: 'tooshort',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should reject invalid platform', async () => {
      const res = await app.request('/agent-versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: '1.0.0',
          platform: 'freebsd',
          architecture: 'amd64',
          downloadUrl: 'https://s3.example.com/agent',
          checksum: 'a'.repeat(64),
        }),
      });

      expect(res.status).toBe(400);
    });
  });
});
