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

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve())
      }))
    })),
    transaction: vi.fn()
  }
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
  securityStatus: {},
  securityThreats: {},
  securityScans: {}
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c, next) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

vi.mock('../middleware/agentAuth', () => ({
  agentAuthMiddleware: vi.fn((c, next) => {
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
    app = new Hono();
    app.route('/agents', agentRoutes);
  });

  describe('POST /agents/enroll', () => {
    it('should enroll an agent with a valid enrollment key', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'key-123',
                key: 'enroll-key',
                orgId: 'org-123',
                siteId: 'site-123'
              }])
            })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([])
            })
          })
        } as any);

      const tx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'device-123'
            }])
          })
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined)
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
      vi.mocked(db.select).mockReturnValue({
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
    it('should store command results', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'cmd-1',
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

      const res = await app.request('/agents/agent-123/commands/cmd-1/result', {
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

      const res = await app.request('/agents/agent-123/commands/missing/result', {
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
              id: 'cmd-fs-1',
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

      const res = await app.request('/agents/agent-123/commands/cmd-fs-1/result', {
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
              id: 'cmd-fs-2',
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

      const res = await app.request('/agents/agent-123/commands/cmd-fs-2/result', {
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
});
