import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceDatabase } from '../hostTypes';
import { SHARED_DEVICE_KEY } from './runScope';
import { createFilingService } from './filingService';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const FILE_ID = '88888888-8888-8888-8888-888888888888';

/**
 * Values reachable from a raw drizzle sql template (bound primitives between
 * StringChunks — same convention as activityService.test.ts).
 */
function boundValues(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => item && typeof item === 'object' ? boundValues(item) : [item]);
  }
  if (!value || typeof value !== 'object') return [];
  const candidate = value as { value?: unknown; queryChunks?: unknown[] };
  const own = Object.prototype.hasOwnProperty.call(candidate, 'value')
    ? (Array.isArray(candidate.value) ? candidate.value : [candidate.value])
    : [];
  return [
    ...own,
    ...(candidate.queryChunks ?? []).flatMap((item) =>
      item && typeof item === 'object' ? boundValues(item) : [item]),
  ];
}

/** Approximate SQL text of a drizzle expression (columns as bare names, params as ?). */
function sqlText(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(sqlText).join('');
  if (typeof value !== 'object') return String(value);
  const c = value as Record<string, unknown>;
  if ('encoder' in c) return '?';
  if (Array.isArray(c.queryChunks)) return (c.queryChunks as unknown[]).map(sqlText).join('');
  if (Array.isArray(c.value) && (c.value as unknown[]).every((x) => typeof x === 'string')) {
    return (c.value as string[]).join('');
  }
  if (typeof c.name === 'string') return c.name;
  return '';
}

function makeDb(executeResults: unknown[][] = []) {
  let executeIndex = 0;
  const executed: unknown[] = [];
  const db = {
    execute: vi.fn(async (query: unknown) => {
      executed.push(query);
      return executeResults[executeIndex++] ?? [];
    }),
  };
  return { db: db as unknown as WorkspaceDatabase, raw: db, executed };
}

const crosswalkService = { lookup: vi.fn(async () => []) };

describe('filingService — owner-username scoping (local-profile partition)', () => {
  describe('list', () => {
    it('excludes local-profile rows entirely (fails closed) with no deviceId/ownerUsername claimed', async () => {
      const { db, executed } = makeDb([[], []]);
      await createFilingService(db, { crosswalkService }).list(ORG_ID, []);
      const text = sqlText(executed[0]);
      expect(text).not.toContain('ilike');
      expect(text).toMatch(/local_profile.*false|false.*local_profile/is);
      // The smb branch is unaffected — still org-visible via the shared device key.
      expect(sqlText(executed[0])).toContain('smb_share');
      expect(boundValues(executed[0])).toContain(SHARED_DEVICE_KEY);
    });

    it('binds an owner-prefix match against the claimed device and username', async () => {
      const { db, executed } = makeDb([[], []]);
      await createFilingService(db, { crosswalkService }).list(ORG_ID, [], DEVICE_ID, 'dana');
      const text = sqlText(executed[0]);
      expect(text.toLowerCase()).toContain('ilike');
      const values = boundValues(executed[0]);
      expect(values).toContain(DEVICE_ID);
      expect(values).toContain('dana/%');
    });

    it('escapes LIKE wildcards in the claimed username and names the escape character', async () => {
      const { db, executed } = makeDb([[], []]);
      await createFilingService(db, { crosswalkService }).list(ORG_ID, [], DEVICE_ID, '%a_b\\');
      expect(sqlText(executed[0])).toMatch(/ILIKE \S+ ESCAPE '\\'/i);
      const values = boundValues(executed[0]);
      expect(values).toContain('\\%a\\_b\\\\/%');
      expect(values).not.toContain('%a_b\\/%');
    });

    it('excludes local-profile rows when a device is claimed but no owner username is', async () => {
      const { db, executed } = makeDb([[], []]);
      await createFilingService(db, { crosswalkService }).list(ORG_ID, [], DEVICE_ID);
      expect(sqlText(executed[0]).toLowerCase()).not.toContain('ilike');
    });
  });

  describe('get', () => {
    it('scopes the single-file lookup the same way as list', async () => {
      const { db, executed } = makeDb([[], []]);
      await createFilingService(db, { crosswalkService }).get(ORG_ID, FILE_ID, [], DEVICE_ID, 'dana');
      const text = sqlText(executed[0]);
      expect(text.toLowerCase()).toContain('ilike');
      expect(boundValues(executed[0])).toContain('dana/%');
    });
  });

  describe('classify', () => {
    it('never reaches the unfiled-email lookup for an unclaimed local-profile file', async () => {
      const { db, executed } = makeDb([[]]); // unfiledEmail() finds nothing => classify short-circuits
      const result = await createFilingService(db, { crosswalkService }).classify(ORG_ID, FILE_ID, []);
      expect(result).toBeNull();
      const text = sqlText(executed[0]);
      expect(text.toLowerCase()).not.toContain('ilike');
    });
  });

  describe('assign', () => {
    it('never reaches the unfiled-email lookup for an unclaimed local-profile file', async () => {
      const { db, executed } = makeDb([[]]);
      const result = await createFilingService(db, { crosswalkService })
        .assign(ORG_ID, FILE_ID, 'proj-1', null, []);
      expect(result).toBeNull();
      const text = sqlText(executed[0]);
      expect(text.toLowerCase()).not.toContain('ilike');
    });
  });
});
