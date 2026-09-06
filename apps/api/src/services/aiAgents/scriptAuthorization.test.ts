import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
  isNull: (a: unknown) => ({ isNull: a }),
}));
vi.mock('../../db/schema', () => ({
  organizations: { id: 'organizations.id', partnerId: 'organizations.partner_id' },
  scripts: {
    id: 'scripts.id',
    orgId: 'scripts.org_id',
    partnerId: 'scripts.partner_id',
    isSystem: 'scripts.is_system',
    deletedAt: 'scripts.deleted_at',
  },
}));
vi.mock('../../db', () => ({ db: { select: vi.fn() } }));
vi.mock('./effectivePolicy', () => ({ loadPartnerBaselineCeiling: vi.fn() }));

import { db } from '../../db';
import { loadPartnerBaselineCeiling } from './effectivePolicy';
import { InvalidScriptIdsError, assertScriptIdsAuthorizable } from './scriptAuthorization';

const ORG = 'org-1';
const PARTNER = 'partner-1';
const S_ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const S_PARTNER = 'aaaaaaaa-0000-4000-8000-000000000002';
const S_SYSTEM = 'aaaaaaaa-0000-4000-8000-000000000003';
const S_OTHER_ORG = 'aaaaaaaa-0000-4000-8000-000000000004';
const S_MISSING = 'aaaaaaaa-0000-4000-8000-000000000005';

const LIBRARY = [
  { id: S_ORG, orgId: ORG, partnerId: null, isSystem: false },
  { id: S_PARTNER, orgId: null, partnerId: PARTNER, isSystem: false },
  { id: S_SYSTEM, orgId: null, partnerId: null, isSystem: true },
  { id: S_OTHER_ORG, orgId: 'org-2', partnerId: null, isSystem: false },
];

/** Queue selects in issue order: each call resolves to the next row set,
 *  whether the chain ends at `.where()` or `.limit()`. */
function queueSelects(...results: unknown[][]) {
  for (const rows of results) {
    vi.mocked(db.select).mockImplementationOnce(() => {
      const chain = {
        from: () => chain,
        where: () => Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) }),
      };
      return chain as never;
    });
  }
}

const libraryRows = (ids: string[]) => LIBRARY.filter((row) => ids.includes(row.id));

async function rejectedOf(run: () => Promise<void>) {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(InvalidScriptIdsError);
    return (err as InvalidScriptIdsError).rejected;
  }
  throw new Error('expected InvalidScriptIdsError');
}

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  vi.mocked(loadPartnerBaselineCeiling).mockReset();
});

