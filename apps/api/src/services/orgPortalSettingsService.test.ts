import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const onPortalFlagsChanged = vi.hoisted(() => vi.fn());
vi.mock('./portal/portalFlags', async () => {
  const actual = await vi.importActual<typeof import('./portal/portalFlags')>('./portal/portalFlags');
  return { ...actual, onPortalFlagsChanged };
});

// A recorder db: every chain step lands in `calls`, so the tests can see the order of the lock and the write.
const { calls, state } = vi.hoisted(() => ({
  calls: [] as string[],
  state: {
    lockedRow: undefined as Record<string, unknown> | undefined,
    upserted: undefined as Record<string, unknown> | undefined,
    plainSelect: [] as unknown[],
  },
}));

function makeHandle(label: string) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const result = label === 'tx' ? (state.lockedRow ? [state.lockedRow] : []) : state.plainSelect;
          const limited = Object.assign(Promise.resolve(result), {
            for: vi.fn((mode: string) => { calls.push(`${label}.select.for(${mode})`); return Promise.resolve(result); }),
          });
          return { limit: vi.fn(() => { calls.push(`${label}.select`); return limited; }) };
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => ({
        onConflictDoNothing: vi.fn(() => { calls.push(`${label}.insertDefault`); return Promise.resolve(); }),
        onConflictDoUpdate: vi.fn((cfg: { set: Record<string, unknown> }) => ({
          returning: vi.fn(() => {
            calls.push(`${label}.upsert`);
            state.upserted = { ...values, set: cfg.set };
            return Promise.resolve([{ ...DEFAULT_ROW, ...(state.lockedRow ?? {}), ...cfg.set }]);
          }),
        })),
      })),
    })),
  };
}

const DEFAULT_ROW = {
  enableTickets: true, enableAssetCheckout: false, enableDevices: false, enableSelfService: true, enablePasswordReset: true,
  enableDashboard: false, enableSecurity: false, enableBackups: false, enableReports: false, enableSupportUsage: false,
  enableService: false, enableDocuments: false, enableLifecycle: false, enableHardwareHealth: false,
  enableHardwareInventory: false, enablePerformanceMetrics: false, enableSoftwareInventory: false,
  enableNetworkVisibility: false, enableEdrVisibility: false, enableNetworkAlerts: false, enableHourBlock: false,
  enablePatchDetail: false, enableVulnerabilityDetail: false, enablePhysicalPlacement: false, enableTrustPageEditing: false,
  chromeAccent: null, supportEmail: null, supportPhone: null, welcomeMessage: null, footerText: null, logoUrl: null,
  primaryColor: null, secondaryColor: null, customCss: null,
};

vi.mock('../db', () => {
  const root = makeHandle('db');
  return {
    db: {
      ...root,
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        calls.push('db.transaction');
        const out = await fn(makeHandle('tx'));
        calls.push('db.commit');
        return out;
      }),
    },
  };
});

import {
  PORTAL_SENSITIVE_PARENTS,
  PORTAL_TOOL_SENSITIVE_KEYS,
  applyOrgPortalSettings,
  portalSensitiveActivations,
} from './orgPortalSettingsService';
import { PORTAL_PERMISSION_FLAG_KEYS, PORTAL_SENSITIVE_FLAG_KEYS } from '@breeze/shared';
import { PORTAL_SECTION_GATES, portalSectionEffectiveFlags } from '../routes/portal/featureFlags';

const ORG = '7c0a1f7e-1111-4222-8333-444455556666';

beforeEach(() => {
  calls.length = 0;
  state.lockedRow = undefined;
  state.upserted = undefined;
  onPortalFlagsChanged.mockReset();
});

