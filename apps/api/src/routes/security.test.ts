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

vi.mock('../services/securityPosture', () => ({
  listLatestSecurityPosture: vi.fn(),
  getLatestSecurityPostureForDevice: vi.fn(),
  getSecurityPostureTrend: vi.fn()
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
import {
  getLatestSecurityPostureForDevice,
  getSecurityPostureTrend,
  listLatestSecurityPosture
} from '../services/securityPosture';

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

function mockAuditLogSelect(rows: any[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue(rows)
      })
    })
  } as any);
}

function makePostureRow(overrides: Record<string, any> = {}) {
  return {
    orgId: '11111111-1111-1111-1111-111111111111',
    deviceId: '6e69f4aa-7a2d-42b9-9a2b-7682f0f48a02',
    deviceName: 'SFO-WS-207',
    osType: 'windows',
    deviceStatus: 'online',
    capturedAt: new Date().toISOString(),
    overallScore: 70,
    riskLevel: 'medium',
    factors: {
      patch_compliance: { score: 75, confidence: 1 },
      encryption: { score: 80, confidence: 1 },
      av_health: { score: 78, confidence: 1 },
      firewall: { score: 65, confidence: 1 },
      open_ports: { score: 70, confidence: 1 },
      password_policy: { score: 82, confidence: 1 },
      os_currency: { score: 73, confidence: 1 },
      admin_exposure: { score: 88, confidence: 1 }
    },
    recommendations: [],
    ...overrides
  };
}

