import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  dashboardForOrg: vi.fn(),
  serviceOverview: vi.fn(),
  documentsForOrg: vi.fn(),
  securityOverview: vi.fn(),
  backupOverview: vi.fn(),
  listPortalRuns: vi.fn(),
  brandingRow: vi.fn(),
  resolveOrgTimezone: vi.fn(),
}));

vi.mock('./dashboard', () => ({ dashboardForOrg: m.dashboardForOrg }));
vi.mock('./serviceReadModel', () => ({ serviceOverview: m.serviceOverview }));
vi.mock('./documentsReadModel', () => ({ documentsForOrg: m.documentsForOrg }));
vi.mock('./securityReadModel', () => ({ securityOverview: m.securityOverview }));
vi.mock('./backupReadModel', () => ({ backupOverview: m.backupOverview }));
vi.mock('./reportsSelfService', () => ({ listPortalRuns: m.listPortalRuns }));
vi.mock('./timezone', () => ({ resolveOrgTimezone: m.resolveOrgTimezone }));
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => m.brandingRow()) })) })),
    })),
  },
}));
vi.mock('../../db/schema', () => {
  const col = (name: string) => name;
  return {
    portalBranding: new Proxy({}, { get: (_t, p) => col(String(p)) }),
  };
});
vi.mock('../../routes/portal/ticketOwnership', () => ({
  portalTicketOwnership: vi.fn((u: { id: string }) => ({ ownership: u.id })),
}));
// #8972: the dashboard's ticket set (own + survivors of merged tickets) — same sentinel shape.
vi.mock('../../routes/portal/ticketReadAccess', () => ({
  portalDashboardTicketScope: vi.fn((u: { id: string }) => ({ ownership: u.id })),
}));

import { PORTAL_SECTION_GATES } from '../../routes/portal/featureFlags';
import {
  PORTAL_PREVIEW_SECTION_KEYS,
  buildPortalPreview,
  computeReadiness,
  type PreviewSection,
} from './portalPreview';

const ORG = '7c0a1f7e-1111-4222-8333-444455556666';

const ALL_OFF: Record<string, boolean> = Object.fromEntries(
  PORTAL_SECTION_GATES.flatMap((g) => g.flags).map((f) => [f, false]),
);
const allOn = Object.fromEntries(Object.keys(ALL_OFF).map((f) => [f, true]));

const section = (key: string, data: unknown, enabled = true): PreviewSection =>
  ({ key, enabled, data, previewAvailable: true }) as PreviewSection;

const ALLOW_ALL = () => true;
const BRANDED = { logoUrl: 'x', primaryColor: null, welcomeMessage: null, supportEmail: null, supportPhone: null };

describe('computeReadiness (#9350)', () => {
  it('documents_empty: Documents on with 0 portal-visible documents → exactly one check', () => {
    const r = computeReadiness({
      sections: [section('documents', { groups: [] })],
      brandingSet: true,
    });
    expect(r.map((c) => c.code)).toEqual(['documents_empty']);
  });

  it('documents_empty is not raised when documents exist or the section is off', () => {
    const withDocs = computeReadiness({
      sections: [section('documents', { groups: [{ category: 'runbook', documents: [{ id: 'd1' }] }] })],
      brandingSet: true,
    });
    expect(withDocs).toEqual([]);
    const off = computeReadiness({ sections: [section('documents', null, false)], brandingSet: true });
    expect(off).toEqual([]);
  });

  it('reports_empty: Reports on with 0 runs', () => {
    const r = computeReadiness({
      sections: [section('reports', { data: [], pagination: { page: 1, limit: 20, total: 0 } })],
      brandingSet: true,
    });
    expect(r.map((c) => c.code)).toEqual(['reports_empty']);
  });

  it('service_one_time_visible: Service on with a one-time deliverable still visible', () => {
    const r = computeReadiness({
      sections: [section('service', { groups: [{ deliverables: [{ cadence: 'monthly' }, { cadence: 'one_time' }] }] })],
      brandingSet: true,
    });
    expect(r.map((c) => c.code)).toEqual(['service_one_time_visible']);
  });

  it.each(['not_configured', 'no_data'])('backups_no_data: Backups on with dataStatus %s', (dataStatus) => {
    const r = computeReadiness({ sections: [section('backups', { dataStatus })], brandingSet: true });
    expect(r.map((c) => c.code)).toEqual(['backups_no_data']);
  });

  it('backups_no_data is not raised for ok data', () => {
    expect(computeReadiness({ sections: [section('backups', { dataStatus: 'ok' })], brandingSet: true })).toEqual([]);
  });

  it('dashboard_security_no_data: Dashboard on but the security score tile has no data', () => {
    const r = computeReadiness({
      sections: [section('dashboard', { securityScore: { status: 'no_data', score: null } })],
      brandingSet: true,
    });
    expect(r.map((c) => c.code)).toEqual(['dashboard_security_no_data']);
  });

  it('branding_unset: portal branding never set', () => {
    const r = computeReadiness({ sections: [], brandingSet: false });
    expect(r.map((c) => c.code)).toEqual(['branding_unset']);
  });

  it('every check carries a short message and a fix target', () => {
    const r = computeReadiness({
      sections: [
        section('documents', { groups: [] }),
        section('reports', { data: [], pagination: { page: 1, limit: 20, total: 0 } }),
        section('backups', { dataStatus: 'not_configured' }),
      ],
      brandingSet: false,
    });
    expect(r.length).toBe(4);
    for (const c of r) {
      expect(c.message.length).toBeGreaterThan(10);
      expect(c.fixTab).toBeTruthy();
    }
  });
});