describe('portalSensitiveActivations', () => {
  it('a parent enable activates a sensitive child already on', () => {
    expect(portalSensitiveActivations({ enableNetworkVisibility: true }, { ...DEFAULT_ROW, enablePhysicalPlacement: true }))
      .toEqual(['enablePhysicalPlacement']);
  });
  it('no child on, an already-on parent, a parent disable and a named child activate nothing', () => {
    expect(portalSensitiveActivations({ enableNetworkVisibility: true }, DEFAULT_ROW)).toEqual([]);
    expect(portalSensitiveActivations({ enableNetworkVisibility: true }, { ...DEFAULT_ROW, enableNetworkVisibility: true, enableNetworkAlerts: true })).toEqual([]);
    expect(portalSensitiveActivations({ enableSupportUsage: false }, { ...DEFAULT_ROW, enableSupportUsage: true, enableHourBlock: true })).toEqual([]);
    expect(portalSensitiveActivations({ enableNetworkVisibility: true, enableNetworkAlerts: true }, { ...DEFAULT_ROW, enableNetworkAlerts: true })).toEqual([]);
  });
  it('a missing row is the defaults (every child off)', () => {
    expect(portalSensitiveActivations({ enableSupportUsage: true }, undefined)).toEqual([]);
  });
});

describe('applyOrgPortalSettings', () => {
  it('REST path (no option): one plain upsert, no transaction, no lock', async () => {
    const result = await applyOrgPortalSettings(ORG, { enableTickets: false }, 'u-1');
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['db.upsert']);
  });

  it('update refuses a parent enable that activates a sensitive child, and writes nothing', async () => {
    state.lockedRow = { ...DEFAULT_ROW, enableHourBlock: true };
    const result = await applyOrgPortalSettings(ORG, { enableSupportUsage: true }, 'u-1', { refuseSensitiveActivation: true });
    expect(result).toEqual({ ok: false, code: 'SENSITIVE_ACTIVATION', children: ['enableHourBlock'] });
    expect(calls).not.toContain('tx.upsert');
    expect(onPortalFlagsChanged).not.toHaveBeenCalled();
  });

  it('allows the parent enable when no child is on, and a parent disable', async () => {
    state.lockedRow = { ...DEFAULT_ROW };
    expect((await applyOrgPortalSettings(ORG, { enableSupportUsage: true }, 'u-1', { refuseSensitiveActivation: true })).ok).toBe(true);
    state.lockedRow = { ...DEFAULT_ROW, enableNetworkVisibility: true, enableNetworkAlerts: true };
    expect((await applyOrgPortalSettings(ORG, { enableNetworkVisibility: false }, 'u-1', { refuseSensitiveActivation: true })).ok).toBe(true);
  });

  it('the check and the write share one row lock: default row, FOR UPDATE, then the upsert, in one transaction', async () => {
    state.lockedRow = { ...DEFAULT_ROW };
    await applyOrgPortalSettings(ORG, { enableReports: true }, 'u-1', { refuseSensitiveActivation: true });
    expect(calls).toEqual(['db.transaction', 'tx.insertDefault', 'tx.select', 'tx.select.for(update)', 'tx.upsert', 'db.commit']);
    // The report-provisioning hook runs after the commit, with the actor.
    expect(onPortalFlagsChanged).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, createdBy: 'u-1', requested: { enableReports: true } }));
  });
});

describe('applyOrgPortalSettings ordering (audit before the provisioning hook)', () => {
  it('onPersisted runs after the upsert and before onPortalFlagsChanged, on both paths; never on a refusal', async () => {
    for (const opts of [{}, { refuseSensitiveActivation: true }]) {
      calls.length = 0;
      state.lockedRow = { ...DEFAULT_ROW };
      onPortalFlagsChanged.mockImplementation(async () => { calls.push('hook'); });
      await applyOrgPortalSettings(ORG, { enableReports: true }, 'u-1', { ...opts, onPersisted: () => calls.push('audit') });
      expect(calls.slice(calls.findIndex((c) => c.endsWith('upsert')))).toEqual(
        opts.refuseSensitiveActivation ? ['tx.upsert', 'db.commit', 'audit', 'hook'] : ['db.upsert', 'audit', 'hook'],
      );
    }
    calls.length = 0;
    state.lockedRow = { ...DEFAULT_ROW, enableHourBlock: true };
    await applyOrgPortalSettings(ORG, { enableSupportUsage: true }, 'u-1', { refuseSensitiveActivation: true, onPersisted: () => calls.push('audit') });
    expect(calls).not.toContain('audit');
  });
});