describe('security routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listLatestSecurityPosture).mockResolvedValue([]);
    vi.mocked(getSecurityPostureTrend).mockResolvedValue([]);
    vi.mocked(getLatestSecurityPostureForDevice).mockResolvedValue(null);
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

  describe('GET /security/dashboard', () => {
    it('should return dashboard data sourced from posture, trend, and telemetry-backed recommendations', async () => {
      mockStatusSelect([
        {
          deviceId: '6e69f4aa-7a2d-42b9-9a2b-7682f0f48a02',
          orgId: '11111111-1111-1111-1111-111111111111',
          deviceName: 'SFO-WS-207',
          os: 'windows',
          deviceState: 'online',
          provider: 'windows_defender',
          providerVersion: '1.0.0',
          definitionsVersion: '1.2.3',
          definitionsDate: new Date(),
          realTimeProtection: true,
          threatCount: 1,
          firewallEnabled: false,
          encryptionStatus: 'encrypted',
          encryptionDetails: null,
          localAdminSummary: { adminCount: 2, localAccountCount: 4, accounts: [{ username: 'Administrator', defaultAccount: true }] },
          passwordPolicySummary: { minLength: 12, complexityEnabled: true, maxAgeDays: 90, lockoutThreshold: 5, historyCount: 5 },
          gatekeeperEnabled: null,
          lastScan: new Date(),
          lastScanType: 'quick'
        },
        {
          deviceId: 'f1bd7f85-1df4-44aa-8147-6b4dba0b7e05',
          orgId: '11111111-1111-1111-1111-111111111111',
          deviceName: 'CHI-VM-022',
          os: 'macos',
          deviceState: 'online',
          provider: 'windows_defender',
          providerVersion: '1.0.0',
          definitionsVersion: '1.2.3',
          definitionsDate: new Date(),
          realTimeProtection: true,
          threatCount: 0,
          firewallEnabled: true,
          encryptionStatus: 'encrypted',
          encryptionDetails: null,
          localAdminSummary: { adminCount: 1, localAccountCount: 2, accounts: [{ username: 'admin' }] },
          passwordPolicySummary: { minLength: 14, complexityEnabled: true, maxAgeDays: 60, lockoutThreshold: 5, historyCount: 10 },
          gatekeeperEnabled: true,
          lastScan: new Date(),
          lastScanType: 'full'
        }
      ]);

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

      vi.mocked(listLatestSecurityPosture).mockResolvedValue([
        makePostureRow({
          overallScore: 62,
          riskLevel: 'high',
          factors: {
            patch_compliance: { score: 65, confidence: 1 },
            encryption: { score: 88, confidence: 1 },
            av_health: { score: 72, confidence: 1 },
            firewall: { score: 0, confidence: 1 },
            open_ports: { score: 60, confidence: 1 },
            password_policy: { score: 78, confidence: 1 },
            os_currency: { score: 73, confidence: 1 },
            admin_exposure: { score: 80, confidence: 1 }
          }
        }),
        makePostureRow({
          deviceId: 'f1bd7f85-1df4-44aa-8147-6b4dba0b7e05',
          deviceName: 'CHI-VM-022',
          osType: 'macos',
          overallScore: 82,
          riskLevel: 'low',
          factors: {
            patch_compliance: { score: 86, confidence: 1 },
            encryption: { score: 95, confidence: 1 },
            av_health: { score: 90, confidence: 1 },
            firewall: { score: 100, confidence: 1 },
            open_ports: { score: 80, confidence: 1 },
            password_policy: { score: 92, confidence: 1 },
            os_currency: { score: 80, confidence: 1 },
            admin_exposure: { score: 88, confidence: 1 }
          }
        })
      ] as any);

      vi.mocked(getSecurityPostureTrend).mockResolvedValue([
        { timestamp: '2026-02-08', overall: 68 },
        { timestamp: '2026-02-09', overall: 71 },
        { timestamp: '2026-02-10', overall: 72 }
      ] as any);

      const res = await app.request('/security/dashboard', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.totalDevices).toBe(2);
      expect(body.data.securityScore).toBe(72);
      expect(body.data.overallScore).toBe(72);
      expect(body.data.providers.length).toBeGreaterThan(0);
      expect(Array.isArray(body.data.recommendations)).toBe(true);
      expect(body.data.recommendations.length).toBeGreaterThan(0);
      expect(body.data.recommendations.some((rec: any) => rec.id === 'rec-enable-firewall')).toBe(true);
      expect(body.data.trend).toHaveLength(3);
      expect(body.data.passwordPolicyCompliance).toBe(85);
      expect(body.data.adminAudit.defaultAccounts).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /security/score-breakdown', () => {
    it('should return BE-9 weighted score components from posture snapshots', async () => {
      vi.mocked(listLatestSecurityPosture).mockResolvedValue([
        makePostureRow({
          overallScore: 80,
          factors: {
            patch_compliance: { score: 90, confidence: 1 },
            encryption: { score: 85, confidence: 1 },
            av_health: { score: 82, confidence: 1 },
            firewall: { score: 90, confidence: 1 },
            open_ports: { score: 70, confidence: 1 },
            password_policy: { score: 88, confidence: 1 },
            os_currency: { score: 76, confidence: 1 },
            admin_exposure: { score: 92, confidence: 1 }
          }
        }),
        makePostureRow({
          deviceId: 'f1bd7f85-1df4-44aa-8147-6b4dba0b7e05',
          deviceName: 'CHI-VM-022',
          overallScore: 60,
          factors: {
            patch_compliance: { score: 60, confidence: 1 },
            encryption: { score: 70, confidence: 1 },
            av_health: { score: 68, confidence: 1 },
            firewall: { score: 50, confidence: 1 },
            open_ports: { score: 55, confidence: 1 },
            password_policy: { score: 64, confidence: 1 },
            os_currency: { score: 69, confidence: 1 },
            admin_exposure: { score: 70, confidence: 1 }
          }
        })
      ] as any);

      const res = await app.request('/security/score-breakdown', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.overallScore).toBe(70);
      expect(body.data.devicesAudited).toBe(2);
      expect(body.data.components).toHaveLength(8);

      const patch = body.data.components.find((c: any) => c.category === 'patch_compliance');
      expect(patch).toBeTruthy();
      expect(patch.weight).toBe(25);
      expect(patch.score).toBe(75);
    });
  });

  describe('GET /security/password-policy', () => {
    it('should use ingested password policy telemetry for compliance and checks', async () => {
      mockStatusSelect([
        {
          deviceId: '6e69f4aa-7a2d-42b9-9a2b-7682f0f48a02',
          orgId: '11111111-1111-1111-1111-111111111111',
          deviceName: 'SFO-WS-207',
          os: 'windows',
          deviceState: 'online',
          provider: 'windows_defender',
          providerVersion: null,
          definitionsVersion: null,
          definitionsDate: null,
          realTimeProtection: true,
          threatCount: 0,
          firewallEnabled: true,
          encryptionStatus: 'encrypted',
          encryptionDetails: null,
          localAdminSummary: { adminCount: 2, localAccountCount: 4, accounts: [{ username: 'Administrator' }, { username: 'IT-Admin' }] },
          passwordPolicySummary: {
            minLength: 12,
            complexityEnabled: true,
            maxAgeDays: 60,
            lockoutThreshold: 5,
            historyCount: 10
          },
          gatekeeperEnabled: null,
          lastScan: null,
          lastScanType: null
        },
        {
          deviceId: 'f1bd7f85-1df4-44aa-8147-6b4dba0b7e05',
          orgId: '11111111-1111-1111-1111-111111111111',
          deviceName: 'CHI-VM-022',
          os: 'windows',
          deviceState: 'online',
          provider: 'windows_defender',
          providerVersion: null,
          definitionsVersion: null,
          definitionsDate: null,
          realTimeProtection: true,
          threatCount: 0,
          firewallEnabled: true,
          encryptionStatus: 'encrypted',
          encryptionDetails: null,
          localAdminSummary: { adminCount: 1, localAccountCount: 2, accounts: [{ username: 'Administrator' }] },
          passwordPolicySummary: {
            minLength: 8,
            complexityEnabled: false,
            maxAgeDays: 180,
            lockoutThreshold: 0,
            historyCount: 1
          },
          gatekeeperEnabled: null,
          lastScan: null,
          lastScanType: null
        }
      ]);

      const res = await app.request('/security/password-policy', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.summary.total).toBe(2);
      expect(body.summary.compliant).toBe(1);
      expect(body.summary.nonCompliant).toBe(1);
      expect(body.data.some((device: any) => device.compliant === false)).toBe(true);
      expect(body.data[0].checks.length).toBeGreaterThan(0);
    });
  });

  describe('GET /security/admin-audit', () => {
    it('should use ingested local admin summaries and aggregate issue counts', async () => {
      mockStatusSelect([
        {
          deviceId: '6e69f4aa-7a2d-42b9-9a2b-7682f0f48a02',
          orgId: '11111111-1111-1111-1111-111111111111',
          deviceName: 'SFO-WS-207',
          os: 'windows',
          deviceState: 'online',
          provider: 'windows_defender',
          providerVersion: null,
          definitionsVersion: null,
          definitionsDate: null,
          realTimeProtection: true,
          threatCount: 0,
          firewallEnabled: true,
          encryptionStatus: 'encrypted',
          encryptionDetails: null,
          passwordPolicySummary: null,
          localAdminSummary: {
            adminCount: 2,
            localAccountCount: 4,
            accounts: [
              {
                username: 'Administrator',
                isBuiltIn: true,
                enabled: true,
                passwordAgeDays: 220,
                lastLogin: '2025-01-01T00:00:00.000Z',
                issues: ['default_account', 'weak_password', 'stale_account']
              },
              { username: 'IT-Admin', isBuiltIn: false, enabled: true, passwordAgeDays: 15, issues: [] }
            ]
          },
          gatekeeperEnabled: null,
          lastScan: null,
          lastScanType: null
        },
        {
          deviceId: 'f1bd7f85-1df4-44aa-8147-6b4dba0b7e05',
          orgId: '11111111-1111-1111-1111-111111111111',
          deviceName: 'CHI-VM-022',
          os: 'windows',
          deviceState: 'online',
          provider: 'windows_defender',
          providerVersion: null,
          definitionsVersion: null,
          definitionsDate: null,
          realTimeProtection: true,
          threatCount: 0,
          firewallEnabled: true,
          encryptionStatus: 'encrypted',
          encryptionDetails: null,
          passwordPolicySummary: null,
          localAdminSummary: {
            adminCount: 1,
            localAccountCount: 2,
            accounts: [{ username: 'Helpdesk', isBuiltIn: false, enabled: true, passwordAgeDays: 20, issues: [] }]
          },
          gatekeeperEnabled: null,
          lastScan: null,
          lastScanType: null
        }
      ]);

      const res = await app.request('/security/admin-audit?issue=weak_password', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.summary.totalDevices).toBe(1);
      expect(body.summary.weakPasswords).toBeGreaterThanOrEqual(1);
      expect(body.data[0].issueTypes).toContain('weak_password');
    });
  });

  describe('GET /security/recommendations', () => {
    it('should return BE-9 recommendations with persisted action statuses', async () => {
      vi.mocked(listLatestSecurityPosture).mockResolvedValue([
        makePostureRow({
          overallScore: 52,
          riskLevel: 'high',
          factors: {
            patch_compliance: { score: 60, confidence: 1 },
            encryption: { score: 70, confidence: 1 },
            av_health: { score: 65, confidence: 1 },
            firewall: { score: 0, confidence: 1 },
            open_ports: { score: 40, confidence: 1 },
            password_policy: { score: 65, confidence: 1 },
            os_currency: { score: 55, confidence: 1 },
            admin_exposure: { score: 75, confidence: 1 }
          }
        })
      ] as any);

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
      mockAuditLogSelect([
        {
          action: 'security.recommendation.complete',
          resourceName: 'rec-enable-firewall',
          details: null,
          timestamp: new Date()
        }
      ]);

      const res = await app.request('/security/recommendations?status=completed', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data[0].id).toBe('rec-enable-firewall');
      expect(body.data[0].status).toBe('completed');
    });
  });

  describe('POST /security/recommendations/:id/complete', () => {
    it('should complete a generated BE-9 recommendation', async () => {
      vi.mocked(listLatestSecurityPosture).mockResolvedValue([
        makePostureRow({
          factors: {
            patch_compliance: { score: 85, confidence: 1 },
            encryption: { score: 80, confidence: 1 },
            av_health: { score: 88, confidence: 1 },
            firewall: { score: 0, confidence: 1 },
            open_ports: { score: 85, confidence: 1 },
            password_policy: { score: 90, confidence: 1 },
            os_currency: { score: 90, confidence: 1 },
            admin_exposure: { score: 90, confidence: 1 }
          }
        })
      ] as any);
      mockThreatSelect([]);

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined)
      } as any);

      const res = await app.request('/security/recommendations/rec-enable-firewall/complete', {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe('rec-enable-firewall');
      expect(body.data.status).toBe('completed');
      expect(db.insert).toHaveBeenCalledTimes(1);
    });
  });
});
