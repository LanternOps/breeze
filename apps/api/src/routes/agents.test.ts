import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { agentRoutes } from './agents';

vi.mock('../services', () => ({}));
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
  organizations: {}
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
  publishEvent: vi.fn(),
  getEventBus: vi.fn(() => ({ subscribe: vi.fn(), publish: vi.fn() })),
  EventType: {}
}));

vi.mock('../services/commandQueue', () => ({
  queueCommandForExecution: vi.fn()
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
  })
}));

import { db } from '../db';
import { saveFilesystemSnapshot } from '../services/filesystemAnalysis';

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

  describe('POST /agents/enroll', () => {
    it('should enroll an agent with a valid enrollment key', async () => {
      // Enrollment now does: db.update(enrollmentKeys).set(...).where(...).returning()
      // to atomically validate and increment key usage
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

    it('should reject invalid enrollment keys', async () => {
      // db.update().set().where().returning() returns empty = invalid key
      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([])
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
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{
                  id: 'cmd-1',
                  type: 'script',
                  payload: { scriptId: 'script-1' }
                }])
              })
            })
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
      expect(body.commands).toHaveLength(1);
      expect(body.commands[0].id).toBe('cmd-1');
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
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([])
              })
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
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{
                  id: 'cmd-filesystem-1',
                  type: 'filesystem_analysis',
                  payload: { path: 'C:\\', trigger: 'threshold' }
                }])
              })
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([])
          })
        } as any);

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
      const res = await app.request('/agents/agent-123/commands/mon-test-123/result', {
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

      const res = await app.request('/agents/agent-123/commands/33333333-3333-4333-8333-333333333333/result', {
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

      const res = await app.request('/agents/agent-123/commands/44444444-4444-4444-8444-444444444444/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'failed',
          durationMs: 500
        })
      });

      expect(res.status).toBe(404);
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
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const res = await app.request('/agents/agent-123/commands/55555555-5555-4555-8555-555555555555/result', {
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
      expect(saveFilesystemSnapshot).toHaveBeenCalledWith(
        'device-123',
        'threshold',
        expect.any(Object)
      );
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
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

      const res = await app.request('/agents/agent-123/commands/66666666-6666-4666-8666-666666666666/result', {
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
      expect(saveFilesystemSnapshot).toHaveBeenCalledWith(
        'device-123',
        'on_demand',
        expect.any(Object)
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