describe('PORTAL_SENSITIVE_PARENTS', () => {
  it('every child is a sensitive flag and every parent is not', () => {
    for (const [parent, children] of Object.entries(PORTAL_SENSITIVE_PARENTS)) {
      expect((PORTAL_SENSITIVE_FLAG_KEYS as readonly string[]).includes(parent), parent).toBe(false);
      for (const child of children) expect((PORTAL_SENSITIVE_FLAG_KEYS as readonly string[]).includes(child), child).toBe(true);
    }
    expect([...PORTAL_TOOL_SENSITIVE_KEYS].sort()).toEqual(
      [...PORTAL_SENSITIVE_FLAG_KEYS, ...PORTAL_PERMISSION_FLAG_KEYS, ...Object.keys(PORTAL_SENSITIVE_PARENTS)].sort(),
    );
  });

  it('is exhaustive over the section gate table: a sensitive flag shares a section only with its known parents', () => {
    for (const row of PORTAL_SECTION_GATES) {
      const flags = portalSectionEffectiveFlags(row) as readonly string[];
      for (const flag of flags) {
        if (!(PORTAL_SENSITIVE_FLAG_KEYS as readonly string[]).includes(flag)) continue;
        for (const other of flags) {
          if (other === flag) continue;
          expect((PORTAL_SENSITIVE_PARENTS as Record<string, readonly string[]>)[other]?.includes(flag), `${row.key}: ${other} gates ${flag}`).toBe(true);
        }
      }
    }
  });

  // Every source file that reads a sensitive flag column, and the parent gate it reads it under ('standalone' = the
  // flag is its own gate). A new reader fails here until it is classified, and a classified parent must be read in
  // the same file (or, for hourBlockCoverage, by its only caller).
  const SENSITIVE_READ_SITES: Record<string, Record<string, string>> = {
    'routes/portal/network.ts': { enableNetworkAlerts: 'enableNetworkVisibility', enablePhysicalPlacement: 'enableNetworkVisibility' },
    'services/portal/hourBlockCoverage.ts': { enableHourBlock: 'enableSupportUsage' },
    // The flag values themselves, for the portal's navigation (no data behind them).
    'routes/portal/branding.ts': { enableHourBlock: 'flag-only', enablePatchDetail: 'flag-only', enableVulnerabilityDetail: 'flag-only', enablePhysicalPlacement: 'flag-only' },
  };

  it('every sensitive column read under routes/portal and services/portal is classified', () => {
    const root = join(__dirname, '..');
    const found: Record<string, string[]> = {};
    for (const dir of ['routes/portal', 'services/portal']) {
      for (const file of readdirSync(join(root, dir))) {
        if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
        const src = readFileSync(join(root, dir, file), 'utf8');
        const hits = PORTAL_SENSITIVE_FLAG_KEYS.filter((flag) => src.includes(`portalBranding.${flag}`));
        if (hits.length) found[`${dir}/${file}`] = [...hits].sort();
      }
    }
    expect(Object.fromEntries(Object.entries(SENSITIVE_READ_SITES).map(([f, m]) => [f, Object.keys(m).sort()]))).toEqual(found);
    const network = readFileSync(join(root, 'routes/portal/network.ts'), 'utf8');
    expect(network).toMatch(/settings\?\.enableNetworkVisibility !== true\)\s*\{\s*return/);
    const supportUsage = readFileSync(join(root, 'services/portal/supportUsage.ts'), 'utf8');
    expect(supportUsage).toContain('hourBlockCoverageForOrg');
    expect(PORTAL_SECTION_GATES.find((g) => g.routeFile === 'hourBlock.ts')?.flags).toEqual(['enableSupportUsage', 'enableHourBlock']);
  });
});
