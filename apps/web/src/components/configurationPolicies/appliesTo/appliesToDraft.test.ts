import { describe, expect, it } from 'vitest';
import { applyAssignmentsSchema } from '@breeze/shared';
import {
  appliesToDraftReducer,
  draftFromAssignments,
  draftIsDirty,
  draftToApplyPayload,
  effectiveRow,
  type DraftRow,
  type StoredAssignment,
} from './appliesToDraft';

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const A3 = '33333333-3333-4333-8333-333333333333';
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SITE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PARTNER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const stored = (over: Partial<StoredAssignment> & { id: string }): StoredAssignment => ({
  level: 'organization',
  targetId: ORG,
  priority: 0,
  roleFilter: null,
  osFilter: null,
  ...over,
});

const start = (...rows: StoredAssignment[]) => draftFromAssignments(rows);

/** Every payload the panel can send must pass the API's own schema. */
const expectValid = (rows: DraftRow[]) => {
  const { payload } = draftToApplyPayload(rows);
  const parsed = applyAssignmentsSchema.safeParse(payload);
  expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  return payload;
};

describe('appliesToDraft', () => {
  it('unchanged rows never enter the payload', () => {
    const rows = start(stored({ id: A1 }), stored({ id: A2, level: 'site', targetId: SITE, roleFilter: ['server'] }));
    expect(draftIsDirty(rows)).toBe(false);
    expect(expectValid(rows)).toEqual({ add: [], update: [], remove: [] });
  });

  it('edit then revert is not dirty', () => {
    let rows = start(stored({ id: A1, priority: 5, roleFilter: ['server', 'workstation'] }));
    rows = appliesToDraftReducer(rows, { type: 'edit', key: A1, patch: { priority: 7 } });
    expect(draftIsDirty(rows)).toBe(true);
    rows = appliesToDraftReducer(rows, { type: 'edit', key: A1, patch: { priority: 5 } });
    // The same set in another order is the stored set.
    rows = appliesToDraftReducer(rows, { type: 'edit', key: A1, patch: { roleFilter: ['workstation', 'server'] } });
    expect(draftIsDirty(rows)).toBe(false);
    expect(expectValid(rows).update).toEqual([]);
  });

  it('an empty filter is the stored null filter, not a change', () => {
    let rows = start(stored({ id: A1 }));
    rows = appliesToDraftReducer(rows, { type: 'edit', key: A1, patch: { osFilter: [] } });
    expect(draftIsDirty(rows)).toBe(false);
  });

  it('an update sends only the fields that changed, and null to clear a filter', () => {
    let rows = start(stored({ id: A1, priority: 2, roleFilter: ['server'], osFilter: ['linux'] }));
    rows = appliesToDraftReducer(rows, { type: 'edit', key: A1, patch: { roleFilter: [] } });
    const payload = expectValid(rows);
    expect(payload.update).toEqual([{ id: A1, roleFilter: null }]);
  });

  it('removing an added row drops it', () => {
    let rows = start();
    rows = appliesToDraftReducer(rows, { type: 'add', target: { level: 'site', targetId: SITE, name: 'HQ' } });
    expect(rows).toHaveLength(1);
    rows = appliesToDraftReducer(rows, { type: 'remove', key: rows[0]!.key });
    expect(rows).toHaveLength(0);
    expect(draftIsDirty(rows)).toBe(false);
  });

  it('removing an existing row sends its id, and only in remove even when it was edited', () => {
    let rows = start(stored({ id: A1 }), stored({ id: A2, level: 'site', targetId: SITE }));
    rows = appliesToDraftReducer(rows, { type: 'edit', key: A1, patch: { priority: 9 } });
    rows = appliesToDraftReducer(rows, { type: 'remove', key: A1 });
    const payload = expectValid(rows);
    expect(payload.remove).toEqual([A1]);
    expect(payload.update).toEqual([]);
    // Restore brings back the row as stored, with its edit still staged.
    rows = appliesToDraftReducer(rows, { type: 'restore', key: A1 });
    expect(expectValid(rows)).toEqual({ add: [], update: [{ id: A1, priority: 9 }], remove: [] });
  });

  it('an add omits a null filter, and a partner add omits targetId', () => {
    let rows = start();
    rows = appliesToDraftReducer(rows, { type: 'add', target: { level: 'site', targetId: SITE, name: 'HQ' } });
    rows = appliesToDraftReducer(rows, { type: 'setAllOrganizations', on: true });
    const payload = expectValid(rows);
    expect(payload.add).toEqual([
      { level: 'site', targetId: SITE, priority: 0 },
      { level: 'partner', priority: 0 },
    ]);
  });

  it('an added row carries its edited filters and priority', () => {
    let rows = start();
    rows = appliesToDraftReducer(rows, { type: 'add', target: { level: 'site', targetId: SITE, name: 'HQ' } });
    rows = appliesToDraftReducer(rows, { type: 'edit', key: rows[0]!.key, patch: { priority: 3, osFilter: ['windows'] } });
    expect(expectValid(rows).add).toEqual([{ level: 'site', targetId: SITE, priority: 3, osFilter: ['windows'] }]);
    expect(effectiveRow(rows[0]!).osFilter).toEqual(['windows']);
  });

  it('adding a target that is already listed does nothing; adding a removed one restores it', () => {
    let rows = start(stored({ id: A1, level: 'site', targetId: SITE }));
    rows = appliesToDraftReducer(rows, { type: 'add', target: { level: 'site', targetId: SITE, name: 'HQ' } });
    expect(rows).toHaveLength(1);
    rows = appliesToDraftReducer(rows, { type: 'remove', key: A1 });
    rows = appliesToDraftReducer(rows, { type: 'add', target: { level: 'site', targetId: SITE, name: 'HQ' } });
    expect(rows).toHaveLength(1);
    expect(draftIsDirty(rows)).toBe(false);
  });

  it('All organizations replaces organization rows and leaves narrower rows alone', () => {
    let rows = start(stored({ id: A1, targetId: ORG }), stored({ id: A2, targetId: ORG2 }), stored({ id: A3, level: 'site', targetId: SITE }));
    rows = appliesToDraftReducer(rows, { type: 'add', target: { level: 'organization', targetId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'New' } });
    rows = appliesToDraftReducer(rows, { type: 'setAllOrganizations', on: true });
    const payload = expectValid(rows);
    expect(payload.remove).toEqual([A1, A2]);
    expect(payload.add).toEqual([{ level: 'partner', priority: 0 }]);
    // Specific targets again restores what All organizations removed.
    rows = appliesToDraftReducer(rows, { type: 'setAllOrganizations', on: false });
    expect(draftIsDirty(rows)).toBe(false);
  });

  it('Specific targets removes a stored partner row', () => {
    let rows = start(stored({ id: A1, level: 'partner', targetId: PARTNER }));
    rows = appliesToDraftReducer(rows, { type: 'setAllOrganizations', on: false });
    expect(expectValid(rows).remove).toEqual([A1]);
    rows = appliesToDraftReducer(rows, { type: 'setAllOrganizations', on: true });
    expect(draftIsDirty(rows)).toBe(false);
  });

  it('maps each request entry back to its row, in request order', () => {
    let rows = start(stored({ id: A1 }), stored({ id: A2, level: 'site', targetId: SITE }));
    rows = appliesToDraftReducer(rows, { type: 'edit', key: A2, patch: { priority: 4 } });
    rows = appliesToDraftReducer(rows, { type: 'remove', key: A1 });
    rows = appliesToDraftReducer(rows, { type: 'add', target: { level: 'device', targetId: A3, name: 'PC-1' } });
    const { keys } = draftToApplyPayload(rows);
    expect(keys.remove).toEqual([A1]);
    expect(keys.update).toEqual([A2]);
    expect(keys.add).toEqual([rows.find((r) => r.kind === 'added')!.key]);
  });
});
