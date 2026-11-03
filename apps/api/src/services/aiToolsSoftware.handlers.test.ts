import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const SITE = '00000000-0000-4000-8000-0000000000a1';
const DEV = '00000000-0000-4000-8000-0000000000f2';
const DEV2 = '00000000-0000-4000-8000-0000000000f3';
const CAT = '00000000-0000-4000-8000-0000000000b1';
const VER = '00000000-0000-4000-8000-0000000000b2';
const DEPLOY = '00000000-0000-4000-8000-0000000000d1';
const WINDOW = '00000000-0000-4000-8000-0000000000d2';
const PARTNER = '00000000-0000-4000-8000-0000000000e1';

/** A chainable, awaitable Drizzle stand-in: every builder method returns the chain; awaiting it yields `rows`. */
function chain(rows: unknown[], capture?: (method: string, args: unknown[]) => void): unknown {
  const target: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(rows);
      return (...args: unknown[]) => { capture?.(String(prop), args); return proxy; };
    },
  });
  return proxy;
}

const h = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(),
  audit: vi.fn(),
  deleteCatalog: vi.fn(),
  importPackage: vi.fn(),
  prepareCreate: vi.fn(),
  prepareUpdate: vi.fn(),
  insertLatest: vi.fn(),
  setLatest: vi.fn(),
  createDeployment: vi.fn(),
  cancelDeployment: vi.fn(),
  retryDeployment: vi.fn(),
  getDeployment: vi.fn(),
  deploymentSummary: vi.fn(),
  listResults: vi.fn(),
  listDeployments: vi.fn(),
  searchHomebrew: vi.fn(),
  searchWinget: vi.fn(),
  wingetFreshness: vi.fn(),
  annotate: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: h.select, insert: h.insert, update: h.update, delete: h.delete, transaction: h.transaction },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  withDbAccessContext: (_c: unknown, fn: () => unknown) => fn(),
  hasDbAccessContext: () => true,
}));
vi.mock('./auditService', () => ({ createAuditLogAsync: h.audit, createAuditLog: h.audit }));
vi.mock('./softwareCatalogOps', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deleteCatalogAndUploadedObjects: h.deleteCatalog,
  importCatalogPackage: h.importPackage,
  prepareSoftwareVersionCreate: h.prepareCreate,
  prepareSoftwareVersionUpdate: h.prepareUpdate,
}));
vi.mock('./softwareVersionShared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  insertLatestSoftwareVersion: h.insertLatest,
  setLatestSoftwareVersion: h.setLatest,
}));
vi.mock('./softwareDeploymentOps', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  commitThenDeliverWithAuth: (_auth: unknown, admit: (d: unknown[]) => unknown) => admit([]),
  createSoftwareDeploymentFromRequest: h.createDeployment,
}));
vi.mock('./softwareDeploymentLifecycle', () => ({
  cancelSoftwareDeployment: h.cancelDeployment,
  retrySoftwareDeployment: h.retryDeployment,
}));
vi.mock('./softwareDeploymentQueries', () => ({
  getSoftwareDeployment: h.getDeployment,
  getSoftwareDeploymentSummary: h.deploymentSummary,
  listSoftwareDeploymentResults: h.listResults,
  listSoftwareDeployments: h.listDeployments,
}));
vi.mock('./packageSearch', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  searchHomebrew: h.searchHomebrew,
  searchWingetIndex: h.searchWinget,
  getWingetIndexFreshness: h.wingetFreshness,
  annotateBreezeTested: h.annotate,
}));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerSoftwareCatalogTools } from './aiToolsSoftwareCatalog';
import { registerSoftwareDeploymentTools } from './aiToolsSoftwareDeployments';
import { registerPackageSearchTools } from './aiToolsPackageSearch';
import { verifiedUserIdOrNull } from './aiToolsSoftwareShared';

const tools = new Map<string, AiTool>();
for (const register of [registerSoftwareCatalogTools, registerSoftwareDeploymentTools, registerPackageSearchTools]) register(tools);

