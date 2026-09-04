import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { scriptRoutes } from './scripts';

// Valid UUID constants for tests
const SCRIPT_ID_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SCRIPT_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORG_ID_2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PARTNER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OTHER_PARTNER_ID = 'abababab-abab-4bab-8bab-abababababab';
const EXECUTION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

// Mock all services
vi.mock('../services', () => ({}));

const { executeScriptOnDevicesMock } = vi.hoisted(() => ({
  executeScriptOnDevicesMock: vi.fn(),
}));

const { applyAutomationActionTerminalMock } = vi.hoisted(() => ({
  applyAutomationActionTerminalMock: vi.fn().mockResolvedValue(true),
}));

vi.mock('../services/scriptExecution', () => ({
  executeScriptOnDevices: executeScriptOnDevicesMock,
}));

vi.mock('../services/automationActionResults', () => ({
  applyAutomationActionTerminal: (...args: unknown[]) =>
    applyAutomationActionTerminalMock(...(args as [])),
}));

vi.mock('../services/auditEvents', () => ({
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
  writeRouteAudit: vi.fn()
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
        where: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve())
    }))
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn())
}));

vi.mock('../db/schema', () => ({
  scripts: { id: 'scripts.id', updatedAt: 'scripts.updatedAt' },
  // POST /scripts/:id/clone (#4887) reads/writes tags via scriptBundle's
  // ensureTagIds/linkTags helpers, which key off these two column refs.
  scriptTags: { id: 'stg.id', name: 'stg.name', orgId: 'stg.orgId', partnerId: 'stg.partnerId' },
  scriptToTags: { scriptId: 'stt.scriptId', tagId: 'stt.tagId' },
  scriptExecutions: {},
  scriptExecutionBatches: {},
  devices: {},
  deviceCommands: {},
  organizations: { id: 'o.id', partnerId: 'o.partnerId' },
  patchPolicies: {},
  configPolicyComplianceRules: {},
  configPolicyFeatureLinks: {},
  configurationPolicies: {},
  alertRules: {},
  backupConfigs: {},
  securityPolicies: {},
  automationPolicies: {},
  maintenanceWindows: {},
  softwarePolicies: {},
  sensitiveDataPolicies: {},
  peripheralPolicies: {},
  // tenantVariableResolution.ts's scope query (#3409 PR2, via
  // findSecretVariableReferences) joins these two.
  tenantVariables: {
    id: 'tv.id',
    key: 'tv.key',
    value: 'tv.value',
    isSecret: 'tv.isSecret',
    version: 'tv.version',
    orgId: 'tv.orgId',
    partnerId: 'tv.partnerId'
  },
  discoveredAssetTypeEnum: { enumValues: ['workstation', 'server', 'printer', 'unknown'] }
}));

// Spy on `desc` while keeping the real implementation, so the pagination
// tiebreaker test can assert exactly which columns were passed to it without
// changing behavior for the rest of the file's tests.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, desc: vi.fn(actual.desc) };
});

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      token: {
        sub: 'user-123',
        email: 'test@example.com',
        roleId: 'role-123',
        orgId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        partnerId: null,
        scope: 'organization',
        type: 'access',
        mfa: true,
      },
      accessibleOrgIds: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
      canAccessOrg: (orgId: string) => orgId === 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    if (c.req.header('x-site-restricted') === 'true') {
      c.set('permissions', {
        permissions: [{ resource, action }],
        partnerId: null,
        orgId: ORG_ID,
        roleId: 'role-123',
        scope: 'organization',
        allowedSiteIds: ['site-allowed']
      });
    }
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

import { desc } from 'drizzle-orm';
import { db } from '../db';
import { scripts } from '../db/schema';
import { writeRouteAudit } from '../services/auditEvents';

