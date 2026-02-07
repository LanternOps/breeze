import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { securityRoutes } from './security';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  devices: {},
  securityStatus: {},
  securityThreats: {},
  securityScans: {},
  securityPolicies: {},
  auditLogs: {}
}));

vi.mock('../services/commandQueue', () => ({
  CommandTypes: {
    SECURITY_SCAN: 'security_scan',
    SECURITY_THREAT_QUARANTINE: 'security_threat_quarantine',
    SECURITY_THREAT_REMOVE: 'security_threat_remove',
    SECURITY_THREAT_RESTORE: 'security_threat_restore'
  },
  queueCommand: vi.fn().mockResolvedValue({ id: 'cmd-123' })
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      user: { id: '11111111-1111-1111-1111-111111111111', email: 'test@example.com', name: 'Test User' },
      orgCondition: () => undefined,
      canAccessOrg: () => true
    });
    return next();
  }),
  requireScope: vi.fn(() => (c, next) => next())
}));

import { db } from '../db';
import { queueCommand } from '../services/commandQueue';

function mockThreatSelect(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue(rows)
        })
      })
    })
  } as any);
}

function mockStatusSelect(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows)
      })
    })
  } as any);
}

function mockDeviceLookup(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows)
      })
    })
  } as any);
}

function mockScanSelect(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue(rows)
      })
    })
  } as any);
}

describe('security routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/security', securityRoutes);
  });

  describe('GET /security/threats', () => {
    it('should list threats with filters and pagination', async () => {
      mockThreatSelect([
        {
          id: '9b0ce8f4-21c0-4f65-8b0a-0b9f8bbf9a11',
          deviceId: '6e69f4aa-7a2d-42b9-9a2b-7682f0f48a02',
          orgId: '11111111-1111-1111-1111-111111111111',
          deviceName: 'SFO-WS-207',
          provider: 'windows_defender',
          threatName: 'Trojan:Win32/Emotet',
          threatType: 'trojan',
          severity: 'critical',
          status: 'detected',
          filePath: 'C:\\malware.exe',
          detectedAt: new Date(),
          resolvedAt: null
        }
      ]);

      const res = await app.request('/security/threats?severity=critical', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.every((threat: any) => threat.severity === 'critical')).toBe(true);
      expect(body.data[0].provider).toBeDefined();
      expect(body.pagination.total).toBeGreaterThan(0);
    });
  });

  describe('GET /security/threats/:deviceId', () => {
    it('should list threats for a device', async () => {
      const deviceId = '6e69f4aa-7a2d-42b9-9a2b-7682f0f48a02';

      mockStatusSelect([
        {
          deviceId,
          orgId: '11111111-1111-1111-1111-111111111111',
          deviceName: 'SFO-WS-207',
          os: 'windows',
          deviceState: 'online',
          provider: 'windows_defender',
          providerVersion: null,
          definitionsVersion: null,
          definitionsDate: null,
          realTimeProtection: true,
          threatCount: 1,
          firewallEnabled: true,
          encryptionStatus: 'encrypted',
          lastScan: null,
          lastScanType: null
        }
      ]);

      mockThreatSelect([
        {
          id: '9b0ce8f4-21c0-4f65-8b0a-0b9f8bbf9a11',
          deviceId,
          orgId: '11111111-1111-1111-1111-111111111111',
          deviceName: 'SFO-WS-207',
          provider: 'windows_defender',
          threatName: 'PUP.Optional.Toolbar',
          threatType: 'pup',
          severity: 'low',
          status: 'quarantined',
          filePath: 'C:\\toolbar.exe',
          detectedAt: new Date(),
          resolvedAt: null
        }
      ]);

      const res = await app.request(`/security/threats/${deviceId}?status=quarantined`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.every((threat: any) => threat.deviceId === deviceId)).toBe(true);
      expect(body.data.every((threat: any) => threat.status === 'quarantined')).toBe(true);
    });

    it('should return 404 when device is missing', async () => {
      mockStatusSelect([]);

      const res = await app.request('/security/threats/00000000-0000-0000-0000-000000000000', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /security/scan/:deviceId', () => {
    it('should queue a scan for a valid device', async () => {
      const deviceId = 'f1bd7f85-1df4-44aa-8147-6b4dba0b7e05';

      mockDeviceLookup([
        {
          id: deviceId,
          hostname: 'CHI-VM-022',
          orgId: '11111111-1111-1111-1111-111111111111'
        }
      ]);

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined)
      } as any);

      const res = await app.request(`/security/scan/${deviceId}`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanType: 'quick' })
      });

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.data.deviceId).toBe(deviceId);
      expect(body.data.status).toBe('queued');
      expect(body.data.scanType).toBe('quick');
      expect(body.data.id).toBeDefined();
      expect(queueCommand).toHaveBeenCalledTimes(1);
    });

    it('should return 404 for unknown device', async () => {
      mockDeviceLookup([]);

      const res = await app.request('/security/scan/00000000-0000-0000-0000-000000000000', {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanType: 'full' })
      });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /security/scans/:deviceId', () => {
    it('should list scans with filters', async () => {
      const deviceId = '6e69f4aa-7a2d-42b9-9a2b-7682f0f48a02';

      mockDeviceLookup([
        {
          id: deviceId,
          hostname: 'SFO-WS-207',
          orgId: '11111111-1111-1111-1111-111111111111'
        }
      ]);

      mockScanSelect([
        {
          id: '7a5fb780-0cd5-4e26-8246-bd3da83a1202',
          deviceId,
          scanType: 'quick',
          status: 'completed',
          startedAt: new Date(),
          completedAt: new Date(),
          threatsFound: 1,
          duration: 420
        }
      ]);

      const res = await app.request(`/security/scans/${deviceId}?status=completed`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.every((scan: any) => scan.status === 'completed')).toBe(true);
    });
  });
});
