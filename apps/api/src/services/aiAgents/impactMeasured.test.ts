/**
 * AI Scorecard W04 (#5761, refs #4182) — authorization and orchestration of the
 * measured band. The cohort SQL is exercised against a real database in
 * `src/__tests__/integration/impactMeasured*.integration.test.ts`; these tests
 * pin the parts that must hold regardless of what is in the database.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PERMISSIONS } from '../permissions';

const loadAlertResolutionSignal = vi.fn();
const loadTicketFirstResponseSignal = vi.fn();
const loadTechnicianMinutes = vi.fn();

vi.mock('./impactMeasuredSignals', () => ({
  loadAlertResolutionSignal: (...args: unknown[]) => loadAlertResolutionSignal(...args),
  loadTicketFirstResponseSignal: (...args: unknown[]) => loadTicketFirstResponseSignal(...args),
  loadTechnicianMinutes: (...args: unknown[]) => loadTechnicianMinutes(...args),
}));

const { loadMeasuredImpact } = await import('./impactMeasured');
const { lastCompleteUtcDay } = await import('./impactRollup');

const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000ff';

type PermissionEntry = { resource: string; action: string };

function authFor(options: {
  scope?: 'system' | 'partner' | 'organization';
  orgIds?: string[] | null;
  allowedSiteIds?: string[];
  permissions?: PermissionEntry[];
} = {}) {
  const accessibleOrgIds = options.orgIds === undefined ? [ORG] : options.orgIds;
  return {
    scope: options.scope ?? 'partner',
    accessibleOrgIds,
    allowedSiteIds: options.allowedSiteIds,
    orgCondition: () => undefined,
    canAccessOrg: (orgId: string) => accessibleOrgIds === null || accessibleOrgIds.includes(orgId),
    user: { id: 'user-1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    partnerId: 'partner-1',
    orgId: null,
    token: null,
  } as never;
}

const permissionsFor = (entries: PermissionEntry[]) => ({ permissions: entries }) as never;
const NO_PERMISSIONS = permissionsFor([]);
const TIME_ENTRY_PERMISSIONS = permissionsFor([PERMISSIONS.TIME_ENTRIES_READ]);

const EMPTY_SIGNAL = { cohorts: [], omitted: 'insufficient_data', exposureAgeMinutes: 15, horizonHours: 24 };

beforeEach(() => {
  vi.clearAllMocks();
  loadAlertResolutionSignal.mockResolvedValue({ ...EMPTY_SIGNAL });
  loadTicketFirstResponseSignal.mockResolvedValue({ ...EMPTY_SIGNAL, horizonHours: 4 });
  loadTechnicianMinutes.mockResolvedValue({
    cohorts: [],
    loggingCoverage: { aiTouched: 0.4, untouched: 0.35 },
  });
});

describe('loadMeasuredImpact — authorization', () => {
  it('omits ONLY the technician-minutes arm for a caller without the time-entry permission', async () => {
    const dto = await loadMeasuredImpact(authFor(), NO_PERMISSIONS, { window: 30 });

    expect(dto.technicianMinutes).toEqual({ omitted: 'insufficient_authority' });
    expect(dto.alertResolution.omitted).not.toBe('insufficient_authority');
    expect(dto.ticketFirstResponse.omitted).not.toBe('insufficient_authority');
    // The arm is not merely hidden — it is never read.
    expect(loadTechnicianMinutes).not.toHaveBeenCalled();
  });

  it('omits the technician-minutes arm for an ORG-scope caller even with the permission', async () => {
    // time_entries is partner-axis and its own route requires partner/system
    // scope; an org-scope DB context cannot read it at all.
    const dto = await loadMeasuredImpact(
      authFor({ scope: 'organization' }),
      TIME_ENTRY_PERMISSIONS,
      { window: 30 },
    );

    expect(dto.technicianMinutes).toEqual({ omitted: 'insufficient_authority' });
  });

  it('reads the technician-minutes arm for a partner-scope caller holding the permission', async () => {
    loadTechnicianMinutes.mockResolvedValue({
      cohorts: [{
        key: 'high|billing',
        label: 'high · billing',
        aiTouched: { n: 30, medianRecordedMinutes: 25 },
        untouched: { n: 40, medianRecordedMinutes: 35 },
      }],
      loggingCoverage: { aiTouched: 0.4, untouched: 0.35 },
    });

    const dto = await loadMeasuredImpact(authFor(), TIME_ENTRY_PERMISSIONS, { window: 30 });

    expect(loadTechnicianMinutes).toHaveBeenCalledTimes(1);
    expect(dto.technicianMinutes).toMatchObject({
      omitted: null,
      loggingCoverage: { aiTouched: expect.any(Number), untouched: expect.any(Number) },
    });
  });

  it('reports insufficient_data rather than an empty-but-not-omitted state when no cohort clears the display gate (#5879)', async () => {
    // Default mock (see beforeEach): cohorts: [] with a real loggingCoverage --
    // the shape that used to render `omitted: null` over zero rows.
    const dto = await loadMeasuredImpact(authFor(), TIME_ENTRY_PERMISSIONS, { window: 30 });

    expect(dto.technicianMinutes).toEqual({ omitted: 'insufficient_data' });
  });

  it('omits the WHOLE band for a site-restricted caller', async () => {
    const dto = await loadMeasuredImpact(
      authFor({ allowedSiteIds: ['site-1'] }),
      TIME_ENTRY_PERMISSIONS,
      { window: 30 },
    );

    expect(dto.alertResolution.omitted).toBe('site_restricted');
    expect(dto.ticketFirstResponse.omitted).toBe('site_restricted');
    expect(dto.technicianMinutes).toEqual({ omitted: 'site_restricted' });
    expect(loadAlertResolutionSignal).not.toHaveBeenCalled();
    expect(loadTicketFirstResponseSignal).not.toHaveBeenCalled();
    expect(loadTechnicianMinutes).not.toHaveBeenCalled();
  });

  it('never reads time entries through a system context', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'impactMeasured.ts'),
      'utf8',
    );
    // A system-context read here would bypass the time-entry policy outright
    // (#2417 shipped a cross-tenant hole through exactly this path) and would
    // double-hold a pooled connection under the request's own transaction.
    // Strip comments first: this file's own docstring names both symbols as the
    // things it must never do, and a guard a comment can satisfy is no guard.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/withSystemDbAccessContext/);
    expect(code).not.toMatch(/runOutsideDbContext/);
  });

  it('rejects an orgId the caller cannot reach', async () => {
    await expect(
      loadMeasuredImpact(authFor(), TIME_ENTRY_PERMISSIONS, { window: 30, orgId: OTHER_ORG }),
    ).rejects.toThrow();
  });

  it('refuses a system-scope query that names no org', async () => {
    await expect(
      loadMeasuredImpact(authFor({ scope: 'system', orgIds: null }), TIME_ENTRY_PERMISSIONS, { window: 30 }),
    ).rejects.toThrow();
  });
});

describe('loadMeasuredImpact — window', () => {
  it('caps the window at 90 days', async () => {
    await expect(
      loadMeasuredImpact(authFor(), TIME_ENTRY_PERMISSIONS, { window: 180 as never }),
    ).rejects.toThrow();
  });

  it('through is the last COMPLETE UTC day, never client-supplied', async () => {
    const dto = await loadMeasuredImpact(authFor(), TIME_ENTRY_PERMISSIONS, { window: 7 });

    expect(dto.through).toBe(lastCompleteUtcDay());
    expect(dto.schemaVersion).toBe(1);
    expect(dto.window).toBe(7);
  });

  it('spans exactly `window` UTC days inclusive', async () => {
    const dto = await loadMeasuredImpact(authFor(), TIME_ENTRY_PERMISSIONS, { window: 30 });
    const days = (Date.parse(`${dto.through}T00:00:00Z`) - Date.parse(`${dto.from}T00:00:00Z`)) / 86_400_000;

    expect(days).toBe(29);
  });

  it('narrows to the single requested org when one is named', async () => {
    await loadMeasuredImpact(authFor(), TIME_ENTRY_PERMISSIONS, { window: 30, orgId: ORG });

    expect(loadAlertResolutionSignal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgIds: [ORG] }),
    );
  });

  it('passes the requested window length through to the signal loaders (#5879)', async () => {
    await loadMeasuredImpact(authFor(), TIME_ENTRY_PERMISSIONS, { window: 90 });

    expect(loadAlertResolutionSignal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ windowDays: 90 }),
    );
    expect(loadTicketFirstResponseSignal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ windowDays: 90 }),
    );
  });
});
