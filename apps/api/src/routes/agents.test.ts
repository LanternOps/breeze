import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { agentRoutes } from './agents';

vi.mock('../services', () => ({}));
vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => ({
    multi: vi.fn(),
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
  })),
}));
vi.mock('../services/rate-limit', () => ({
  rateLimiter: vi.fn(async () => ({
    allowed: true,
    remaining: 9,
    resetAt: new Date(Date.now() + 60_000),
  })),
}));
vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn()
}));
vi.mock('../services/filesystemAnalysis', () => ({
  parseFilesystemAnalysisStdout: vi.fn(() => ({ summary: { filesScanned: 1 } })),
  saveFilesystemSnapshot: vi.fn(() => Promise.resolve({ id: 'snapshot-1' })),
  getFilesystemScanState: vi.fn(() => Promise.resolve(null)),
  mergeFilesystemAnalysisPayload: vi.fn((_existing, incoming) => incoming),
  readCheckpointPendingDirectories: vi.fn(() => []),
  readHotDirectories: vi.fn(() => []),
  upsertFilesystemScanState: vi.fn(() => Promise.resolve({ deviceId: 'device-123' })),
}));

const defaultSelectChain = () => ({
  from: vi.fn(() => ({
    where: vi.fn(() => Object.assign(Promise.resolve([]), {
      limit: vi.fn(() => Promise.resolve([])),
      orderBy: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve([]))
      }))
    }))
  }))
});

const defaultInsertChain = () => ({
  values: vi.fn(() => ({
    onConflictDoNothing: vi.fn(() => ({
      returning: vi.fn(() => Promise.resolve([]))
    })),
    returning: vi.fn(() => Promise.resolve([]))
  }))
});

const defaultUpdateChain = () => ({
  set: vi.fn(() => ({
    where: vi.fn(() => Object.assign(Promise.resolve(undefined), {
      returning: vi.fn(() => Promise.resolve([]))
    }))
  }))
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => defaultSelectChain()),
    insert: vi.fn(() => defaultInsertChain()),
    update: vi.fn(() => defaultUpdateChain()),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve())
    })),
    transaction: vi.fn()
  },
  withDbAccessContext: vi.fn(async (_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, accessibleOrgIds: null }
}));

vi.mock('../db/schema', () => ({
  devices: {},
  deviceHardware: {},
  deviceNetwork: {},
  deviceMetrics: {},
  deviceFilesystemSnapshots: {},
  deviceCommands: {},
  automationPolicies: {
    rules: 'rules',
    orgId: 'orgId',
    enabled: 'enabled'
  },
  enrollmentKeys: {},
  deviceDisks: {},
  deviceRegistryState: {},
  deviceConfigState: {},
  deviceConnections: {},
  softwareInventory: {},
  patches: {},
  devicePatches: {},
  deviceEventLogs: {},
  deviceChangeLog: {},
  securityStatus: {},
  securityThreats: {},
  securityScans: {},
  deviceSessions: {},
  agentVersions: {},
  organizations: {},
  peripheralEventTypeEnum: { enumValues: ['connected', 'disconnected', 'blocked', 'allowed'] },
  backupJobs: {},
  patchPolicies: {},
  alertRules: {},
  backupConfigs: { orgId: 'orgId' },
  securityPolicies: { orgId: 'orgId' },
  configurationPolicies: {},
  deviceGroupMemberships: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {},
}));

vi.mock('../services/enrollmentKeySecurity', () => ({
  hashEnrollmentKey: vi.fn((key: string) => `hashed-${key}`),
  generateEnrollmentKey: vi.fn(() => 'ek_test123')
}));