describe('assertScriptIdsAuthorizable', () => {
  it('is a no-op when the write does not touch scriptIds or only removes ids — no query, no error', async () => {
    await assertScriptIdsAuthorizable({ orgId: null, partnerId: PARTNER }, 'triage', { existing: [S_PARTNER], next: undefined, toolAllowlist: [] });
    await assertScriptIdsAuthorizable({ orgId: null, partnerId: PARTNER }, 'triage', { existing: [S_PARTNER, S_SYSTEM], next: [S_SYSTEM], toolAllowlist: [] });
    // A stored id that no longer resolves stays tolerated as long as the write does not ADD it.
    await assertScriptIdsAuthorizable({ orgId: ORG, partnerId: null }, 'triage', { existing: [S_MISSING], next: [S_MISSING], toolAllowlist: [] });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('refuses every added id when the row itself does not allow run_script — never auto-adds the tool', async () => {
    const rejected = await rejectedOf(() =>
      assertScriptIdsAuthorizable({ orgId: null, partnerId: PARTNER }, 'triage', { existing: [], next: [S_PARTNER, S_SYSTEM], toolAllowlist: ['manage_services:restart'] }));
    expect(rejected).toEqual([
      { id: S_PARTNER, reason: 'run_script_not_allowed' },
      { id: S_SYSTEM, reason: 'run_script_not_allowed' },
    ]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('partner row: accepts partner-wide and system scripts, rejects an org-private, foreign or missing id as not_found', async () => {
    queueSelects(libraryRows([S_PARTNER, S_SYSTEM, S_ORG, S_OTHER_ORG]));
    const rejected = await rejectedOf(() =>
      assertScriptIdsAuthorizable(
        { orgId: null, partnerId: PARTNER },
        'triage',
        { existing: [], next: [S_PARTNER, S_SYSTEM, S_ORG, S_OTHER_ORG, S_MISSING], toolAllowlist: ['run_script'] },
      ));
    expect(rejected).toEqual([
      { id: S_ORG, reason: 'not_found' },
      { id: S_OTHER_ORG, reason: 'not_found' },
      { id: S_MISSING, reason: 'not_found' },
    ]);
    expect(loadPartnerBaselineCeiling).not.toHaveBeenCalled();
  });

  it('org row: accepts its own, same-partner partner-wide and system scripts inside the ceiling; rejects outside-ceiling ids and another org\'s script', async () => {
    queueSelects([{ partnerId: PARTNER }], libraryRows([S_ORG, S_PARTNER, S_SYSTEM, S_OTHER_ORG]));
    vi.mocked(loadPartnerBaselineCeiling).mockResolvedValueOnce({
      toolAllowlist: ['run_script'],
      supervisedActionKeys: [],
      scriptIds: [S_ORG, S_PARTNER],
    });
    const rejected = await rejectedOf(() =>
      assertScriptIdsAuthorizable(
        { orgId: ORG, partnerId: null },
        'triage',
        { existing: [], next: [S_ORG, S_PARTNER, S_SYSTEM, S_OTHER_ORG], toolAllowlist: ['run_script'] },
      ));
    expect(rejected).toEqual([
      { id: S_SYSTEM, reason: 'not_in_partner_baseline' },
      { id: S_OTHER_ORG, reason: 'not_found' },
    ]);
    expect(loadPartnerBaselineCeiling).toHaveBeenCalledWith(PARTNER, 'triage');
  });

  it('org row: passes when every added id is visible and inside the ceiling', async () => {
    queueSelects([{ partnerId: PARTNER }], libraryRows([S_ORG, S_PARTNER]));
    vi.mocked(loadPartnerBaselineCeiling).mockResolvedValueOnce({
      toolAllowlist: ['run_script'],
      supervisedActionKeys: [],
      scriptIds: [S_ORG, S_PARTNER, S_SYSTEM],
    });
    await expect(
      assertScriptIdsAuthorizable({ orgId: ORG, partnerId: null }, 'triage', { existing: [S_ORG], next: [S_ORG, S_PARTNER], toolAllowlist: ['run_script'] }),
    ).resolves.toBeUndefined();
  });

  it('org row: with no live baseline, visibility alone decides (the row is inert until a baseline appears)', async () => {
    queueSelects([{ partnerId: PARTNER }], libraryRows([S_ORG]));
    vi.mocked(loadPartnerBaselineCeiling).mockResolvedValueOnce(null);
    await expect(
      assertScriptIdsAuthorizable({ orgId: ORG, partnerId: null }, 'triage', { existing: [], next: [S_ORG], toolAllowlist: ['run_script'] }),
    ).resolves.toBeUndefined();
  });

  it('org row: rejects as run_script_not_allowed when the partner ceiling\'s allowlist does not admit run_script', async () => {
    queueSelects([{ partnerId: PARTNER }], libraryRows([S_ORG]));
    vi.mocked(loadPartnerBaselineCeiling).mockResolvedValueOnce({
      toolAllowlist: ['manage_services:restart'],
      supervisedActionKeys: [],
      scriptIds: [S_ORG],
    });
    const rejected = await rejectedOf(() =>
      assertScriptIdsAuthorizable({ orgId: ORG, partnerId: null }, 'triage', { existing: [], next: [S_ORG], toolAllowlist: ['run_script'] }));
    expect(rejected).toEqual([{ id: S_ORG, reason: 'run_script_not_allowed' }]);
  });

  it('dedupes the added ids and validates only the additions on a patch', async () => {
    queueSelects(libraryRows([S_SYSTEM]));
    await expect(
      assertScriptIdsAuthorizable(
        { orgId: null, partnerId: PARTNER },
        'patch',
        { existing: [S_PARTNER], next: [S_PARTNER, S_SYSTEM, S_SYSTEM], toolAllowlist: ['run_script'] },
      ),
    ).resolves.toBeUndefined();
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