describe('buildPortalPreview (#9350)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.resolveOrgTimezone.mockResolvedValue('America/Chicago');
    m.brandingRow.mockResolvedValue([{ ...ALL_OFF, ...BRANDED }]);
    m.dashboardForOrg.mockResolvedValue({
      securityScore: { status: 'ok' }, support: { openTickets: 3 }, backup: undefined,
    });
    m.serviceOverview.mockResolvedValue({ groups: [] });
    m.documentsForOrg.mockResolvedValue({ groups: [{ category: 'runbook', documents: [{ id: 'd' }] }] });
    m.securityOverview.mockResolvedValue({ dataStatus: 'ok' });
    m.backupOverview.mockResolvedValue({ dataStatus: 'ok' });
    m.listPortalRuns.mockResolvedValue({ data: [{ id: 'r' }], pagination: { page: 1, limit: 20, total: 1 } });
  });

  it('returns one entry per gate-table row; every previewable key is a table key', () => {
    const tableKeys = PORTAL_SECTION_GATES.map((g) => g.key) as string[];
    for (const k of PORTAL_PREVIEW_SECTION_KEYS) expect(tableKeys).toContain(k);
  });

  it('with every flag off: enabled:false, data:null, and no read model is called', async () => {
    const out = await buildPortalPreview({ orgId: ORG, portalUser: null, can: ALLOW_ALL });
    expect(out.sections.map((s) => s.key)).toEqual(PORTAL_SECTION_GATES.map((g) => g.key));
    for (const s of out.sections) {
      expect(s.enabled).toBe(false);
      expect(s.data).toBeNull();
    }
    for (const fn of [m.dashboardForOrg, m.serviceOverview, m.documentsForOrg, m.securityOverview, m.backupOverview, m.listPortalRuns]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it.each(PORTAL_SECTION_GATES.flatMap((g) => g.flags.map((f) => [g.key, f] as const)))(
    'section %s stays disabled and runs no query when only the unrelated flags are on but %s is off',
    async (key, flag) => {
      m.brandingRow.mockResolvedValue([{ ...allOn, [flag]: false, ...BRANDED }]);
      const out = await buildPortalPreview({ orgId: ORG, portalUser: null, can: ALLOW_ALL });
      const s = out.sections.find((x) => x.key === key)!;
      expect(s.enabled).toBe(false);
      expect(s.data).toBeNull();
    },
  );

  it('a missing portal_branding row is fail-closed (everything disabled) and flags branding_unset', async () => {
    m.brandingRow.mockResolvedValue([]);
    const out = await buildPortalPreview({ orgId: ORG, portalUser: null, can: ALLOW_ALL });
    expect(out.sections.every((s) => !s.enabled)).toBe(true);
    expect(out.readiness.map((r) => r.code)).toContain('branding_unset');
  });

  it('runs each enabled read model with the org timezone and portal-user-independent args', async () => {
    m.brandingRow.mockResolvedValue([{ ...allOn, ...BRANDED }]);
    const out = await buildPortalPreview({ orgId: ORG, portalUser: null, can: ALLOW_ALL });
    expect(m.serviceOverview).toHaveBeenCalledWith(ORG, expect.objectContaining({ timezone: 'America/Chicago' }));
    expect(m.documentsForOrg).toHaveBeenCalledWith(ORG, expect.objectContaining({ timezone: 'America/Chicago' }));
    expect(m.securityOverview).toHaveBeenCalledWith(ORG, expect.objectContaining({ days: 30, timezone: 'America/Chicago' }));
    expect(m.backupOverview).toHaveBeenCalledWith(ORG, expect.objectContaining({ timezone: 'America/Chicago' }));
    expect(m.listPortalRuns).toHaveBeenCalledWith(ORG, 'America/Chicago', { page: 1, limit: 20 });
    expect(out.sections.find((s) => s.key === 'service')!.data).toEqual({ groups: [] });
  });

  it('without portalUser the dashboard support tile is omitted with a note', async () => {
    m.brandingRow.mockResolvedValue([{ ...allOn, ...BRANDED }]);
    const out = await buildPortalPreview({ orgId: ORG, portalUser: null, can: ALLOW_ALL });
    const dash = out.sections.find((s) => s.key === 'dashboard')!;
    expect(dash.data).not.toHaveProperty('support');
    expect(dash.note).toMatch(/portal user/i);
  });

  it('with a portalUser the dashboard is built with that user\'s ticket ownership and keeps support', async () => {
    m.brandingRow.mockResolvedValue([{ ...allOn, ...BRANDED }]);
    const out = await buildPortalPreview({ orgId: ORG, portalUser: { id: 'pu-1', contactId: 'c-1', name: 'Pat', email: 'p@x.example' }, can: ALLOW_ALL });
    expect(m.dashboardForOrg.mock.calls[0]![2]).toEqual({ ownership: 'pu-1' });
    const dash = out.sections.find((s) => s.key === 'dashboard')!;
    expect(dash.data).toHaveProperty('support', { openTickets: 3 });
    expect(dash.note).toBeUndefined();
  });

  it('lifecycleReports needs Reports too (parent gate), exactly like the portal router', async () => {
    m.brandingRow.mockResolvedValue([{ ...ALL_OFF, enableLifecycle: true, ...BRANDED }]);
    const off = await buildPortalPreview({ orgId: ORG, portalUser: null, can: ALLOW_ALL });
    expect(off.sections.find((s) => s.key === 'lifecycleReports')!.enabled).toBe(false);
    m.brandingRow.mockResolvedValue([{ ...ALL_OFF, enableLifecycle: true, enableReports: true, ...BRANDED }]);
    const on = await buildPortalPreview({ orgId: ORG, portalUser: null, can: ALLOW_ALL });
    expect(on.sections.find((s) => s.key === 'lifecycleReports')!.enabled).toBe(true);
  });

  it('a throwing read model fails only its own section (logged, not "empty"); others still render', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    m.brandingRow.mockResolvedValue([{ ...ALL_OFF, enableDocuments: true, enableService: true, ...BRANDED }]);
    m.documentsForOrg.mockRejectedValue(new Error('boom'));
    const out = await buildPortalPreview({ orgId: ORG, portalUser: null, can: ALLOW_ALL });
    expect(out.sections.find((s) => s.key === 'documents')).toMatchObject({ enabled: true, data: null, error: 'load_failed' });
    expect(out.sections.find((s) => s.key === 'service')!.data).toEqual({ groups: [] });
    expect(out.readiness.map((r) => r.code)).not.toContain('documents_empty');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('builder: Documents on with no documents yields exactly documents_empty; an all-null branding row yields branding_unset', async () => {
    m.brandingRow.mockResolvedValue([{ ...ALL_OFF, enableDocuments: true, logoUrl: null, primaryColor: null, welcomeMessage: null, supportEmail: null, supportPhone: null }]);
    m.documentsForOrg.mockResolvedValue({ groups: [] });
    const out = await buildPortalPreview({ orgId: ORG, portalUser: null, can: ALLOW_ALL });
    expect(out.readiness.map((r) => r.code).sort()).toEqual(['branding_unset', 'documents_empty']);
  });

  it('sections without a preview runner report their flag but data:null', async () => {
    m.brandingRow.mockResolvedValue([{ ...allOn, ...BRANDED }]);
    const out = await buildPortalPreview({ orgId: ORG, portalUser: null, can: ALLOW_ALL });
    const hw = out.sections.find((s) => s.key === 'hardwareHealth')!;
    expect(hw.enabled).toBe(true);
    expect(hw.previewAvailable).toBe(false);
    expect(hw.data).toBeNull();
  });
});

// ── Per-section staff permission gating (#9350 review: authz) ───────────────
// Holding organizations:read alone must NOT reveal data the staff-side routes
// gate on devices:read / reports:read / tickets:read / ...
type Grant = { resource: string; action: string };
const grantKey = (g: Grant) => `${g.resource}:${g.action}`;
const ORGS_READ_ONLY = (r: string, a: string) => r === 'organizations' && a === 'read';
const allExcept = (denied: string) => (r: string, a: string) => `${r}:${a}` !== denied;
const READ_MODELS = () => [m.dashboardForOrg, m.serviceOverview, m.documentsForOrg, m.securityOverview, m.backupOverview, m.listPortalRuns];
const RUNNER_FN: Record<string, () => ReturnType<typeof vi.fn>> = {
  dashboard: () => m.dashboardForOrg, security: () => m.securityOverview, backups: () => m.backupOverview,
  reports: () => m.listPortalRuns, service: () => m.serviceOverview, documents: () => m.documentsForOrg,
};
const PU = { id: 'pu-1', contactId: 'c-1', name: 'Pat', email: 'p@x.example' };

describe('buildPortalPreview — per-section staff permission (#9350)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.brandingRow.mockResolvedValue([{ ...allOn, ...BRANDED }]);
    m.resolveOrgTimezone.mockResolvedValue('UTC');
    m.dashboardForOrg.mockResolvedValue({ securityScore: { status: 'ok' }, support: { openTickets: 3 } });
    m.serviceOverview.mockResolvedValue({ groups: [] });
    m.documentsForOrg.mockResolvedValue({ groups: [] });
    m.securityOverview.mockResolvedValue({ dataStatus: 'ok' });
    m.backupOverview.mockResolvedValue({ dataStatus: 'ok' });
    m.listPortalRuns.mockResolvedValue({ data: [], pagination: { page: 1, limit: 20, total: 0 } });
  });

  it('organizations:read only: every section withheld (reason permission), no read model runs, no section-derived readiness', async () => {
    const out = await buildPortalPreview({ orgId: ORG, portalUser: null, can: ORGS_READ_ONLY });
    expect(out.sections.map((s) => s.key)).toEqual(PORTAL_SECTION_GATES.map((g) => g.key));
    for (const s of out.sections) {
      expect(s, s.key).toMatchObject({ enabled: true, data: null, previewAvailable: false, reason: 'permission' });
    }
    for (const fn of READ_MODELS()) expect(fn).not.toHaveBeenCalled();
    expect(out.readiness.map((r) => r.code)).toEqual([]);
  });

  it.each(PORTAL_SECTION_GATES.flatMap((g) => g.staffPermissions.map((p) => [g.key, grantKey(p)] as const)))(
    'section %s is withheld when the caller lacks %s (holds everything else)',
    async (key, denied) => {
      const out = await buildPortalPreview({ orgId: ORG, portalUser: null, can: allExcept(denied) });
      const s = out.sections.find((x) => x.key === key)!;
      expect(s).toMatchObject({ data: null, previewAvailable: false, reason: 'permission' });
      if (RUNNER_FN[key]) expect(RUNNER_FN[key]()).not.toHaveBeenCalled();
    },
  );

  it.each(PORTAL_PREVIEW_SECTION_KEYS)('section %s renders when the caller holds exactly its permissions', async (key) => {
    const row = PORTAL_SECTION_GATES.find((g) => g.key === key)!;
    const held = new Set<string>(['organizations:read', ...row.staffPermissions.map(grantKey)]);
    const out = await buildPortalPreview({ orgId: ORG, portalUser: null, can: (r, a) => held.has(`${r}:${a}`) });
    const s = out.sections.find((x) => x.key === key)!;
    expect(s).not.toHaveProperty('reason');
    expect(s.previewAvailable).toBe(true);
    expect(RUNNER_FN[key]!()).toHaveBeenCalledTimes(1);
  });

  it('dashboard without tickets:read omits only the support tile (portal user picked)', async () => {
    const out = await buildPortalPreview({ orgId: ORG, portalUser: PU, can: allExcept('tickets:read') });
    const dash = out.sections.find((s) => s.key === 'dashboard')!;
    expect(dash).not.toHaveProperty('reason');
    expect(dash.data).toHaveProperty('securityScore');
    expect(dash.data).not.toHaveProperty('support');
    expect(dash.missingPermissions).toEqual(['tickets:read']);
  });

  // The dashboard DTO embeds tiles sourced from other domains; each needs the
  // permission that gates that domain on the staff side (security-review finding).
  const FULL_DASH = {
    securityScore: { status: 'ok' }, devicesProtected: {}, patchesApplied: {}, actionItems: {},
    backup: { x: 1 }, support: { openTickets: 3 }, awaitingYou: { y: 1 }, service: { z: 1 },
  };
  it.each([
    ['backup', ['backup:read']],
    ['support', ['tickets:read']],
    ['service', ['contracts:read']],
    ['awaitingYou', ['invoices:read']],
    ['awaitingYou', ['quotes:read']],
  ] as const)('dashboard omits the %s tile when the caller lacks any of %j (others kept)', async (tile, denied) => {
    m.dashboardForOrg.mockResolvedValue({ ...FULL_DASH });
    const out = await buildPortalPreview({ orgId: ORG, portalUser: PU, can: allExcept(denied[0]) });
    const dash = out.sections.find((s) => s.key === 'dashboard')!;
    expect(dash).not.toHaveProperty('reason');
    expect(dash.data).not.toHaveProperty(tile);
    expect(dash.data).toHaveProperty('securityScore');
    expect(dash.missingPermissions).toEqual([denied[0]]);
    for (const other of ['backup', 'support', 'service', 'awaitingYou'].filter((k) => k !== tile)) {
      expect(dash.data, other).toHaveProperty(other);
    }
  });

  it('dashboard fails closed: a tile that is neither a device tile nor permission-mapped is dropped, even for a wildcard-less caller', async () => {
    m.dashboardForOrg.mockResolvedValue({ ...FULL_DASH, newCrossDomainTile: { secret: 1 } });
    const out = await buildPortalPreview({ orgId: ORG, portalUser: PU, can: ALLOW_ALL });
    const dash = out.sections.find((s) => s.key === 'dashboard')!;
    expect(dash.data).not.toHaveProperty('newCrossDomainTile');
    expect(dash.data).toHaveProperty('securityScore');
  });

  it('dashboard lists every missing tile permission once', async () => {
    m.dashboardForOrg.mockResolvedValue({ ...FULL_DASH });
    const out = await buildPortalPreview({ orgId: ORG, portalUser: PU, can: (r, a) => `${r}:${a}` === 'devices:read' });
    const dash = out.sections.find((s) => s.key === 'dashboard')!;
    expect([...dash.missingPermissions!].sort()).toEqual(['backup:read', 'contracts:read', 'invoices:read', 'quotes:read', 'tickets:read']);
    expect(Object.keys(dash.data as object).sort()).toEqual(['actionItems', 'devicesProtected', 'patchesApplied', 'securityScore']);
  });

  it('dashboard with every permission keeps every tile and has no note', async () => {
    m.dashboardForOrg.mockResolvedValue({ ...FULL_DASH });
    const out = await buildPortalPreview({ orgId: ORG, portalUser: PU, can: ALLOW_ALL });
    const dash = out.sections.find((s) => s.key === 'dashboard')!;
    for (const k of Object.keys(FULL_DASH)) expect(dash.data).toHaveProperty(k);
    expect(dash.note).toBeUndefined();
    expect(dash).not.toHaveProperty('missingPermissions');
  });

  it('dashboard with tickets:read keeps the support tile', async () => {
    const out = await buildPortalPreview({ orgId: ORG, portalUser: PU, can: ALLOW_ALL });
    expect(out.sections.find((s) => s.key === 'dashboard')!.data).toHaveProperty('support');
  });

  it('a withheld section does not feed readiness (documents_empty) while a permitted one does', async () => {
    const withheld = await buildPortalPreview({ orgId: ORG, portalUser: null, can: allExcept('documents:read') });
    expect(withheld.readiness.map((r) => r.code)).not.toContain('documents_empty');
    const permitted = await buildPortalPreview({ orgId: ORG, portalUser: null, can: ALLOW_ALL });
    expect(permitted.readiness.map((r) => r.code)).toContain('documents_empty');
  });
});