vi.mock('../services/cloudflareMtls', () => ({
  CloudflareMtlsService: {
    fromEnv: vi.fn(() => null)
  }
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn().mockResolvedValue('event-id'),
  getEventBus: vi.fn(() => ({ subscribe: vi.fn(), publish: vi.fn() })),
  EventType: {}
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('./backup/verificationService', () => ({
  processBackupVerificationResult: vi.fn(),
}));

vi.mock('../services/vaultSyncPersistence', () => ({
  applyVaultSyncCommandResult: vi.fn(),
}));

vi.mock('../services/restoreResultPersistence', () => ({
  updateRestoreJobByCommandId: vi.fn(),
}));

vi.mock('../services/commandQueue', () => ({
  queueCommandForExecution: vi.fn(),
  CommandTypes: {
    COLLECT_AUDIT_POLICY: 'collect_audit_policy',
    APPLY_AUDIT_POLICY_BASELINE: 'apply_audit_policy_baseline',
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next())
}));

vi.mock('../middleware/agentAuth', () => ({
  agentAuthMiddleware: vi.fn((c: any, next: any) => {
    c.set('agent', {
      deviceId: 'device-123',
      agentId: 'agent-123',
      orgId: 'org-123',
      siteId: 'site-123'
    });
    return next();
  }),
  isAgentTokenRotationDue: vi.fn(() => false),
}));

vi.mock('../services/commandDispatch', () => ({
  claimPendingCommandsForDevice: vi.fn().mockResolvedValue([]),
}));

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { saveFilesystemSnapshot } from '../services/filesystemAnalysis';
import { queueCommandForExecution } from '../services/commandQueue';
import { processBackupVerificationResult } from './backup/verificationService';
import { claimPendingCommandsForDevice } from '../services/commandDispatch';

describe('agent routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset db mock implementations to factory defaults (clearAllMocks doesn't reset mockReturnValue)
    vi.mocked(db.select).mockImplementation(() => defaultSelectChain() as any);
    vi.mocked(db.insert).mockImplementation(() => defaultInsertChain() as any);
    vi.mocked(db.update).mockImplementation(() => defaultUpdateChain() as any);
    vi.mocked(db.transaction).mockReset();
    app = new Hono();
    app.route('/agents', agentRoutes);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('POST /agents/enroll', () => {
    it('blocks enrollment in production when no enrollment secret is configured', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('AGENT_ENROLLMENT_SECRET', '');

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'key-123',
              orgId: 'org-123',
              siteId: 'site-123',
              keySecretHash: null,
            }])
          })
        })
      } as any);

      const res = await app.request('/agents/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollmentKey: 'enroll-key',
          hostname: 'agent-host',
          osType: 'linux',
          osVersion: '1.0',
          architecture: 'x86_64',
          agentVersion: '2.0'
        })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Enrollment secret required');
    });

    it('allows enrollment in development without enrollment secret', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('AGENT_ENROLLMENT_SECRET', '');

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'key-123',
              orgId: 'org-123',
              siteId: 'site-123',
              keySecretHash: null,
            }])
          })
        })
      } as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'key-123',
              key: 'hashed-enroll-key',
              orgId: 'org-123',
              siteId: 'site-123',
              usageCount: 1
            }])
          })
        })
      } as any);

      // Then checks for existing device: db.select().from(devices).where(...).limit(1)
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(Object.assign(Promise.resolve([]), {
            limit: vi.fn().mockResolvedValue([])
          }))
        })
      } as any);

      const tx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'device-123',
              orgId: 'org-123',
              siteId: 'site-123',
              agentId: 'agent-new',
              hostname: 'agent-host',
              osType: 'linux',
              osVersion: '1.0',
              architecture: 'x86_64',
              agentVersion: '2.0',
              status: 'online'
            }])
          })
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([])
            })
          })
        })
      };
      vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as any));

      const res = await app.request('/agents/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollmentKey: 'enroll-key',
          hostname: 'agent-host',
          osType: 'linux',
          osVersion: '1.0',
          architecture: 'x86_64',
          agentVersion: '2.0'
        })
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.agentId).toBeDefined();
      expect(body.deviceId).toBe('device-123');
      expect(body.authToken).toBeDefined();
      expect(body.orgId).toBe('org-123');
      expect(body.siteId).toBe('site-123');
      expect(body.config).toBeDefined();
    });

    it('requires the configured global enrollment secret when a key has no per-key secret', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('AGENT_ENROLLMENT_SECRET', 'global-secret');

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'key-123',
              orgId: 'org-123',
              siteId: 'site-123',
              keySecretHash: null,
            }])
          })
        })
      } as any);

      const res = await app.request('/agents/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollmentKey: 'enroll-key',
          hostname: 'agent-host',
          osType: 'linux',
          osVersion: '1.0',
          architecture: 'x86_64',
          agentVersion: '2.0'
        })
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Enrollment secret required' });
    });

    it('accepts the configured global enrollment secret when present', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('AGENT_ENROLLMENT_SECRET', 'global-secret');

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'key-123',
              orgId: 'org-123',
              siteId: 'site-123',
              keySecretHash: null,
            }])
          })
        })
      } as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'key-123',
              key: 'hashed-enroll-key',
              orgId: 'org-123',
              siteId: 'site-123',
              usageCount: 1
            }])
          })
        })
      } as any);

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(Object.assign(Promise.resolve([]), {
            limit: vi.fn().mockResolvedValue([])
          }))
        })
      } as any);

      const tx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'device-123',
              orgId: 'org-123',
              siteId: 'site-123',
              agentId: 'agent-new',
              hostname: 'agent-host',
              osType: 'linux',
              osVersion: '1.0',
              architecture: 'x86_64',
              agentVersion: '2.0',
              status: 'online'
            }])
          })
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([])
            })
          })
        })
      };
      vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as any));

      const res = await app.request('/agents/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollmentKey: 'enroll-key',
          enrollmentSecret: 'global-secret',
          hostname: 'agent-host',
          osType: 'linux',
          osVersion: '1.0',
          architecture: 'x86_64',
          agentVersion: '2.0'
        })
      });

      expect(res.status).toBe(201);
    });

    it('should reject invalid enrollment keys', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/agents/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollmentKey: 'bad-key',
          hostname: 'agent-host',
          osType: 'linux',
          osVersion: '1.0',
          architecture: 'x86_64',
          agentVersion: '2.0'
        })
      });

      expect(res.status).toBe(401);
    });

    it('accepts a matching per-key enrollment secret', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('AGENT_ENROLLMENT_SECRET', '');

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'key-123',
              orgId: 'org-123',
              siteId: 'site-123',
              keySecretHash: createHash('sha256').update('per-key-secret').digest('hex'),
            }])
          })
        })
      } as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'key-123',
              key: 'hashed-enroll-key',
              orgId: 'org-123',
              siteId: 'site-123',
              usageCount: 1,
            }])
          })
        })
      } as any);

      const tx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'device-123',
              orgId: 'org-123',
              siteId: 'site-123',
              agentId: 'agent-new',
              hostname: 'agent-host',
              osType: 'linux',
              osVersion: '1.0',
              architecture: 'x86_64',
              agentVersion: '2.0',
              status: 'online'
            }])
          })
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([])
            })
          })
        })
      };
      vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as any));

      const res = await app.request('/agents/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollmentKey: 'enroll-key',
          enrollmentSecret: 'per-key-secret',
          hostname: 'agent-host',
          osType: 'linux',
          osVersion: '1.0',
          architecture: 'x86_64',
          agentVersion: '2.0'
        })
      });

      expect(res.status).toBe(201);
    });

    it('rejects a mismatched per-key enrollment secret', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('AGENT_ENROLLMENT_SECRET', '');

      const incrementReturning = vi.fn().mockResolvedValue([{
        id: 'key-123',
        key: 'hashed-enroll-key',
        orgId: 'org-123',
        siteId: 'site-123',
        usageCount: 1,
      }]);

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'key-123',
              orgId: 'org-123',
              siteId: 'site-123',
              keySecretHash: createHash('sha256').update('per-key-secret').digest('hex'),
            }])
          })
        })
      } as any);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: incrementReturning
          })
        })
      } as any);

      const res = await app.request('/agents/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollmentKey: 'enroll-key',
          enrollmentSecret: 'wrong-secret',
          hostname: 'agent-host',
          osType: 'linux',
          osVersion: '1.0',
          architecture: 'x86_64',
          agentVersion: '2.0'
        })
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Invalid enrollment secret' });
      expect(incrementReturning).not.toHaveBeenCalled();
    });

    it('prefers the per-key secret over the configured global secret', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('AGENT_ENROLLMENT_SECRET', 'global-secret');

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'key-123',
              orgId: 'org-123',
              siteId: 'site-123',
              keySecretHash: createHash('sha256').update('per-key-secret').digest('hex'),
            }])
          })
        })
      } as any);

      const res = await app.request('/agents/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enrollmentKey: 'enroll-key',
          enrollmentSecret: 'global-secret',
          hostname: 'agent-host',
          osType: 'linux',
          osVersion: '1.0',
          architecture: 'x86_64',
          agentVersion: '2.0'
        })
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Invalid enrollment secret' });
    });
  });

  describe('POST /agents/:id/heartbeat', () => {
    it('should return pending commands and store metrics', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'device-123',
                agentId: 'agent-123'
              }])
            })
          })
        } as any);

      vi.mocked(claimPendingCommandsForDevice).mockResolvedValueOnce([{
        id: 'cmd-1',
        type: 'script',
        payload: { scriptId: 'script-1' }
      }] as any);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const insertValues = vi.fn().mockResolvedValue(undefined);
      vi.mocked(db.insert).mockReturnValue({
        values: insertValues
      } as any);

      const res = await app.request('/agents/agent-123/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metrics: {
            cpuPercent: 10,
            ramPercent: 20,
            ramUsedMb: 1024,
            diskPercent: 30,
            diskUsedGb: 100,
            diskActivityAvailable: true,
            diskReadBytes: 2048,
            diskWriteBytes: 1024,
            diskReadBps: 512,
            diskWriteBps: 256,
            diskReadOps: 12,
            diskWriteOps: 6
          },
          status: 'ok',
          agentVersion: '2.0'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.commands).toHaveLength(1);
      expect(body.commands[0].id).toBe('cmd-1');
      expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
        diskActivityAvailable: true,
        diskReadBytes: BigInt(2048),
        diskWriteBytes: BigInt(1024),
        diskReadBps: BigInt(512),
        diskWriteBps: BigInt(256),
        diskReadOps: BigInt(12),
        diskWriteOps: BigInt(6),
      }));
    });

    it('returns deduplicated policy probe config updates', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'device-123',
                agentId: 'agent-123',
                orgId: 'org-123'
              }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                rules: [
                  { type: 'registry_check', registryPath: 'HKLM\\SOFTWARE\\Policies\\Zeta', registryValueName: 'Enabled' },
                  { type: 'config_check', configFilePath: '/etc/ssh/sshd_config', configKey: 'PermitRootLogin' }
                ]
              },
              {
                rules: [
                  { type: 'registry_check', registry_path: 'HKLM\\SOFTWARE\\Policies\\Alpha', registry_value_name: 'Flag' },
                  { type: 'config_check', configFilePath: '/etc/ssh/sshd_config', configKey: 'PermitRootLogin' }
                ]
              }
            ])
          })
        } as any);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined)
      } as any);

      const res = await app.request('/agents/agent-123/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metrics: {
            cpuPercent: 10,
            ramPercent: 20,
            ramUsedMb: 1024,
            diskPercent: 30,
            diskUsedGb: 100
          },
          status: 'ok',
          agentVersion: '2.0'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.configUpdate).toEqual({
        event_log_settings: {
          max_events_per_cycle: 100,
          collect_categories: ['security', 'hardware', 'application', 'system'],
          minimum_level: 'info',
          collection_interval_minutes: 5,
        },
        policy_registry_state_probes: [
          { registry_path: 'HKLM\\SOFTWARE\\Policies\\Alpha', value_name: 'Flag' },
          { registry_path: 'HKLM\\SOFTWARE\\Policies\\Zeta', value_name: 'Enabled' }
        ],
        policy_config_state_probes: [
          { file_path: '/etc/ssh/sshd_config', config_key: 'PermitRootLogin' }
        ]
      });
    });

    it('should return 404 when device is missing', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/agents/agent-404/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metrics: {
            cpuPercent: 10,
            ramPercent: 20,
            ramUsedMb: 1024,
            diskPercent: 30,
            diskUsedGb: 100
          },
          status: 'ok',
          agentVersion: '2.0'
        })
      });

      expect(res.status).toBe(404);
    });

    it('queues a threshold filesystem scan when disk usage is high', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'device-123',
                agentId: 'agent-123',
                orgId: 'org-123',
                osType: 'windows'
              }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([])
              })
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([])
              })
            })
          })
        } as any);

      vi.mocked(claimPendingCommandsForDevice).mockResolvedValueOnce([{
        id: 'cmd-filesystem-1',
        type: 'filesystem_analysis',
        payload: { path: 'C:\\', trigger: 'threshold' }
      }] as any);

      const insertValues = vi.fn().mockResolvedValue(undefined);
      vi.mocked(db.insert).mockReturnValue({
        values: insertValues
      } as any);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const res = await app.request('/agents/agent-123/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metrics: {
            cpuPercent: 20,
            ramPercent: 30,
            ramUsedMb: 2048,
            diskPercent: 92,
            diskUsedGb: 200
          },
          status: 'warning',
          agentVersion: '2.0'
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.commands).toHaveLength(1);
      expect(body.commands[0].type).toBe('filesystem_analysis');
      expect(body.configUpdate).toEqual({
        event_log_settings: {
          max_events_per_cycle: 100,
          collect_categories: ['security', 'hardware', 'application', 'system'],
          minimum_level: 'info',
          collection_interval_minutes: 5,
        },
        policy_registry_state_probes: [],
        policy_config_state_probes: []
      });
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'filesystem_analysis',
          status: 'pending',
          payload: expect.objectContaining({
            trigger: 'threshold',
            path: 'C:\\'
          })
        })
      );
    });
  });

  describe('POST /agents/:id/commands/:commandId/result', () => {
    it('accepts non-UUID command IDs without querying device_commands', async () => {
      const res = await app.request('/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/commands/mon-test-123/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'completed',
          durationMs: 15
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(db.select).not.toHaveBeenCalled();
    });

    // Regression for PR #435: agent IDs in the URL path are 64-char SHA-256
    // hex (cfg.AgentID), not UUIDs. Exercises the full agentRoutes mount so
    // the dispatch chain (`/:id/*` use → commandsRoutes → param validator)
    // is verified end-to-end against the production identifier format.
    it('accepts 64-char SHA-256 hex agent IDs end-to-end', async () => {
      const hexAgentId = 'ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776';
      const res = await app.request(`/agents/${hexAgentId}/commands/mon-test-456/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'completed',
          durationMs: 25
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('should store command results', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{
                  id: '33333333-3333-4333-8333-333333333333',
                  status: 'sent'
                }])
              })
            })
          } as any);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const res = await app.request('/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/commands/33333333-3333-4333-8333-333333333333/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'completed',
          exitCode: 0,
          stdout: 'ok',
          durationMs: 1200
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    it('should return 404 for unknown commands', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([])
          })
        })
      } as any);

      const res = await app.request('/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/commands/44444444-4444-4444-8444-444444444444/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'failed',
          durationMs: 500
        })
      });

      expect(res.status).toBe(404);
    });

    it('rejects malformed critical verification payloads without downstream mutation', async () => {
      const updateWhere = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: '99999999-9999-4999-8999-999999999999' }])
      });
      const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
      vi.mocked(db.update).mockReturnValue({ set: updateSet } as any);

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: '99999999-9999-4999-8999-999999999999',
              type: 'backup_verify',
              status: 'sent',
              payload: {},
              deviceId: 'device-123',
              createdAt: new Date()
            }])
          })
        })
      } as any);

      const res = await app.request('/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/commands/99999999-9999-4999-8999-999999999999/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'completed',
          result: {
            filesVerified: 10
          }
        })
      });

      expect(res.status).toBe(200);
      expect(vi.mocked(processBackupVerificationResult)).not.toHaveBeenCalled();
      expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
        status: 'failed',
        result: expect.objectContaining({
          error: expect.stringContaining('Rejected malformed backup_verify result'),
        }),
      }));
    });

    it('persists threshold filesystem analysis command results', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{
                  id: '55555555-5555-4555-8555-555555555555',
                  type: 'filesystem_analysis',
                  payload: { trigger: 'threshold' },
                  deviceId: 'device-123',
              createdAt: new Date()
            }])
          })
        })
      } as any);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: '55555555-5555-4555-8555-555555555555' }])
          })
        })
      } as any);

      const res = await app.request('/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/commands/55555555-5555-4555-8555-555555555555/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'completed',
          exitCode: 0,
          stdout: '{"summary":{"filesScanned":10}}',
          durationMs: 800
        })
      });

      expect(res.status).toBe(200);
      expect(saveFilesystemSnapshot).toHaveBeenCalled();
      const [sfDeviceId, , sfTrigger, sfPayload] =
        vi.mocked(saveFilesystemSnapshot).mock.calls[0]!;
      expect(sfDeviceId).toBe('device-123');
      expect(sfTrigger).toBe('threshold');
      expect(sfPayload).toEqual(expect.any(Object));
    });

    it('persists on-demand filesystem analysis command results', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{
                  id: '66666666-6666-4666-8666-666666666666',
                  type: 'filesystem_analysis',
                  payload: { trigger: 'on_demand' },
                  deviceId: 'device-123',
              createdAt: new Date()
            }])
          })
        })
      } as any);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: '66666666-6666-4666-8666-666666666666' }])
          })
        })
      } as any);

      const res = await app.request('/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/commands/66666666-6666-4666-8666-666666666666/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'completed',
          exitCode: 0,
          stdout: '{"summary":{"filesScanned":42}}',
          durationMs: 750
        })
      });

      expect(res.status).toBe(200);
      expect(saveFilesystemSnapshot).toHaveBeenCalled();
      const [sfDeviceId, , sfTrigger, sfPayload] =
        vi.mocked(saveFilesystemSnapshot).mock.calls[0]!;
      expect(sfDeviceId).toBe('device-123');
      expect(sfTrigger).toBe('on_demand');
      expect(sfPayload).toEqual(expect.any(Object));
    });

    it('queues post-apply audit policy collection outside request transaction', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: '77777777-7777-4777-8777-777777777777',
              type: 'apply_audit_policy_baseline',
              deviceId: 'device-123',
              createdAt: new Date()
            }])
          })
        })
      } as any);

      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: '77777777-7777-4777-8777-777777777777' }])
          })
        })
      } as any);

      vi.mocked(queueCommandForExecution).mockResolvedValue({
        command: {
          id: '88888888-8888-4888-8888-888888888888',
          deviceId: 'device-123',
          type: 'collect_audit_policy',
          payload: {},
          status: 'pending',
          createdBy: null,
          createdAt: new Date(),
          executedAt: null,
          completedAt: null,
          result: null
        }
      } as any);

      const res = await app.request('/agents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/commands/77777777-7777-4777-8777-777777777777/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'completed',
          exitCode: 0,
          stdout: '{"applied":1}',
          durationMs: 900
        })
      });

      expect(res.status).toBe(200);
      // runOutsideDbContext is called 3 times: command lookup, command update, and audit policy queueing
      expect(vi.mocked(runOutsideDbContext)).toHaveBeenCalledTimes(3);
      expect(vi.mocked(withSystemDbAccessContext)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(queueCommandForExecution)).toHaveBeenCalledWith(
        'device-123',
        'collect_audit_policy',
        {},
        { preferHeartbeat: false }
      );
    });
  });

  describe('PUT /agents/:id/patches', () => {
    it('accepts installed patches with empty installedAt values', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'device-123',
              agentId: 'agent-123',
              osType: 'windows',
              orgId: 'org-123'
            }])
          })
        })
      } as any);

      const pendingInsertValues = vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'patch-1'
          }])
        })
      });

      const devicePatchInsertValues = vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined)
      });

      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined)
          })
        }),
        insert: vi.fn()
          .mockReturnValueOnce({
            values: pendingInsertValues
          })
          .mockReturnValueOnce({
            values: devicePatchInsertValues
          })
      };

      vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx as any));

      const res = await app.request('/agents/agent-123/patches', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patches: [],
          installed: [
            {
              name: 'Security Intelligence Update for Microsoft Defender',
              source: 'microsoft',
              category: 'definitions',
              installedAt: ''
            }
          ]
        })
      });

      expect(res.status).toBe(200);
      expect(devicePatchInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          installedAt: null
        })
      );
    });
  });

  describe('PUT /agents/:id/changes', () => {
    it('accepts and stores change tracking payloads', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'device-123',
              agentId: 'agent-123',
              orgId: 'org-123'
            }])
          })
        })
      } as any);

      const returning = vi.fn().mockResolvedValue([{ id: 'change-1' }]);
      const onConflictDoNothing = vi.fn().mockReturnValue({
        returning
      });
      const insertValues = vi.fn().mockReturnValue({
        onConflictDoNothing
      });
      vi.mocked(db.insert).mockReturnValue({
        values: insertValues
      } as any);

      const res = await app.request('/agents/agent-123/changes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          changes: [
            {
              timestamp: '2026-02-21T19:00:00Z',
              changeType: 'software',
              changeAction: 'updated',
              subject: 'Google Chrome',
              beforeValue: { version: '121.0.0' },
              afterValue: { version: '122.0.0' }
            }
          ]
        })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.count).toBe(1);
      expect(insertValues).toHaveBeenCalledWith([
        expect.objectContaining({
          deviceId: 'device-123',
          orgId: 'org-123',
          changeType: 'software',
          changeAction: 'updated',
          subject: 'Google Chrome'
        })
      ]);
      expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
      expect(returning).toHaveBeenCalledTimes(1);
    });
  });
});