const makeAuth = (over: Record<string, unknown> = {}) => ({
  principal: { kind: 'user_session' },
  user: { id: 'user-1', email: 'tech@example.test' },
  scope: 'organization',
  orgId: ORG,
  partnerId: null,
  partnerOrgAccess: undefined,
  accessibleOrgIds: [ORG],
  canAccessOrg: (id: string) => id === ORG,
  orgCondition: () => undefined,
  allowedSiteIds: undefined,
  allowedDeviceIds: undefined,
  canAccessSite: undefined,
  token: { mfa: true, amr: ['pwd', 'mfa'] },
  aiOrigin: { kind: 'chat', sessionId: 'session-1' },
  ...over,
}) as unknown as AuthContext;
const noMfa = () => makeAuth({ token: {} });
const siteRestricted = () => makeAuth({ allowedSiteIds: [SITE], canAccessSite: (s: string) => s === SITE });
const deviceBound = () => makeAuth({ allowedDeviceIds: [DEV] });
const agentNoMfa = () => makeAuth({
  principal: { kind: 'ai_agent', agentId: 'agent-1' }, token: {}, aiOrigin: { kind: 'ai_agent', agentRunId: 'run-1' },
});
const partnerAuth = (orgAccess: 'all' | 'selected') => makeAuth({
  scope: 'partner', partnerId: PARTNER, partnerOrgAccess: orgAccess, orgId: null,
});

const run = async (name: string, input: Record<string, unknown>, auth: AuthContext = makeAuth()) =>
  JSON.parse(await tools.get(name)!.handler(input, auth)) as Record<string, unknown>;