describe('scripts routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/scripts', scriptRoutes);
  });

  it('should list scripts with pagination', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 2 }])
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([
                  { id: SCRIPT_ID_1, name: 'Script One' },
                  { id: SCRIPT_ID_2, name: 'Script Two' }
                ])
              })
            })
          })
        })
      } as any);

    const res = await app.request('/scripts?limit=10&page=1', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.pagination.total).toBe(2);
  });

  // #3462: apps/web/src/lib/scriptsFetch.ts pages through GET /scripts with
  // LIMIT/OFFSET. `updated_at` defaults to the TRANSACTION timestamp, so a
  // bundle import writes many scripts with a byte-identical value — ordering
  // on that alone leaves row order undefined between two page fetches, and
  // the walk would silently drop a script and duplicate another. The unique
  // `id` tiebreaker is what makes the walk a true enumeration.
  it('appends a unique id tiebreaker to the sort so paging is stable', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 0 }])
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([])
              })
            })
          })
        })
      } as any);

    const res = await app.request('/scripts?limit=10&page=1', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    expect(desc).toHaveBeenNthCalledWith(1, scripts.updatedAt);
    expect(desc).toHaveBeenNthCalledWith(2, scripts.id);
  });

  it('should get a script by id', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: SCRIPT_ID_1,
            name: 'Script One',
            isSystem: false,
            orgId: ORG_ID
          }])
        })
      })
    } as any);

    const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(SCRIPT_ID_1);
  });

  it('should create a script', async () => {
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: SCRIPT_ID_1,
          name: 'Install Agent',
          orgId: ORG_ID
        }])
      })
    } as any);

    const res = await app.request('/scripts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({
        name: 'Install Agent',
        description: 'Installs the agent',
        category: 'setup',
        osTypes: ['linux'],
        language: 'bash',
        content: 'echo hello',
        timeoutSeconds: 300,
        runAs: 'system'
      })
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe(SCRIPT_ID_1);
  });

  it('should accept timeoutSeconds at the 3600 executor cap on create', async () => {
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: SCRIPT_ID_1,
          name: 'Long Script',
          orgId: ORG_ID
        }])
      })
    } as any);

    const res = await app.request('/scripts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({
        name: 'Long Script',
        osTypes: ['linux'],
        language: 'bash',
        content: 'echo hello',
        timeoutSeconds: 3600
      })
    });

    expect(res.status).toBe(201);
  });

  it('should reject timeoutSeconds above 3600 on create (#2398 — agent clamps at 1h)', async () => {
    for (const tooLong of [3601, 7200, 86400]) {
      const res = await app.request('/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          name: 'Too Long',
          osTypes: ['linux'],
          language: 'bash',
          content: 'echo hello',
          timeoutSeconds: tooLong
        })
      });
      expect(res.status).toBe(400);
    }
  });

  it('should reject timeoutSeconds above 3600 on update (#2398)', async () => {
    const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({ timeoutSeconds: 7200 })
    });
    expect(res.status).toBe(400);
  });

  it('should accept timeoutSeconds at the 3600 cap on update', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: SCRIPT_ID_1,
            name: 'Script One',
            content: 'echo hi',
            version: 1,
            isSystem: false,
            orgId: ORG_ID
          }])
        })
      })
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: SCRIPT_ID_1,
            timeoutSeconds: 3600,
            version: 2
          }])
        })
      })
    } as any);

    const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({ timeoutSeconds: 3600 })
    });
    expect(res.status).toBe(200);
  });

  it('should update a script and return updated record', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: SCRIPT_ID_1,
            name: 'Old Script',
            content: 'old',
            version: 1,
            isSystem: false,
            orgId: ORG_ID
          }])
        })
      })
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: SCRIPT_ID_1,
            name: 'Updated Script',
            version: 2
          }])
        })
      })
    } as any);

    const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({
        name: 'Updated Script',
        content: 'new'
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(2);
  });

  // -------------------------------------------------------------------
  // Save-time {{var.<secret>}} rejection (#3409 PR2)
  // -------------------------------------------------------------------
  // The default auth mock is org scope, orgId ORG_ID — findSecretVariableReferences
  // resolves through loadTenantVariableScope([ORG_ID]) / resolveForOrg, which
  // issues db.select({...}).from(organizations).innerJoin(tenantVariables, ...).where(...).
  function mockTenantVariableScopeRows(rows: unknown[]): void {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows)
        })
      })
    } as any);
  }

  describe('save-time {{var.<secret>}} rejection', () => {
    it('400s a script whose content references a secret variable (create)', async () => {
      mockTenantVariableScopeRows([
        { id: 'tv-1', key: 's1_token', value: 'shh', isSecret: true, version: 1, ownerOrgId: ORG_ID, forOrgId: ORG_ID }
      ]);

      const res = await app.request('/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          name: 'Uses secret',
          osTypes: ['linux'],
          language: 'bash',
          content: 'echo {{var.s1_token}}'
        })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe(
        'Script content references secret variable(s): {{var.s1_token}}. Secret variables cannot be substituted into script content.'
      );
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it('accepts a script referencing a non-secret variable (create)', async () => {
      mockTenantVariableScopeRows([
        { id: 'tv-1', key: 'repo_url', value: 'https://dl.example', isSecret: false, version: 1, ownerOrgId: ORG_ID, forOrgId: ORG_ID }
      ]);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: SCRIPT_ID_1, name: 'Uses non-secret var', orgId: ORG_ID }])
        })
      } as any);

      const res = await app.request('/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          name: 'Uses non-secret var',
          osTypes: ['linux'],
          language: 'bash',
          content: 'curl {{var.repo_url}}'
        })
      });

      expect(res.status).toBe(201);
    });

    // The non-obvious half of the rule: a key with no matching row at all
    // (not yet created, or simply never defined) must NOT block — a tech may
    // legitimately write the script before creating the variable, and the
    // dispatch path fails that device loudly per #3409's fail-loud contract.
    it('accepts a script referencing an UNKNOWN variable key — warn-only, not a block (create)', async () => {
      mockTenantVariableScopeRows([]); // no tenant_variables rows at all
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: SCRIPT_ID_1, name: 'Uses unknown var', orgId: ORG_ID }])
        })
      } as any);

      const res = await app.request('/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          name: 'Uses unknown var',
          osTypes: ['linux'],
          language: 'bash',
          content: 'echo {{var.not_yet_created}}'
        })
      });

      expect(res.status).toBe(201);
    });

    it('400s an UPDATE whose new content references a secret variable, and never writes it', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: SCRIPT_ID_1,
              name: 'Existing',
              content: 'echo hi',
              version: 1,
              isSystem: false,
              orgId: ORG_ID
            }])
          })
        })
      } as any);
      mockTenantVariableScopeRows([
        { id: 'tv-1', key: 's1_token', value: 'shh', isSecret: true, version: 1, ownerOrgId: ORG_ID, forOrgId: ORG_ID }
      ]);

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ content: 'echo {{var.s1_token}}' })
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('s1_token');
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Save-time parameter-binding secret mismatch (#3409 PR4c-2, Task 6)
  // -------------------------------------------------------------------
  // Symmetric to the content check above: a `tenantVariable` binding whose
  // target is a secret, or a `tenantSecret` binding whose target is NOT a
  // secret, is rejected when the definitions are stored — the web warning
  // already promises "the save will be rejected". Unknown keys pass (a
  // partner-wide script resolves per org later).
  describe('save-time parameter-binding secret mismatch', () => {
    const mockExistingScript = () =>
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: SCRIPT_ID_1,
              name: 'Existing',
              content: 'echo hi',
              version: 1,
              isSystem: false,
              orgId: ORG_ID,
              parameters: []
            }])
          })
        })
      } as any);

    const createWith = (parameters: unknown[]) =>
      app.request('/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          name: 'Bound params',
          osTypes: ['linux'],
          language: 'bash',
          content: 'echo "$BREEZE_PARAM_P"',
          parameters
        })
      });

    const updateWith = (parameters: unknown[]) =>
      app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ parameters })
      });

    const secretRow = { id: 'tv-1', key: 's1_token', value: 'shh', isSecret: true, version: 1, ownerOrgId: ORG_ID, forOrgId: ORG_ID };
    const plainRow = { id: 'tv-2', key: 'repo_url', value: 'https://dl.example', isSecret: false, version: 1, ownerOrgId: ORG_ID, forOrgId: ORG_ID };

    it('400s a create whose tenantVariable parameter binds a SECRET variable', async () => {
      mockTenantVariableScopeRows([secretRow]);
      const res = await createWith([{ name: 'p', type: 'string', source: 'tenantVariable', variableKey: 's1_token' }]);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe(
        'Parameter "p" binds secret variable "s1_token" with source "From a variable"; use a secret parameter instead'
      );
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it('400s a create whose tenantSecret parameter binds a NON-secret variable', async () => {
      mockTenantVariableScopeRows([plainRow]);
      const res = await createWith([{ name: 'p', type: 'string', source: 'tenantSecret', variableKey: 'repo_url' }]);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Parameter "p" is a secret parameter but variable "repo_url" is not a secret');
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it('accepts a create whose bindings target UNKNOWN keys (either source) — resolved per org at dispatch', async () => {
      mockTenantVariableScopeRows([]);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: SCRIPT_ID_1, name: 'Bound params', orgId: ORG_ID }])
        })
      } as any);
      const res = await createWith([
        { name: 'p', type: 'string', source: 'tenantVariable', variableKey: 'not_yet_created' },
        { name: 'q', type: 'string', source: 'tenantSecret', variableKey: 'also_not_yet' }
      ]);
      expect(res.status).toBe(201);
    });

    it('accepts a create whose bindings match their targets (plain→tenantVariable, secret→tenantSecret)', async () => {
      mockTenantVariableScopeRows([secretRow, plainRow]);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: SCRIPT_ID_1, name: 'Bound params', orgId: ORG_ID }])
        })
      } as any);
      const res = await createWith([
        { name: 'p', type: 'string', source: 'tenantVariable', variableKey: 'repo_url' },
        { name: 'q', type: 'string', source: 'tenantSecret', variableKey: 's1_token' }
      ]);
      expect(res.status).toBe(201);
    });

    it('400s an UPDATE whose new tenantVariable parameter binds a SECRET variable, and never writes it', async () => {
      mockExistingScript();
      mockTenantVariableScopeRows([secretRow]);
      const res = await updateWith([{ name: 'p', type: 'string', source: 'tenantVariable', variableKey: 's1_token' }]);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe(
        'Parameter "p" binds secret variable "s1_token" with source "From a variable"; use a secret parameter instead'
      );
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('400s an UPDATE whose new tenantSecret parameter binds a NON-secret variable, and never writes it', async () => {
      mockExistingScript();
      mockTenantVariableScopeRows([plainRow]);
      const res = await updateWith([{ name: 'p', type: 'string', source: 'tenantSecret', variableKey: 'repo_url' }]);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('Parameter "p" is a secret parameter but variable "repo_url" is not a secret');
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('accepts an UPDATE whose new bindings target UNKNOWN keys', async () => {
      mockExistingScript();
      mockTenantVariableScopeRows([]);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: SCRIPT_ID_1, name: 'Existing', orgId: ORG_ID, version: 2 }])
          })
        })
      } as any);
      const res = await updateWith([{ name: 'p', type: 'string', source: 'tenantSecret', variableKey: 'not_yet_created' }]);
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------
  // Ownership TIER of the secret vs. the SCRIPT (#3409 PR4c-2 review).
  // -------------------------------------------------------------------
  // A script may resolve a secret at or below its own ownership tier, never
  // above: a partner-wide script (org_id NULL) may bind a partner-owned OR an
  // org-owned secret; an ORG-scoped script may bind only an org-owned one.
  //
  // It is deliberately NOT a caller-capability check. `tenantVariableRead-
  // Condition` widens partner-wide variable KEYS to organization-scope
  // sessions and `resolveForOrg` inherits the ROWS into every org, so an org
  // admin who could bind the MSP's partner-wide secret into an org-scoped
  // script could base64 it out through script output (both redactors are
  // exact-substring). Gating on the caller instead of the script does not
  // stop that: a full-partner admin's org-scoped script is editable and
  // runnable by that org's own admins afterwards.
  //
  // Dispatch is the authority (services/sourcedParameters.ts, `tenantSecret`
  // arm); these cases pin the save-time FAST FAIL.
  describe('secret ownership tier vs. script scope', () => {
    // org_id IS NULL on the tenant_variables row -> ownerScope 'partner'.
    const partnerSecretRow = {
      id: 'tv-3', key: 'psa_api_token', value: 'shh', isSecret: true, version: 1,
      ownerOrgId: null, forOrgId: ORG_ID
    };
    const orgSecretRow = {
      id: 'tv-1', key: 's1_token', value: 'shh', isSecret: true, version: 1,
      ownerOrgId: ORG_ID, forOrgId: ORG_ID
    };
    const DENIED =
      'Parameter "psa" binds partner-wide secret variable "psa_api_token"; an organization-scoped script cannot use one — make the script partner-wide, or use an organization-owned secret.';

    // The partner-wide branch of the save-time lookup reads tenant_variables
    // directly (org_id IS NULL AND partner_id = ...) — no resolver join, so
    // the chain shape differs from mockTenantVariableScopeRows above.
    function mockPartnerWideVariableRows(rows: unknown[]): void {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows)
        })
      } as any);
    }

    const secretParam = (variableKey: string) => ({
      name: 'psa', type: 'string', source: 'tenantSecret', variableKey
    });

    async function usePartnerAuth(partnerOrgAccess: 'all' | 'selected') {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', {
          user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
          scope: 'partner' as const,
          partnerId: PARTNER_ID,
          partnerOrgAccess,
          orgId: null,
          token: {
            sub: 'user-123', email: 'test@example.com', roleId: 'role-123',
            orgId: null, partnerId: PARTNER_ID, scope: 'partner', type: 'access', mfa: true,
          },
          accessibleOrgIds: [ORG_ID],
          canAccessOrg: (id: string) => id === ORG_ID,
        });
        return next();
      });
    }

    const createWithParams = (parameters: unknown[], extra: Record<string, unknown> = {}) =>
      app.request('/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          name: 'Binds PSA token',
          osTypes: ['linux'],
          language: 'bash',
          content: 'echo hi',
          parameters,
          ...extra
        })
      });

    it('400s a create by an ORG-scope caller binding a partner-wide secret, and never inserts', async () => {
      mockTenantVariableScopeRows([partnerSecretRow]);
      const res = await createWithParams([secretParam('psa_api_token')]);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(DENIED);
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    // The tier is the SCRIPT's, not the caller's: a full-partner admin creating
    // a script for ONE org is creating an org-scoped script, which that org's
    // admins can edit and run afterwards.
    it('400s a full-partner admin binding a partner-wide secret into an ORG-scoped script', async () => {
      await usePartnerAuth('all');
      mockTenantVariableScopeRows([partnerSecretRow]);
      const res = await createWithParams([secretParam('psa_api_token')], { orgId: ORG_ID, availability: 'org' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(DENIED);
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it('400s a SELECTED-access partner user binding a partner-wide secret into an ORG-scoped script', async () => {
      await usePartnerAuth('selected');
      mockTenantVariableScopeRows([partnerSecretRow]);
      const res = await createWithParams([secretParam('psa_api_token')], { orgId: ORG_ID, availability: 'org' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(DENIED);
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it("ALLOWS a PARTNER-WIDE create binding the partner's own secret", async () => {
      await usePartnerAuth('all');
      mockPartnerWideVariableRows([{ key: 'psa_api_token', isSecret: true }]);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: SCRIPT_ID_1, name: 'Binds PSA token', orgId: null }])
        })
      } as any);
      const res = await createWithParams([secretParam('psa_api_token')], { availability: 'partner' });
      expect(res.status).toBe(201);
    });

    // The PRIMARY use case: one partner-wide script, each target org's OWN
    // value resolved per device at dispatch. The key is simply not visible to
    // the partner-wide lookup at save time, and must not be rejected for that.
    it('ALLOWS a PARTNER-WIDE create binding a key that only exists as an ORG-owned secret', async () => {
      await usePartnerAuth('all');
      mockPartnerWideVariableRows([]); // no partner-wide row named s1_token
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: SCRIPT_ID_1, name: 'Binds PSA token', orgId: null }])
        })
      } as any);
      const res = await createWithParams([secretParam('s1_token')], { availability: 'partner' });
      expect(res.status).toBe(201);
    });

    it('leaves an ORG-owned secret binding unaffected for the same org-scope caller', async () => {
      mockTenantVariableScopeRows([orgSecretRow]);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: SCRIPT_ID_1, name: 'Binds PSA token', orgId: ORG_ID }])
        })
      } as any);
      const res = await createWithParams([
        { name: 'psa', type: 'string', source: 'tenantSecret', variableKey: 's1_token' }
      ]);
      expect(res.status).toBe(201);
    });

    it('400s an UPDATE by an ORG-scope caller binding a partner-wide secret, and never writes it', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: SCRIPT_ID_1, name: 'Existing', content: 'echo hi', version: 1,
              isSystem: false, orgId: ORG_ID, parameters: []
            }])
          })
        })
      } as any);
      mockTenantVariableScopeRows([partnerSecretRow]);

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ parameters: [secretParam('psa_api_token')] })
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(DENIED);
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it("ALLOWS an UPDATE of an already PARTNER-WIDE script binding the partner's own secret", async () => {
      await usePartnerAuth('all');
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: SCRIPT_ID_1, name: 'Existing', content: 'echo hi', version: 1,
              isSystem: false, orgId: null, partnerId: PARTNER_ID, parameters: []
            }])
          })
        })
      } as any);
      mockPartnerWideVariableRows([{ key: 'psa_api_token', isSecret: true }]);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: SCRIPT_ID_1, name: 'Existing', orgId: null }])
          })
        })
      } as any);

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ parameters: [secretParam('psa_api_token')] })
      });

      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------
  // POST /scripts/import/:id — the fourth write ingress (#3409 PR4c-2).
  // -------------------------------------------------------------------
  // Cloning a system script copies `source.parameters` verbatim. Before this
  // change the clone ran NEITHER save-time secret check, so it was a straight
  // bypass of both the content gate and the partner-wide binding gate above.
  describe('clone a system script — save-time secret checks', () => {
    const systemSource = (overrides: Record<string, unknown> = {}) => ({
      id: SCRIPT_ID_2,
      name: 'System Script',
      description: null,
      category: null,
      osTypes: ['linux'],
      language: 'bash',
      content: 'echo hi',
      parameters: null,
      timeoutSeconds: 300,
      runAs: 'system',
      isSystem: true,
      ...overrides
    });

    function mockClonePreamble(source: Record<string, unknown>, existing: unknown[] = []) {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([source]) })
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(existing) })
          })
        } as any);
    }

    const clone = () =>
      app.request(`/scripts/import/${SCRIPT_ID_2}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({})
      });

    it('400s a clone whose copied parameters bind a partner-wide secret, and never inserts', async () => {
      mockClonePreamble(
        systemSource({
          parameters: [{ name: 'psa', type: 'string', source: 'tenantSecret', variableKey: 'psa_api_token' }]
        })
      );
      mockTenantVariableScopeRows([
        { id: 'tv-3', key: 'psa_api_token', value: 'shh', isSecret: true, version: 1, ownerOrgId: null, forOrgId: ORG_ID }
      ]);

      const res = await clone();
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(
        'Parameter "psa" binds partner-wide secret variable "psa_api_token"; an organization-scoped script cannot use one — make the script partner-wide, or use an organization-owned secret.'
      );
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it('400s a clone whose copied parameters bind an ORG secret with the plain tenantVariable source', async () => {
      mockClonePreamble(
        systemSource({
          parameters: [{ name: 'p', type: 'string', source: 'tenantVariable', variableKey: 's1_token' }]
        })
      );
      mockTenantVariableScopeRows([
        { id: 'tv-1', key: 's1_token', value: 'shh', isSecret: true, version: 1, ownerOrgId: ORG_ID, forOrgId: ORG_ID }
      ]);

      const res = await clone();
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(
        'Parameter "p" binds secret variable "s1_token" with source "From a variable"; use a secret parameter instead'
      );
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it('400s a clone whose copied CONTENT references a secret variable', async () => {
      mockClonePreamble(systemSource({ content: 'echo {{var.s1_token}}' }));
      mockTenantVariableScopeRows([
        { id: 'tv-1', key: 's1_token', value: 'shh', isSecret: true, version: 1, ownerOrgId: ORG_ID, forOrgId: ORG_ID }
      ]);

      const res = await clone();
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('s1_token');
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it('clones a clean system script unchanged', async () => {
      mockClonePreamble(systemSource());
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: SCRIPT_ID_1, name: 'System Script', orgId: ORG_ID }])
        })
      } as any);

      const res = await clone();
      expect(res.status).toBe(201);
      expect(vi.mocked(db.insert)).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // POST /scripts/:id/clone (#4887) — the general "Duplicate" action.
  // Tenancy resolution lives in resolveScriptCloneScope (services/scriptWrite.ts);
  // these tests exercise it end to end through the route, including the
  // cross-org/cross-partner negative cases that must be rejected.
  //
  // Every helper below queues EXACTLY the db.select/db.insert calls a given
  // test path will make and no more — vi.clearAllMocks() in beforeEach does
  // NOT clear a queued mockReturnValueOnce/mockImplementationOnce that a prior
  // test left unconsumed (only mockReset does), so an over-queued mock here
  // would leak into and corrupt an unrelated LATER test in this file.
  // -------------------------------------------------------------------
  describe('POST /scripts/:id/clone', () => {
    function orgSource(overrides: Record<string, unknown> = {}) {
      return {
        id: SCRIPT_ID_2,
        name: 'Original Script',
        description: 'desc',
        category: 'Maintenance',
        osTypes: ['windows'],
        language: 'powershell',
        content: 'Write-Host hi',
        parameters: null,
        timeoutSeconds: 300,
        runAs: 'system',
        isSystem: false,
        orgId: ORG_ID,
        partnerId: null,
        exitCodeSeverityMapping: null,
        ...overrides
      };
    }

    // The ONE db.select the route always makes first: the source lookup.
    function mockCloneSource(source: Record<string, unknown>) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([source]) })
        })
      } as any);
    }

    // The post-insert tag lookup on the SOURCE (scriptToTags join scriptTags)
    // — only reached once the clone actually succeeds. Callers on an
    // early-exit path (403/404/400) must NOT call this.
    function mockTagLookup(tagRows: unknown[] = []) {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(tagRows) })
        })
      } as any);
    }

    function mockInsertOnce(returned: Record<string, unknown>) {
      let insertedValues: any;
      vi.mocked(db.insert).mockImplementationOnce((() => ({
        values: vi.fn().mockImplementation((vals: any) => {
          insertedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: SCRIPT_ID_1, ...returned }]) };
        })
      })) as any);
      return () => insertedValues;
    }

    function makePartnerAuth(partnerOrgAccess: 'all' | 'selected', accessibleOrgIds = [ORG_ID, ORG_ID_2]) {
      return {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'partner' as const,
        partnerId: PARTNER_ID,
        partnerOrgAccess,
        orgId: null,
        token: {
          sub: 'user-123', email: 'test@example.com', roleId: 'role-123',
          orgId: null, partnerId: PARTNER_ID, scope: 'partner', type: 'access', mfa: true,
        },
        accessibleOrgIds,
        canAccessOrg: (id: string) => accessibleOrgIds.includes(id),
      };
    }

    async function useAuth(auth: Record<string, unknown>) {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', auth);
        return next();
      });
    }

    const clone = (body?: Record<string, unknown>) =>
      app.request(`/scripts/${SCRIPT_ID_2}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify(body ?? {})
      });

    it('org-scope caller clones its own script, defaulting the name to "<name> (copy)"', async () => {
      mockCloneSource(orgSource());
      mockTagLookup();
      const getInserted = mockInsertOnce({ name: 'Original Script (copy)', orgId: ORG_ID });

      const res = await clone();

      expect(res.status).toBe(201);
      expect(getInserted().name).toBe('Original Script (copy)');
      expect(getInserted().orgId).toBe(ORG_ID);
      expect(getInserted().isSystem).toBe(false);
      expect(getInserted().createdBy).toBe('user-123');
    });

    it('honors an explicit name override in the body', async () => {
      mockCloneSource(orgSource());
      mockTagLookup();
      const getInserted = mockInsertOnce({ name: 'My Copy', orgId: ORG_ID });

      const res = await clone({ name: 'My Copy' });

      expect(res.status).toBe(201);
      expect(getInserted().name).toBe('My Copy');
    });

    it('a partner-scope caller may explicitly clone into another org within their partner (cross-org copy)', async () => {
      await useAuth(makePartnerAuth('all'));
      mockCloneSource(orgSource({ orgId: ORG_ID }));
      mockTagLookup();
      const getInserted = mockInsertOnce({ name: 'Original Script (copy)', orgId: ORG_ID_2 });

      const res = await clone({ orgId: ORG_ID_2 });

      expect(res.status).toBe(201);
      expect(getInserted().orgId).toBe(ORG_ID_2);
    });

    it('rejects an explicit orgId the caller cannot access (cross-org negative)', async () => {
      // accessibleOrgIds excludes ORG_ID_2 — the requested target is outside
      // this partner user's own org grant, even though they're partner scope.
      await useAuth(makePartnerAuth('all', [ORG_ID]));
      mockCloneSource(orgSource({ orgId: ORG_ID }));

      const res = await clone({ orgId: ORG_ID_2 });

      expect(res.status).toBe(403);
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it('rejects cloning a script owned by a DIFFERENT partner entirely (cross-partner negative)', async () => {
      // Source is partner-wide under OTHER_PARTNER_ID — invisible to this
      // caller under both RLS and the app-layer canReadScript check, since
      // neither its org nor its partner match. Must 404, never leak via a
      // successful clone or a 403 that confirms the id exists.
      await useAuth(makePartnerAuth('all', [ORG_ID, ORG_ID_2]));
      mockCloneSource(orgSource({ orgId: null, partnerId: OTHER_PARTNER_ID }));

      const res = await clone({ orgId: ORG_ID_2 });

      expect(res.status).toBe(404);
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it('preserves partner-wide scope by default when the source is partner-wide and the caller has the capability', async () => {
      await useAuth(makePartnerAuth('all'));
      mockCloneSource(orgSource({ orgId: null, partnerId: PARTNER_ID }));
      mockTagLookup();
      const getInserted = mockInsertOnce({ name: 'Original Script (copy)', orgId: null, partnerId: PARTNER_ID });

      const res = await clone();

      expect(res.status).toBe(201);
      expect(getInserted().orgId).toBeNull();
      expect(getInserted().partnerId).toBe(PARTNER_ID);
    });

    // #3262-style guard: omitting orgId on a partner-wide source must NEVER
    // silently downgrade to an org-owned clone for a caller who couldn't have
    // created a partner-wide script in the first place.
    it('refuses (never silently downgrades) a partner-wide clone for a selected-access caller with no orgId', async () => {
      await useAuth(makePartnerAuth('selected'));
      mockCloneSource(orgSource({ orgId: null, partnerId: PARTNER_ID }));

      const res = await clone();

      expect(res.status).toBe(403);
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it('clones a system-library script into the org-scope caller\'s own org as an editable, non-system copy', async () => {
      mockCloneSource(orgSource({ orgId: null, partnerId: null, isSystem: true, name: 'System Script' }));
      mockTagLookup();
      const getInserted = mockInsertOnce({ name: 'System Script (copy)', orgId: ORG_ID, isSystem: false });

      const res = await clone();

      expect(res.status).toBe(201);
      expect(getInserted().orgId).toBe(ORG_ID);
      expect(getInserted().isSystem).toBe(false);
    });

    it('404s cloning a script that does not exist', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) })
        })
      } as any);

      const res = await clone();

      expect(res.status).toBe(404);
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it('400s a clone whose copied parameters bind a partner-wide secret at a narrower (org) target scope', async () => {
      // NOT mockCloneSource + mockTagLookup: a bound parameter makes
      // findParameterSecretMismatches issue its own select BEFORE the
      // (never-reached) post-insert tag lookup — queue exactly the two
      // selects that actually run, in order.
      mockCloneSource(orgSource({
        parameters: [{ name: 'psa', type: 'string', source: 'tenantSecret', variableKey: 'psa_api_token' }]
      }));
      mockTenantVariableScopeRows([
        { id: 'tv-3', key: 'psa_api_token', value: 'shh', isSecret: true, version: 1, ownerOrgId: null, forOrgId: ORG_ID }
      ]);

      const res = await clone();

      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('psa_api_token');
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it('copies the source script\'s tags onto the clone', async () => {
      mockCloneSource(orgSource());
      mockTagLookup([{ name: 'prod' }, { name: 'critical' }]);
      // ensureTagIds -> look up existing tags in the target scope by name.
      // linkTags is called with isExistingScript=false for a brand-new clone,
      // so it skips its own "existing links" select entirely — only one
      // extra select (this one) happens beyond the source/tag-lookup pair.
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: 'tag-1', name: 'prod' }, { id: 'tag-2', name: 'critical' }])
        })
      } as any);
      let linkedTagIds: string[] = [];
      // Two chained mockImplementationOnce calls, in the exact order the two
      // db.insert calls happen: the script row first, the scriptToTags link
      // second — no need to branch on the `table` argument.
      const insertScriptRowOnce = () => ({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: SCRIPT_ID_1, name: 'Original Script (copy)', orgId: ORG_ID }])
        })
      });
      const insertTagLinksOnce = () => ({
        values: vi.fn().mockImplementation((rows: any) => {
          linkedTagIds = rows.map((r: any) => r.tagId);
          return Promise.resolve();
        })
      });
      vi.mocked(db.insert)
        .mockImplementationOnce(insertScriptRowOnce as any)
        .mockImplementationOnce(insertTagLinksOnce as any);

      const res = await clone();

      expect(res.status).toBe(201);
      expect(linkedTagIds.sort()).toEqual(['tag-1', 'tag-2']);
    });
  });


  it('should prevent deleting scripts with active executions', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: SCRIPT_ID_1,
              name: 'Script One',
              isSystem: false,
              orgId: ORG_ID
            }])
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 1 }])
        })
      } as any);

    const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('active executions');
  });

  // Mocks the script-found SELECT then the zero-active-executions count SELECT
  // that the DELETE handler runs before deleting.
  function mockDeletePreflight(): void {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: SCRIPT_ID_1,
              name: 'Script One',
              isSystem: false,
              orgId: ORG_ID
            }])
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 0 }])
        })
      } as any);
  }

  // Builds the db.update mock chain (set -> where -> returning) used by the
  // soft-delete handler, resolving the returning() call with `returnedRows`.
  function mockSoftDeleteUpdate(returnedRows: Array<{ id: string }>) {
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returnedRows)
      })
    });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);
    return setMock;
  }

  it('should soft-delete (not hard-delete) so scripts with execution history can be removed', async () => {
    // Script exists, and the active-execution guard sees zero ACTIVE executions
    // (completed/failed executions may still exist and hold FK references).
    mockDeletePreflight();
    const setMock = mockSoftDeleteUpdate([{ id: SCRIPT_ID_1 }]);

    const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Must be a soft delete: UPDATE the row (set deletedAt), never a hard DELETE
    // — a hard DELETE throws an FK violation when execution history exists.
    expect(db.update).toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: expect.any(Date) })
    );
  });

  it('should return 404 (not a false success) when the soft-delete UPDATE matches zero rows', async () => {
    // Simulates losing a race with a concurrent delete: the row is gone/already
    // soft-deleted by the time the UPDATE runs, so returning() yields no rows.
    mockDeletePreflight();
    mockSoftDeleteUpdate([]);

    const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBeUndefined();
    // No audit entry should be written for a delete that changed nothing.
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it.skip('should execute a script against multiple devices', async () => {
    // Skipped: Complex mock chain requires e2e testing
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: SCRIPT_ID_1,
              name: 'Script One',
              content: 'echo hello',
              language: 'bash',
              osTypes: ['linux'],
              timeoutSeconds: 300,
              runAs: 'system',
              isSystem: false,
              orgId: ORG_ID
            }])
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: 'device-1', orgId: ORG_ID, osType: 'linux', status: 'online' },
            { id: 'device-2', orgId: ORG_ID, osType: 'linux', status: 'online' }
          ])
        })
      } as any);
    vi.mocked(db.insert)
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'batch-1' }])
        })
      } as any)
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'exec-1' }])
        })
      } as any)
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'cmd-1' }])
        })
      } as any)
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'exec-2' }])
        })
      } as any)
      .mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'cmd-2' }])
        })
      } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined)
      })
    } as any);

    const res = await app.request(`/scripts/${SCRIPT_ID_1}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({
        deviceIds: ['device-1', 'device-2'],
        parameters: { flag: true }
      })
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.batchId).toBe('batch-1');
    expect(body.executions).toHaveLength(2);
  });

  it.skip('should list executions for a script', async () => {
    // Skipped: Requires leftJoin mock - better suited for e2e testing
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: SCRIPT_ID_1,
              name: 'Script One',
              isSystem: false,
              orgId: ORG_ID
            }])
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ count: 1 }])
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([{
                    id: 'exec-1',
                    scriptId: SCRIPT_ID_1,
                    deviceId: 'device-1',
                    status: 'completed'
                  }])
                })
              })
            })
          })
        })
      } as any);

    const res = await app.request(`/scripts/${SCRIPT_ID_1}/executions`, {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.pagination.total).toBe(1);
  });

  it('denies execution details when the device is outside the caller site restriction', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: EXECUTION_ID,
                scriptId: SCRIPT_ID_1,
                deviceId: 'device-1',
                status: 'completed',
                deviceOrgId: ORG_ID,
                deviceSiteId: 'site-denied'
              }])
            })
          })
        })
      })
    } as any);

    const res = await app.request(`/scripts/executions/${EXECUTION_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token', 'x-site-restricted': 'true' }
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Access to this site denied');
  });

  it('denies cancelling an execution when the device is outside the caller site restriction', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: EXECUTION_ID,
              status: 'running',
              deviceId: 'device-1',
              deviceOrgId: ORG_ID,
              deviceSiteId: 'site-denied'
            }])
          })
        })
      })
    } as any);

    const res = await app.request(`/scripts/executions/${EXECUTION_ID}/cancel`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'x-site-restricted': 'true' }
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Access to this site denied');
    // Must reject before mutating
    expect(db.update).not.toHaveBeenCalled();
  });

  it('allows cancelling an execution when the device is within the caller site restriction', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: EXECUTION_ID,
              status: 'running',
              deviceId: 'device-1',
              deviceOrgId: ORG_ID,
              deviceSiteId: 'site-allowed'
            }])
          })
        })
      })
    } as any);
    vi.mocked(db.update)
      .mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: EXECUTION_ID, status: 'cancelled' }])
          })
        })
      } as any)
      .mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

    const res = await app.request(`/scripts/executions/${EXECUTION_ID}/cancel`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token', 'x-site-restricted': 'true' }
    });

    expect(res.status).toBe(200);
    expect(applyAutomationActionTerminalMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'cancellation',
      scriptExecutionId: EXECUTION_ID,
      terminalStatus: 'cancelled',
    }));
  });

  it('cancels an execution unchanged when the caller has no site restriction', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: EXECUTION_ID,
              status: 'running',
              deviceId: 'device-1',
              deviceOrgId: ORG_ID,
              deviceSiteId: 'site-denied'
            }])
          })
        })
      })
    } as any);
    vi.mocked(db.update)
      .mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: EXECUTION_ID, status: 'cancelled' }])
          })
        })
      } as any)
      .mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined)
        })
      } as any);

    const res = await app.request(`/scripts/executions/${EXECUTION_ID}/cancel`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
  });

  it('does not terminalize automation when a concurrent result wins the cancellation CAS', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: EXECUTION_ID,
              status: 'running',
              deviceId: 'device-1',
              deviceOrgId: ORG_ID,
              deviceSiteId: 'site-allowed',
            }]),
          }),
        }),
      }),
    } as any);
    vi.mocked(db.update).mockReturnValueOnce({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const res = await app.request(`/scripts/executions/${EXECUTION_ID}/cancel`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' },
    });

    expect(res.status).toBe(409);
    expect(applyAutomationActionTerminalMock).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('should validate create payload', async () => {
    const res = await app.request('/scripts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({
        description: 'missing required fields'
      })
    });

    expect(res.status).toBe(400);
  });

  it('should validate update payload when empty', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: SCRIPT_ID_1,
            name: 'Script One',
            content: 'echo',
            version: 1,
            isSystem: false,
            orgId: ORG_ID
          }])
        })
      })
    } as any);

    const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({})
    });

    expect(res.status).toBe(400);
  });

  it('should validate execute payload', async () => {
    const res = await app.request(`/scripts/${SCRIPT_ID_1}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({
        deviceIds: []
      })
    });

    expect(res.status).toBe(400);
  });

  it('rejects more than 500 device ids on execute (#3409 PR0 Wave B — audit fan-out cap)', async () => {
    const deviceIds = Array.from({ length: 501 }, (_, i) => {
      const hex = i.toString(16).padStart(12, '0');
      return `11111111-1111-4111-8111-${hex}`;
    });

    const res = await app.request(`/scripts/${SCRIPT_ID_1}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({ deviceIds })
    });

    expect(res.status).toBe(400);
  });

  it('rejects a nested-object parameter value on execute (#3409 PR2 Task 7 — one script-parameter schema)', async () => {
    const res = await app.request(`/scripts/${SCRIPT_ID_1}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({
        deviceIds: ['11111111-1111-1111-1111-111111111111'],
        parameters: { nested: { bad: true } }
      })
    });

    expect(res.status).toBe(400);
  });

  it('rejects a parameter key the agent could not turn into an env var name on execute', async () => {
    const res = await app.request(`/scripts/${SCRIPT_ID_1}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({
        deviceIds: ['11111111-1111-1111-1111-111111111111'],
        parameters: { 'has space': 'v' }
      })
    });

    expect(res.status).toBe(400);
  });

  it('should reject unsupported runAs override on execute', async () => {
    const res = await app.request(`/scripts/${SCRIPT_ID_1}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({
        deviceIds: ['11111111-1111-1111-1111-111111111111'],
        runAs: 'elevated'
      })
    });

    expect(res.status).toBe(400);
  });

  describe('canonical per-target admission on execute', () => {
    const executeBody = (deviceIds: string[]) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({ deviceIds }),
    });

    it('returns an exact rejected 201 body and writes no success audit', async () => {
      executeScriptOnDevicesMock.mockResolvedValueOnce({
        ok: true,
        admission: {
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          status: 'rejected',
          targets: [{
            requestedDeviceId: '11111111-1111-1111-1111-111111111111',
            admission: 'excluded',
            reasonCode: 'unresolved_variables',
          }],
        },
        script: { id: SCRIPT_ID_1, name: 'Script One' },
        triggerType: 'manual',
        runAs: 'system',
        ignoredParameters: [],
        auditOrgId: ORG_ID,
      });

      const res = await app.request(
        `/scripts/${SCRIPT_ID_1}/execute`,
        executeBody(['11111111-1111-1111-1111-111111111111']),
      );

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'rejected',
        targets: [{
          requestedDeviceId: '11111111-1111-1111-1111-111111111111',
          admission: 'excluded',
          reasonCode: 'unresolved_variables',
        }],
      });
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('returns the exact partial admission body and audits safe correlation data once', async () => {
      executeScriptOnDevicesMock.mockResolvedValueOnce({
        ok: true,
        admission: {
          requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          status: 'partially_queued',
          targets: [{
            requestedDeviceId: '11111111-1111-1111-1111-111111111111',
            admission: 'admitted',
            executionId: 'exec-1',
            commandId: 'cmd-1',
            batchId: 'batch-1',
          }, {
            requestedDeviceId: '22222222-2222-2222-2222-222222222222',
            admission: 'denied',
            reasonCode: 'not_found_or_inaccessible',
          }],
        },
        script: { id: SCRIPT_ID_1, name: 'Script One' },
        ignoredParameters: [],
        triggerType: 'manual',
        runAs: 'system',
        auditOrgId: ORG_ID,
      });

      const res = await app.request(
        `/scripts/${SCRIPT_ID_1}/execute`,
        executeBody([
          '11111111-1111-1111-1111-111111111111',
          '22222222-2222-2222-2222-222222222222',
        ]),
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(Object.keys(body).sort()).toEqual(['requestId', 'status', 'targets']);
      expect(body.targets).toHaveLength(2);
      expect(writeRouteAudit).toHaveBeenCalledTimes(1);
      expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        details: expect.objectContaining({
          requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          admissionStatus: 'partially_queued',
          batchIds: ['batch-1'],
        }),
      }));
    });
  });

  // #3409 PR3 §2.2: a caller-supplied value for a parameter BOUND to a source
  // (tenantVariable / deviceCustomField / builtin) is ignored — the binding
  // wins — rather than 400'd, so a stored automation cannot be broken by a
  // script author flipping a parameter to bound. That makes the ignore
  // otherwise SILENT, which is why it has to reach both the response body and
  // the audit trail.
  describe('ignored bound parameters on execute (#3409 PR3)', () => {
    const executeWithParameters = (parameters: Record<string, unknown>) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({
        deviceIds: ['11111111-1111-1111-1111-111111111111'],
        parameters,
      }),
    });

    const okResultWithIgnored = (ignoredParameters: string[]) => ({
      ok: true,
      admission: {
        requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        status: 'queued' as const,
        targets: [{
          requestedDeviceId: '11111111-1111-1111-1111-111111111111',
          admission: 'admitted' as const,
          executionId: 'exec-1',
          commandId: 'cmd-1',
        }],
      },
      script: { id: SCRIPT_ID_1, name: 'Script One' },
      ignoredParameters,
      triggerType: 'manual' as const,
      runAs: 'system',
      auditOrgId: ORG_ID,
    });

    it('keeps ignored bound keys out of the exact admission response', async () => {
      executeScriptOnDevicesMock.mockResolvedValueOnce(okResultWithIgnored(['api_key', 'site_code']));

      const res = await app.request(
        `/scripts/${SCRIPT_ID_1}/execute`,
        executeWithParameters({ api_key: 'caller-supplied', site_code: 'caller-supplied' }),
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(Object.keys(body).sort()).toEqual(['requestId', 'status', 'targets']);
      expect(JSON.stringify(body)).not.toContain('api_key');
      expect(JSON.stringify(body)).not.toContain('site_code');
    });

    it('audits the ignored KEYS (and no values) under a dedicated details field', async () => {
      executeScriptOnDevicesMock.mockResolvedValueOnce(okResultWithIgnored(['api_key']));

      const res = await app.request(
        `/scripts/${SCRIPT_ID_1}/execute`,
        executeWithParameters({ api_key: 's3cret-value-the-caller-sent' }),
      );

      expect(res.status).toBe(201);
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'script.execute',
          details: expect.objectContaining({ ignoredParameterKeys: ['api_key'] }),
        }),
      );
      // Keys only: whatever the caller sent under a bound key must never land
      // in an audit row, which is long-lived and widely readable.
      const auditDetails = vi.mocked(writeRouteAudit).mock.calls.at(-1)?.[1].details ?? {};
      expect(JSON.stringify(auditDetails)).not.toContain('s3cret-value-the-caller-sent');
    });

    it('returns the same exact response shape when nothing was ignored', async () => {
      executeScriptOnDevicesMock.mockResolvedValueOnce(okResultWithIgnored([]));

      const res = await app.request(
        `/scripts/${SCRIPT_ID_1}/execute`,
        executeWithParameters({ runtime_param: 'value' }),
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(Object.keys(body).sort()).toEqual(['requestId', 'status', 'targets']);
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          details: expect.objectContaining({ ignoredParameterKeys: [] }),
        }),
      );
    });
  });

  // ── Task 7: List union (org ∪ partner-wide ∪ system) ─────────────────────
  describe('Task 7: list union — partner-wide + org + system rows', () => {
    function makePartnerAuth(overrides?: {
      accessibleOrgIds?: string[];
      noPartnerId?: boolean;
    }) {
      const partnerId = overrides?.noPartnerId ? null : PARTNER_ID;
      const accessibleOrgIds = overrides?.accessibleOrgIds ?? [ORG_ID, ORG_ID_2];
      return {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'partner' as const,
        partnerId,
        orgId: null,
        token: {
          sub: 'user-123', email: 'test@example.com', roleId: 'role-123',
          orgId: null, partnerId, scope: 'partner', type: 'access', mfa: true,
        },
        accessibleOrgIds,
        canAccessOrg: (id: string) => accessibleOrgIds.includes(id),
      };
    }

    function makeOrgAuth() {
      return {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization' as const,
        partnerId: PARTNER_ID,
        orgId: ORG_ID,
        token: {
          sub: 'user-123', email: 'test@example.com', roleId: 'role-123',
          orgId: ORG_ID, partnerId: PARTNER_ID, scope: 'organization', type: 'access', mfa: true,
        },
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (id: string) => id === ORG_ID,
      };
    }

    it('partner user list returns scripts including partner-wide rows (org_id NULL, partner_id set)', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', makePartnerAuth());
        return next();
      });

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 3 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([
                    { id: SCRIPT_ID_1, name: 'Org Script', orgId: ORG_ID, partnerId: PARTNER_ID, isSystem: false },
                    { id: SCRIPT_ID_2, name: 'Partner-wide Script', orgId: null, partnerId: PARTNER_ID, isSystem: false },
                    { id: '11111111-1111-4111-8111-111111111111', name: 'System Script', orgId: null, partnerId: null, isSystem: true },
                  ])
                })
              })
            })
          })
        } as any);

      const res = await app.request('/scripts?includeSystem=true', {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(3);
      const names = body.data.map((s: any) => s.name);
      expect(names).toContain('Partner-wide Script');
      expect(names).toContain('System Script');
    });

    it('org user list includes own org + partner-wide rows + system', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', makeOrgAuth());
        return next();
      });

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 2 }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue([
                    { id: SCRIPT_ID_1, name: 'Org Script', orgId: ORG_ID, partnerId: PARTNER_ID, isSystem: false },
                    { id: SCRIPT_ID_2, name: 'Partner-wide Script', orgId: null, partnerId: PARTNER_ID, isSystem: false },
                  ])
                })
              })
            })
          })
        } as any);

      const res = await app.request('/scripts?includeSystem=true', {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.data.some((s: any) => s.orgId === null && s.partnerId === PARTNER_ID)).toBe(true);
    });

    it('partner user list returns empty page when no accessible orgs and no partnerId', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', makePartnerAuth({ accessibleOrgIds: [], noPartnerId: true }));
        return next();
      });

      const res = await app.request('/scripts', {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
    });
  });

  // ── Task 8: Partner-wide create + edit/delete guard ───────────────────────
  describe('Task 8: partner-wide create + org-user read-only guard', () => {
    // #3262: partner-wide writes need the CAPABILITY (org_access = 'all'), not
    // just partner scope. These helpers default to a full-partner admin so the
    // existing positive cases keep describing the user they always meant; pass
    // 'selected' to exercise the denial.
    function makePartnerAuth(partnerOrgAccess: 'all' | 'selected' = 'all') {
      return {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'partner' as const,
        partnerId: PARTNER_ID,
        partnerOrgAccess,
        orgId: null,
        token: {
          sub: 'user-123', email: 'test@example.com', roleId: 'role-123',
          orgId: null, partnerId: PARTNER_ID, scope: 'partner', type: 'access', mfa: true,
        },
        accessibleOrgIds: [ORG_ID, ORG_ID_2],
        canAccessOrg: (id: string) => [ORG_ID, ORG_ID_2].includes(id),
      };
    }

    function makeOrgAuth() {
      return {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization' as const,
        partnerId: PARTNER_ID,
        orgId: ORG_ID,
        token: {
          sub: 'user-123', email: 'test@example.com', roleId: 'role-123',
          orgId: ORG_ID, partnerId: PARTNER_ID, scope: 'organization', type: 'access', mfa: true,
        },
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (id: string) => id === ORG_ID,
      };
    }

    it('partner user with availability=partner creates a script with org_id=null and partner_id set', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', makePartnerAuth());
        return next();
      });

      let insertedValues: any;
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          insertedValues = vals;
          return {
            returning: vi.fn().mockResolvedValue([{
              id: SCRIPT_ID_1,
              name: 'Partner Script',
              orgId: null,
              partnerId: PARTNER_ID,
              isSystem: false
            }])
          };
        })
      } as any);

      const res = await app.request('/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          name: 'Partner Script',
          osTypes: ['windows'],
          language: 'powershell',
          content: 'echo hi',
          availability: 'partner'
        })
      });

      expect(res.status).toBe(201);
      expect(insertedValues?.orgId).toBeNull();
      expect(insertedValues?.partnerId).toBe(PARTNER_ID);
    });

    // #3262: the reported vector — partner scope alone was enough to create a
    // script that runs as SYSTEM across every org under the partner.
    it('#3262: a selected-access partner user cannot create a partner-wide script', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', makePartnerAuth('selected'));
        return next();
      });

      const res = await app.request('/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          name: 'Partner Script',
          osTypes: ['windows'],
          language: 'powershell',
          content: 'echo hi',
          availability: 'partner'
        })
      });

      expect(res.status).toBe(403);
      expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    });

    it('partner user with availability=org + orgId creates an org-specific script', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', makePartnerAuth());
        return next();
      });

      let insertedValues: any;
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          insertedValues = vals;
          return {
            returning: vi.fn().mockResolvedValue([{
              id: SCRIPT_ID_1,
              name: 'Org Script',
              orgId: ORG_ID,
              partnerId: PARTNER_ID,
              isSystem: false
            }])
          };
        })
      } as any);

      const res = await app.request('/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          name: 'Org Script',
          osTypes: ['windows'],
          language: 'powershell',
          content: 'echo hi',
          orgId: ORG_ID,
          availability: 'org'
        })
      });

      expect(res.status).toBe(201);
      expect(insertedValues?.orgId).toBe(ORG_ID);
      expect(insertedValues?.partnerId).toBe(PARTNER_ID);
    });

    // #3262 control: the capability gate covers ONLY partner-wide writes. A
    // selected-access user must keep every org-scoped ability — without this,
    // a refactor that hoists the gate above the availability branch (denying
    // ALL partner-scope writes) would pass the suite green.
    it('#3262: a selected-access partner user still creates an org-scoped script', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', makePartnerAuth('selected'));
        return next();
      });

      let insertedValues: any;
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          insertedValues = vals;
          return {
            returning: vi.fn().mockResolvedValue([{
              id: SCRIPT_ID_1,
              name: 'Org Script',
              orgId: ORG_ID,
              partnerId: PARTNER_ID,
              isSystem: false
            }])
          };
        })
      } as any);

      const res = await app.request('/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          name: 'Org Script',
          osTypes: ['windows'],
          language: 'powershell',
          content: 'echo hi',
          orgId: ORG_ID,
          availability: 'org'
        })
      });

      expect(res.status).toBe(201);
      expect(insertedValues?.orgId).toBe(ORG_ID);
      expect(insertedValues?.partnerId).toBe(PARTNER_ID);
    });

    it('org user editing a partner-wide script (org_id=null, partner_id set) → 403', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', makeOrgAuth());
        return next();
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: SCRIPT_ID_1,
              name: 'Partner-wide Script',
              orgId: null,
              partnerId: PARTNER_ID,
              isSystem: false,
              content: 'echo hi',
              version: 1
            }])
          })
        })
      } as any);

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ name: 'Hacked' })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/shared across your organization/i);
    });

    it('org user deleting a partner-wide script (org_id=null, partner_id set) → 403', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', makeOrgAuth());
        return next();
      });

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: SCRIPT_ID_1,
                name: 'Partner-wide Script',
                orgId: null,
                partnerId: PARTNER_ID,
                isSystem: false
              }])
            })
          })
        } as any);

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/shared across your organization/i);
    });

    it('org user editing a system script → 403', async () => {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', makeOrgAuth());
        return next();
      });

      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: SCRIPT_ID_1,
              name: 'System Script',
              orgId: null,
              partnerId: null,
              isSystem: true,
              content: 'echo hi',
              version: 1
            }])
          })
        })
      } as any);

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ name: 'Hacked' })
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/system scripts are read-only/i);
    });
  });

  describe('Task 9: re-scope on edit (issue #1734)', () => {
    // #3262: partner-wide writes need the CAPABILITY (org_access = 'all'), not
    // just partner scope. These helpers default to a full-partner admin so the
    // existing positive cases keep describing the user they always meant; pass
    // 'selected' to exercise the denial.
    function makePartnerAuth(partnerOrgAccess: 'all' | 'selected' = 'all') {
      return {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'partner' as const,
        partnerId: PARTNER_ID,
        partnerOrgAccess,
        orgId: null,
        token: {
          sub: 'user-123', email: 'test@example.com', roleId: 'role-123',
          orgId: null, partnerId: PARTNER_ID, scope: 'partner', type: 'access', mfa: true,
        },
        accessibleOrgIds: [ORG_ID, ORG_ID_2],
        canAccessOrg: (id: string) => [ORG_ID, ORG_ID_2].includes(id),
      };
    }

    function makeOrgAuth() {
      return {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization' as const,
        partnerId: PARTNER_ID,
        orgId: ORG_ID,
        token: {
          sub: 'user-123', email: 'test@example.com', roleId: 'role-123',
          orgId: ORG_ID, partnerId: PARTNER_ID, scope: 'organization', type: 'access', mfa: true,
        },
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (id: string) => id === ORG_ID,
      };
    }

    async function withAuth(auth: any) {
      const { authMiddleware } = await import('../middleware/auth');
      vi.mocked(authMiddleware).mockImplementationOnce((c: any, next: any) => {
        c.set('auth', auth);
        return next();
      });
    }

    // The PUT handler's getScriptWithOrgCheck uses .from().where().limit();
    // the reference-count checks use .from().where() (no .limit()). This mock
    // serves the existing script for the lookup (.where().limit()) and a count
    // for each reference-check query. Reference queries take two shapes:
    // direct `.from().where()` (automation/patch policies) and the
    // join-chained `.from().innerJoin().innerJoin().where()` (compliance
    // rules). `refCount` is the per-query count (use 0 for "no references").
    function mockScriptLookup(script: any, refCount = 0) {
      const countResult = {
        // count-query path (no .limit) — a thenable resolving to a count row.
        then: (resolve: (v: any) => void) => resolve([{ count: refCount }]),
        limit: vi.fn().mockResolvedValue([script]),
      };
      const whereMock = vi.fn().mockReturnValue(countResult);
      const joinable: any = {
        where: whereMock,
        innerJoin: vi.fn(() => joinable),
      };
      vi.mocked(db.select).mockImplementation(() => ({
        from: vi.fn().mockReturnValue(joinable),
      }) as any);
    }

    function captureUpdate(returnedRow: any) {
      let setValues: any;
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          setValues = vals;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([returnedRow]),
            }),
          };
        }),
      } as any);
      return () => setValues;
    }

    it('partner user promotes an org script to All Orgs (org_id→null)', async () => {
      await withAuth(makePartnerAuth());
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Org Script', orgId: ORG_ID, partnerId: PARTNER_ID,
        isSystem: false, content: 'echo hi', version: 1,
      });
      const getSet = captureUpdate({
        id: SCRIPT_ID_1, name: 'Org Script', orgId: null, partnerId: PARTNER_ID, version: 1,
      });

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ availability: 'partner' }),
      });

      expect(res.status).toBe(200);
      expect(getSet().orgId).toBeNull();
      expect(getSet().partnerId).toBe(PARTNER_ID);
    });

    // ── #3262: partner-wide writes require org_access = 'all' ───────────────
    // Scripts run as SYSTEM on every endpoint, and a partner-wide script covers
    // every org under the partner including ones onboarded later. Partner SCOPE
    // is not the capability; `partnerOrgAccess: 'all'` is.
    it('#3262: a selected-access partner user cannot widen a script to partner-wide', async () => {
      await withAuth(makePartnerAuth('selected'));
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Org Script', orgId: ORG_ID, partnerId: PARTNER_ID,
        isSystem: false, content: 'echo hi', version: 1,
      }, 0);

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ availability: 'partner' }),
      });

      expect(res.status).toBe(403);
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('#3262: a selected-access partner user cannot edit an existing partner-wide script', async () => {
      await withAuth(makePartnerAuth('selected'));
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Partner Script', orgId: null, partnerId: PARTNER_ID,
        isSystem: false, content: 'echo hi', version: 1,
      }, 0);

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        // A plain content edit — no re-scope. The script is already partner-wide,
        // so rewriting its body is rewriting code that runs everywhere.
        body: JSON.stringify({ content: 'echo pwned' }),
      });

      expect(res.status).toBe(403);
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('#3262: a selected-access partner user cannot delete an existing partner-wide script', async () => {
      await withAuth(makePartnerAuth('selected'));
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Partner Script', orgId: null, partnerId: PARTNER_ID,
        isSystem: false, content: 'echo hi', version: 1,
      }, 0);

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer valid-token' },
      });

      expect(res.status).toBe(403);
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    // Control: the gate denies on capability, not on partner scope generally —
    // without this, all three assertions above would pass on a handler that
    // simply rejected every partner write.
    it('#3262: a full-partner admin still can widen a script to partner-wide', async () => {
      await withAuth(makePartnerAuth('all'));
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Org Script', orgId: ORG_ID, partnerId: PARTNER_ID,
        isSystem: false, content: 'echo hi', version: 1,
      }, 0);
      const getSet = captureUpdate({
        id: SCRIPT_ID_1, name: 'Org Script', orgId: null, partnerId: PARTNER_ID, version: 1,
      });

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ availability: 'partner' }),
      });

      expect(res.status).toBe(200);
      expect(getSet().orgId).toBeNull();
    });

    // Control for the DELETE gate: it must deny on capability, not on partner
    // scope generally — a gate that 403'd every partner delete of a
    // partner-wide script would pass the denial tests above.
    it('#3262: a full-partner admin still deletes a partner-wide script', async () => {
      await withAuth(makePartnerAuth('all'));
      // Serves the script lookup AND the active-executions count (0 = none).
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Partner Script', orgId: null, partnerId: PARTNER_ID,
        isSystem: false, content: 'echo hi', version: 1,
      }, 0);
      const getSet = captureUpdate({ id: SCRIPT_ID_1 });

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer valid-token' },
      });

      expect(res.status).toBe(200);
      // Soft delete: the handler stamps deletedAt rather than issuing a DELETE.
      expect(getSet().deletedAt).toBeInstanceOf(Date);
    });

    // ── #3262 review: same-partner ownership enforced in the APP layer ──────
    // In production, RLS makes another partner's row invisible and the read
    // 404s first. These tests bypass RLS (mocked db serves partner A's row to
    // a partner-B admin) to prove the app layer alone still rejects the write
    // — with 404, not 403, so the response doesn't leak that the id exists.
    it('#3262: an admin of another partner cannot edit a partner-wide script (app-layer 404)', async () => {
      await withAuth({ ...makePartnerAuth('all'), partnerId: OTHER_PARTNER_ID });
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Partner Script', orgId: null, partnerId: PARTNER_ID,
        isSystem: false, content: 'echo hi', version: 1,
      }, 0);

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ content: 'echo pwned' }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Script not found');
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('#3262: an admin of another partner cannot delete a partner-wide script (app-layer 404)', async () => {
      await withAuth({ ...makePartnerAuth('all'), partnerId: OTHER_PARTNER_ID });
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Partner Script', orgId: null, partnerId: PARTNER_ID,
        isSystem: false, content: 'echo hi', version: 1,
      }, 0);

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer valid-token' },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Script not found');
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('partner user moves a script org→org (when no references exist)', async () => {
      await withAuth(makePartnerAuth());
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Org Script', orgId: ORG_ID, partnerId: PARTNER_ID,
        isSystem: false, content: 'echo hi', version: 1,
      }, 0);
      const getSet = captureUpdate({
        id: SCRIPT_ID_1, name: 'Org Script', orgId: ORG_ID_2, partnerId: PARTNER_ID, version: 1,
      });

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ availability: 'org', orgId: ORG_ID_2 }),
      });

      expect(res.status).toBe(200);
      expect(getSet().orgId).toBe(ORG_ID_2);
      expect(getSet().partnerId).toBe(PARTNER_ID);
    });

    it('blocks a narrowing re-scope (partner-wide→org) when policy references exist → 409', async () => {
      await withAuth(makePartnerAuth());
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Shared Script', orgId: null, partnerId: PARTNER_ID,
        isSystem: false, content: 'echo hi', version: 1,
      }, 2); // 2 referencing policies

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ availability: 'org', orgId: ORG_ID }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/referenced by automation, patch, or configuration policies/i);
    });

    it('org-scope user cannot re-scope → 403', async () => {
      await withAuth(makeOrgAuth());
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Org Script', orgId: ORG_ID, partnerId: PARTNER_ID,
        isSystem: false, content: 'echo hi', version: 1,
      });

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ availability: 'partner' }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/only partner-scope users/i);
    });

    it('partner user cannot move a script to an org they cannot access → 403', async () => {
      await withAuth(makePartnerAuth());
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Org Script', orgId: ORG_ID, partnerId: PARTNER_ID,
        isSystem: false, content: 'echo hi', version: 1,
      });

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ availability: 'org', orgId: 'a0000000-0000-4000-8000-000000000000' }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/access to this organization denied/i);
    });

    it('a plain metadata edit (no availability) never touches scope', async () => {
      await withAuth(makePartnerAuth());
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Org Script', orgId: ORG_ID, partnerId: PARTNER_ID,
        isSystem: false, content: 'echo hi', version: 1,
      });
      const getSet = captureUpdate({
        id: SCRIPT_ID_1, name: 'Renamed', orgId: ORG_ID, partnerId: PARTNER_ID, version: 1,
      });

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ name: 'Renamed' }),
      });

      expect(res.status).toBe(200);
      expect(getSet().orgId).toBeUndefined();
      expect(getSet().partnerId).toBeUndefined();
    });

    it('partner user cannot re-scope a script owned by a different partner → 404 (cross-partner forge guard)', async () => {
      await withAuth(makePartnerAuth());
      // Script belongs to a DIFFERENT partner (and would be unreachable via RLS
      // in prod, but this asserts the route-level ownership guard explicitly).
      // #3262 review: the partner-wide ownership guard now fires before the
      // re-scope path and answers 404, not 403 — a cross-partner probe must
      // not learn that the script id exists.
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Other Partner Script', orgId: null,
        partnerId: 'b0000000-0000-4000-8000-000000000000',
        isSystem: false, content: 'echo hi', version: 1,
      });

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ availability: 'org', orgId: ORG_ID }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('Script not found');
      expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    });

    it('partner user choosing availability=org without an orgId → 400', async () => {
      await withAuth(makePartnerAuth());
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Partner-wide Script', orgId: null, partnerId: PARTNER_ID,
        isSystem: false, content: 'echo hi', version: 1,
      });

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ availability: 'org' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/orgId is required/i);
    });

    it('blocks an org→org narrowing re-scope when policy references exist → 409', async () => {
      await withAuth(makePartnerAuth());
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Org Script', orgId: ORG_ID, partnerId: PARTNER_ID,
        isSystem: false, content: 'echo hi', version: 1,
      }, 1); // 1 referencing policy

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ availability: 'org', orgId: ORG_ID_2 }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/referenced by automation, patch, or configuration policies/i);
    });

    it('records the old→new scope in the script.update audit on a re-scope', async () => {
      await withAuth(makePartnerAuth());
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Org Script', orgId: ORG_ID, partnerId: PARTNER_ID,
        isSystem: false, content: 'echo hi', version: 1,
      });
      captureUpdate({
        id: SCRIPT_ID_1, name: 'Org Script', orgId: null, partnerId: PARTNER_ID, version: 1,
      });

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ availability: 'partner' }),
      });

      expect(res.status).toBe(200);
      const auditCall = vi.mocked(writeRouteAudit).mock.calls.at(-1)?.[1] as any;
      expect(auditCall?.details?.scopeChange).toEqual({
        from: { orgId: ORG_ID, partnerId: PARTNER_ID },
        to: { orgId: null, partnerId: PARTNER_ID },
      });
    });

    it('a 0-row UPDATE (RLS reject / concurrent delete) → 404, no fabricated audit', async () => {
      await withAuth(makePartnerAuth());
      mockScriptLookup({
        id: SCRIPT_ID_1, name: 'Org Script', orgId: ORG_ID, partnerId: PARTNER_ID,
        isSystem: false, content: 'echo hi', version: 1,
      });
      // UPDATE matches no rows (e.g. the RLS USING clause rejects between read
      // and write) → returning() is empty.
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const res = await app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ availability: 'partner' }),
      });

      expect(res.status).toBe(404);
      // No audit row written for a write that didn't happen.
      expect(vi.mocked(writeRouteAudit)).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------
  // Parameter DEFINITION validation + version bump (#3409 PR3)
  // -------------------------------------------------------------------
  // `parameters` was `z.any()` on both create and update, so definitions
  // reached jsonb entirely unchecked; and `version` only tracked content, so
  // a parameter rename or a source rebinding was invisible to anything
  // pinning the version.
  describe('parameter definitions + version bump', () => {
    function mockCreateInsert(): void {
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: SCRIPT_ID_1, name: 'P', orgId: ORG_ID }]),
        }),
      } as any);
    }

    /** Mock the PUT read + capture what `.set()` receives. */
    function mockUpdate(stored: Record<string, unknown>): { set: ReturnType<typeof vi.fn> } {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: SCRIPT_ID_1, name: 'S', content: 'echo hi', version: 7, isSystem: false, orgId: ORG_ID, ...stored },
            ]),
          }),
          // A tenantVariable/tenantSecret binding triggers the save-time
          // mismatch lookup (loadTenantVariableScope: innerJoin + where).
          // No rows → unknown key → allowed.
          innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
        }),
      } as any);
      const set = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: SCRIPT_ID_1, name: 'S' }]),
        }),
      });
      vi.mocked(db.update).mockReturnValue({ set } as any);
      return { set };
    }

    const put = (body: unknown) =>
      app.request(`/scripts/${SCRIPT_ID_1}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify(body),
      });

    const post = (parameters: unknown) =>
      app.request('/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ name: 'P', osTypes: ['linux'], language: 'bash', content: 'echo hi', parameters }),
      });

    it('accepts a legacy definition with no source on create', async () => {
      mockCreateInsert();
      expect((await post([{ name: 'target', type: 'string' }])).status).toBe(201);
    });

    it('accepts every bound source on create', async () => {
      mockCreateInsert();
      // The tenantVariable binding triggers the save-time mismatch lookup
      // (#3409 PR4c-2); no rows → unknown key → allowed.
      mockTenantVariableScopeRows([]);
      const res = await post([
        { name: 'apiKey', type: 'string', source: 'tenantVariable', variableKey: 'vendor_api_key' },
        { name: 'assetTag', type: 'string', source: 'deviceCustomField', fieldKey: 'asset_tag' },
        { name: 'orgName', type: 'string', source: 'builtin', builtinKey: 'org.name' },
      ]);
      expect(res.status).toBe(201);
    });

    it('rejects a definition whose name could not become an env var', async () => {
      expect((await post([{ name: 'has space', type: 'string' }])).status).toBe(400);
    });

    it('rejects a bound definition missing its binding key', async () => {
      expect((await post([{ name: 'x', type: 'string', source: 'tenantVariable' }])).status).toBe(400);
    });

    it('rejects two names that collide as one BREEZE_PARAM_* env var', async () => {
      // Previously accepted, with a nondeterministic winner per run.
      expect((await post([{ name: 'log-level', type: 'string' }, { name: 'log_level', type: 'string' }])).status).toBe(400);
    });

    it('rejects a non-array parameters value', async () => {
      expect((await post({ notAnArray: true })).status).toBe(400);
    });

    it('bumps version when a parameter definition changes', async () => {
      const { set } = mockUpdate({ parameters: [{ name: 'a', type: 'string' }] });
      expect((await put({ parameters: [{ name: 'a', type: 'number' }] })).status).toBe(200);
      expect(set.mock.calls[0]![0]).toMatchObject({ version: 8 });
    });

    it('bumps version when a parameter is rebound to a tenant variable', async () => {
      const { set } = mockUpdate({ parameters: [{ name: 'a', type: 'string' }] });
      await put({ parameters: [{ name: 'a', type: 'string', source: 'tenantVariable', variableKey: 'api_key' }] });
      expect(set.mock.calls[0]![0]).toMatchObject({ version: 8 });
    });

    it('bumps version when a parameter is added', async () => {
      const { set } = mockUpdate({ parameters: [] });
      await put({ parameters: [{ name: 'a', type: 'string' }] });
      expect(set.mock.calls[0]![0]).toMatchObject({ version: 8 });
    });

    it('does NOT bump version when the definitions are unchanged', async () => {
      // The stored row is in the LEGACY shape (no `source`, no `required`)
      // while the request carries the schema's materialized defaults. Comparing
      // raw would report a change on every save of an untouched script.
      const { set } = mockUpdate({ parameters: [{ name: 'a', type: 'string' }] });
      await put({ parameters: [{ name: 'a', type: 'string', required: false, source: 'runtime' }] });
      expect(set.mock.calls[0]![0]).not.toHaveProperty('version');
    });

    it('does NOT bump version when parameters are omitted entirely', async () => {
      const { set } = mockUpdate({ parameters: [{ name: 'a', type: 'string' }] });
      await put({ name: 'Renamed' });
      expect(set.mock.calls[0]![0]).not.toHaveProperty('version');
    });

    it('bumps version exactly once when content and parameters both change', async () => {
      const { set } = mockUpdate({ parameters: [{ name: 'a', type: 'string' }] });
      await put({ content: 'echo bye', parameters: [{ name: 'b', type: 'string' }] });
      expect(set.mock.calls[0]![0]).toMatchObject({ version: 8 });
    });

    it('still bumps version for a content-only change', async () => {
      const { set } = mockUpdate({});
      await put({ content: 'echo bye' });
      expect(set.mock.calls[0]![0]).toMatchObject({ version: 8 });
    });

    it('rejects a colliding definition on update', async () => {
      mockUpdate({});
      const res = await put({ parameters: [{ name: 'logLevel', type: 'string' }, { name: 'LOGLEVEL', type: 'string' }] });
      expect(res.status).toBe(400);
    });
  });
});