const catalogItem = (over: Record<string, unknown> = {}) => ({
  id: CAT, orgId: ORG, partnerId: null, integrationProvider: null, builtinPackageKey: null, name: 'Firefox',
  vendor: 'Mozilla', category: 'browser', description: null, websiteUrl: null, isManaged: false, ...over,
});
const versionRow = (over: Record<string, unknown> = {}) => ({
  id: VER, catalogId: CAT, version: '1.0', isLatest: true, releaseDate: null, releaseNotes: null,
  downloadUrl: null, s3Key: null, fileType: 'msi', checksum: null, fileSize: null, supportedOs: ['windows'],
  architecture: 'x64', silentInstallArgs: null, silentUninstallArgs: null, detectionRules: null, successExitCodes: null,
  preInstallScript: null, postInstallScript: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('verifiedUserIdOrNull (W12-D3)', () => {
  it('returns the id when a users row exists', async () => {
    h.select.mockImplementationOnce(() => chain([{ id: 'user-1' }]));
    expect(await verifiedUserIdOrNull({ user: { id: 'user-1' } } as AuthContext)).toBe('user-1');
  });

  it('returns null when no users row matches (agent principal, synthetic id)', async () => {
    h.select.mockImplementationOnce(() => chain([]));
    expect(await verifiedUserIdOrNull({ user: { id: 'agent-1' } } as AuthContext)).toBeNull();
  });

  it('returns null without a lookup when there is no user id', async () => {
    expect(await verifiedUserIdOrNull({ user: undefined } as unknown as AuthContext)).toBeNull();
    expect(h.select).not.toHaveBeenCalled();
  });
});

describe('manage_software_catalog', () => {
  it('a write without an MFA claim is refused before any DB access; an ai_agent principal is exempt', async () => {
    const refused = await run('manage_software_catalog', { action: 'create', name: 'Pkg' }, noMfa());
    expect(refused.code).toBe('MFA_REQUIRED');
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();

    h.insert.mockImplementation(() => chain([catalogItem({ name: 'Pkg' })]));
    const agentOut = await run('manage_software_catalog', { action: 'create', name: 'Pkg' }, agentNoMfa());
    expect(agentOut.code).toBeUndefined();
    expect(h.insert).toHaveBeenCalledOnce();
  });

  it('reads need no MFA claim', async () => {
    h.select.mockImplementationOnce(() => chain([]));
    const out = await run('manage_software_catalog', { action: 'list' }, noMfa());
    expect(out.packages).toEqual([]);
  });

  it('every write is refused to a site-restricted session before any DB access', async () => {
    for (const input of [
      { action: 'create', name: 'Pkg' },
      { action: 'update', catalogId: CAT, name: 'x' },
      { action: 'add_version', catalogId: CAT, version: '2.0' },
      { action: 'archive', catalogId: CAT },
    ]) {
      expect((await run('manage_software_catalog', input, siteRestricted())).code, input.action).toBe('ACCESS_DENIED');
    }
    expect(h.select).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it.each([
    ['update', { name: 'Renamed' }],
    ['add_version', { version: '2.0', downloadUrl: 'https://example.test/x.msi', fileType: 'msi' }],
    ['archive', {}],
    ['add_install_method', { platform: 'windows', kind: 'winget', packageId: 'Mozilla.Firefox' }],
  ])('an existing partner-wide item is refused for %s, even to a full-access partner admin', async (action, extra) => {
    h.select.mockImplementation(() => chain([catalogItem({ orgId: null, partnerId: PARTNER })]));
    h.update.mockImplementation(() => chain([catalogItem({ orgId: null, partnerId: PARTNER })]));
    h.insert.mockImplementation(() => chain([{ id: 'm1', platform: 'windows', kind: 'winget', packageId: 'Mozilla.Firefox', enabled: true }]));
    h.deleteCatalog.mockResolvedValue({ kind: 'deleted' });
    h.prepareCreate.mockResolvedValue({ ok: true, values: {}, fileType: 'msi' });
    h.insertLatest.mockResolvedValue(versionRow());
    const out = await run('manage_software_catalog', { action, catalogId: CAT, ...extra }, partnerAuth('all'));
    expect(out.code).toBe('ACCESS_DENIED');
    expect(String(out.error)).toMatch(/partner-wide/);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.deleteCatalog).not.toHaveBeenCalled();
    expect(h.prepareCreate).not.toHaveBeenCalled();
  });

  it('a built-in item (no org) is refused as built-in', async () => {
    h.select.mockImplementation(() => chain([catalogItem({ orgId: null, builtinPackageKey: 'firefox' })]));
    const out = await run('manage_software_catalog', { action: 'update', catalogId: CAT, name: 'x' }, partnerAuth('all'));
    expect(out.code).toBe('ACCESS_DENIED');
    expect(String(out.error)).toMatch(/Built-in/);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('an org-owned integration item is refused (the route would allow it)', async () => {
    h.select.mockImplementation(() => chain([catalogItem({ integrationProvider: 'ninite' })]));
    h.update.mockImplementation(() => chain([catalogItem({ integrationProvider: 'ninite', name: 'x' })]));
    const out = await run('manage_software_catalog', { action: 'update', catalogId: CAT, name: 'x' });
    expect(out.code).toBe('ACCESS_DENIED');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('an org-owned item with a built-in key is refused', async () => {
    h.select.mockImplementation(() => chain([catalogItem({ builtinPackageKey: 'firefox' })]));
    h.deleteCatalog.mockResolvedValue({ kind: 'deleted' });
    const out = await run('manage_software_catalog', { action: 'archive', catalogId: CAT });
    expect(out.code).toBe('ACCESS_DENIED');
    expect(h.deleteCatalog).not.toHaveBeenCalled();
  });

  it('an ordinary org-owned item is updated (control for the refusals above)', async () => {
    h.select.mockImplementation(() => chain([catalogItem()]));
    h.update.mockImplementation(() => chain([catalogItem({ name: 'Renamed' })]));
    const out = await run('manage_software_catalog', { action: 'update', catalogId: CAT, name: 'Renamed' });
    expect(out.package).toMatchObject({ id: CAT, name: 'Renamed', ownership: 'organization' });
    expect(h.update).toHaveBeenCalledOnce();
  });

  it('update_version refuses a version that carries an install script, before preparing or writing', async () => {
    h.select
      .mockImplementationOnce(() => chain([catalogItem()]))
      .mockImplementationOnce(() => chain([versionRow({ preInstallScript: 'Stop-Service foo' })]));
    h.prepareUpdate.mockResolvedValue({ ok: true, updates: { releaseNotes: 'n' } });
    h.update.mockImplementation(() => chain([versionRow({ releaseNotes: 'n' })]));
    const out = await run('manage_software_catalog', { action: 'update_version', catalogId: CAT, versionId: VER, releaseNotes: 'n' });
    expect(out.code).toBe('ACCESS_DENIED');
    expect(String(out.error)).toMatch(/install scripts/);
    expect(h.prepareUpdate).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('update_version without scripts goes through prepare and update (control)', async () => {
    h.select
      .mockImplementationOnce(() => chain([catalogItem()]))
      .mockImplementationOnce(() => chain([versionRow()]));
    h.prepareUpdate.mockResolvedValue({ ok: true, updates: { releaseNotes: 'n' } });
    h.update.mockImplementation(() => chain([versionRow({ releaseNotes: 'n' })]));
    const out = await run('manage_software_catalog', { action: 'update_version', catalogId: CAT, versionId: VER, releaseNotes: 'n' });
    expect(out.version).toMatchObject({ id: VER });
    expect(h.prepareUpdate).toHaveBeenCalledOnce();
  });

  it('get returns an explicit projection: download host only, never URLs, S3 keys or scripts', async () => {
    h.select
      .mockImplementationOnce(() => chain([catalogItem()]))
      .mockImplementationOnce(() => chain([
        versionRow({
          downloadUrl: 'https://cdn.vendor.test/setup.msi?X-Amz-Signature=SIGNEDTOKEN',
          preInstallScript: 'echo PRE-SCRIPT-BODY', postInstallScript: 'echo POST-SCRIPT-BODY',
        }),
        versionRow({ id: 'v2', isLatest: false, s3Key: 'tenants/abc/S3KEYVALUE.msi', downloadUrl: null }),
      ]))
      .mockImplementationOnce(() => chain([{ id: 'm1', platform: 'windows', kind: 'winget', packageId: 'Mozilla.Firefox', enabled: true }]));
    const out = await run('manage_software_catalog', { action: 'get', catalogId: CAT });
    const versions = out.versions as Array<Record<string, unknown>>;
    expect(versions[0]).toMatchObject({ downloadHost: 'cdn.vendor.test', hasInstallScripts: true });
    expect(versions[1]).toMatchObject({ downloadHost: 'uploaded', hasInstallScripts: false });
    for (const v of versions) {
      for (const key of ['downloadUrl', 's3Key', 'preInstallScript', 'postInstallScript']) expect(v).not.toHaveProperty(key);
    }
    expect(JSON.stringify(out)).not.toMatch(/SIGNEDTOKEN|S3KEYVALUE|SCRIPT-BODY|X-Amz/);
  });

  it('create with ownerScope partner is refused without full partner access, and allowed with it', async () => {
    const refused = await run('manage_software_catalog', { action: 'create', name: 'Pkg', ownerScope: 'partner' }, partnerAuth('selected'));
    expect(refused.code).toBe('ACCESS_DENIED');
    expect(h.insert).not.toHaveBeenCalled();

    const values: unknown[] = [];
    h.insert.mockImplementation(() => chain([catalogItem({ orgId: null, partnerId: PARTNER, name: 'Pkg' })], (m, args) => {
      if (m === 'values') values.push(args[0]);
    }));
    const ok = await run('manage_software_catalog', { action: 'create', name: 'Pkg', ownerScope: 'partner' }, partnerAuth('all'));
    expect(ok.package).toMatchObject({ ownership: 'partner' });
    expect(values[0]).toMatchObject({ orgId: null, partnerId: PARTNER });
  });
});

describe('manage_software_deployments', () => {
  const create = (over: Record<string, unknown> = {}) => ({
    action: 'create', softwareVersionId: VER, deviceIds: [DEV], ...over,
  });

  it('a write without an MFA claim is refused before any lookup; an ai_agent principal is exempt', async () => {
    expect((await run('manage_software_deployments', create(), noMfa())).code).toBe('MFA_REQUIRED');
    expect(h.select).not.toHaveBeenCalled();
    expect(h.createDeployment).not.toHaveBeenCalled();

    h.select.mockImplementationOnce(() => chain([]));
    h.createDeployment.mockResolvedValue({ status: 201, body: { deployment: { id: DEPLOY } } });
    const out = await run('manage_software_deployments', create(), agentNoMfa());
    expect(out).toMatchObject({ deployment: { id: DEPLOY } });
    expect(h.createDeployment).toHaveBeenCalledOnce();
  });

  it('create refuses more than 100 devices', async () => {
    const deviceIds = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const out = await run('manage_software_deployments', create({ deviceIds }));
    expect(out.code).toBe('VALIDATION_ERROR');
    expect(h.createDeployment).not.toHaveBeenCalled();
  });

  it('create with a device outside the exact-device allowlist is NOT_FOUND and never reaches the service', async () => {
    const out = await run('manage_software_deployments', create({ deviceIds: [DEV, DEV2] }), deviceBound());
    expect(out.code).toBe('NOT_FOUND');
    expect(h.createDeployment).not.toHaveBeenCalled();
  });

  it('create passes createdBy from the verified users row, or NULL when the lookup misses', async () => {
    h.createDeployment.mockResolvedValue({ status: 201, body: { deployment: { id: DEPLOY } } });
    h.select.mockImplementationOnce(() => chain([{ id: 'user-1' }]));
    await run('manage_software_deployments', create());
    expect(h.createDeployment).toHaveBeenLastCalledWith(expect.objectContaining({
      createdBy: 'user-1', orgId: ORG,
      payload: expect.objectContaining({ targetType: 'devices', targetIds: [DEV], deploymentType: 'install' }),
    }));

    h.select.mockImplementationOnce(() => chain([]));
    await run('manage_software_deployments', create());
    expect(h.createDeployment).toHaveBeenLastCalledWith(expect.objectContaining({ createdBy: null }));
  });

  it('a maintenance window outside the deployment org is not found and nothing is created', async () => {
    h.select
      .mockImplementationOnce(() => chain([{ id: 'user-1' }]))
      .mockImplementationOnce(() => chain([]));
    h.createDeployment.mockResolvedValue({ status: 201, body: { deployment: { id: DEPLOY } } });
    const out = await run('manage_software_deployments', create({ scheduleType: 'maintenance', maintenanceWindowId: WINDOW }));
    expect(out.code).toBe('NOT_FOUND');
    expect(h.createDeployment).not.toHaveBeenCalled();
  });

  it('list and summary are refused to a device-bound session', async () => {
    for (const action of ['list', 'summary']) {
      expect((await run('manage_software_deployments', { action }, deviceBound())).code, action).toBe('ACCESS_DENIED');
    }
    expect(h.listDeployments).not.toHaveBeenCalled();
    expect(h.deploymentSummary).not.toHaveBeenCalled();
  });

  it.each([
    ['get', h.getDeployment],
    ['cancel', h.cancelDeployment],
    ['retry', h.retryDeployment],
  ] as const)('%s is NOT_FOUND when the deployment has a device outside the allowlist', async (action, service) => {
    h.select.mockImplementation(() => chain([{ deviceId: DEV }, { deviceId: DEV2 }]));
    const out = await run('manage_software_deployments', { action, deploymentId: DEPLOY }, deviceBound());
    expect(out.code).toBe('NOT_FOUND');
    expect(service).not.toHaveBeenCalled();
  });

  it('get reaches the service when every device is in the allowlist (control)', async () => {
    h.select.mockImplementation(() => chain([{ deviceId: DEV }]));
    h.getDeployment.mockResolvedValue({ id: DEPLOY });
    const out = await run('manage_software_deployments', { action: 'get', deploymentId: DEPLOY }, deviceBound());
    expect(out).toEqual({ deployment: { id: DEPLOY } });
  });
});

describe('search_packages', () => {
  it('macos calls searchHomebrew with the clamped limit', async () => {
    h.searchHomebrew.mockResolvedValue({ degraded: false, results: [{ id: 'firefox' }] });
    const out = await run('search_packages', { platform: 'macos', query: 'firefox', limit: 500 });
    expect(h.searchHomebrew).toHaveBeenCalledWith('firefox', 25);
    expect(out).toEqual({ results: [{ id: 'firefox' }] });
    await run('search_packages', { platform: 'macos', query: 'firefox', limit: 3 });
    expect(h.searchHomebrew).toHaveBeenLastCalledWith('firefox', 3);
    expect(h.searchWinget).not.toHaveBeenCalled();
  });

  it('a degraded Homebrew catalogue surfaces degraded: true', async () => {
    h.searchHomebrew.mockResolvedValue({ degraded: true, results: [] });
    const out = await run('search_packages', { platform: 'macos', query: 'firefox' });
    expect(out).toMatchObject({ results: [], degraded: true });
  });

  it('an empty winget index is reported as degraded', async () => {
    h.searchWinget.mockResolvedValue([]);
    h.wingetFreshness.mockResolvedValue({ packages: 0, lastSyncedAt: null });
    const out = await run('search_packages', { platform: 'windows', query: 'firefox' });
    expect(out).toMatchObject({ results: [], degraded: true });
  });
});
