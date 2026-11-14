import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const spies = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn() }));
vi.mock('../db', () => ({ db: spies, withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('./scriptBuilderPrompt', () => ({ buildScriptBuilderSystemPrompt: () => 'prompt' }));
vi.mock('./effectiveSettings', () => ({ getEffectiveAiBudget: vi.fn() }));

import { aiSessions } from '../db/schema';
import {
  closeScriptBuilderSession,
  getScriptBuilderSession,
  updateEditorContext,
} from './scriptBuilderService';

const OWNER = 'user-owner';
const PEER = 'user-peer';
const ORG = 'org-1';
const row = { id: 'session-1', userId: OWNER, orgId: ORG, type: 'script_builder' };

function authFor(userId: string) {
  return {
    user: { id: userId },
    orgId: ORG,
    orgCondition: (column: typeof aiSessions.orgId) => eq(column, ORG),
  } as any;
}

const dialect = new PgDialect();
type Query = ReturnType<PgDialect['sqlToQuery']>;
let selected: Query | undefined;
let updated: Query | undefined;

/**
 * A minimal stand-in for Postgres: the stored row matches only when every
 * `"ai_sessions"."<column>" = $n` equality in the WHERE clause agrees with it.
 * Columns the clause does not mention are unconstrained, as in a real query.
 */
function rowMatches(query: Query): boolean {
  const columns: Record<string, string> = { id: row.id, user_id: row.userId, org_id: row.orgId, type: row.type };
  for (const [, column, index] of query.sql.matchAll(/"ai_sessions"\."(\w+)" = \$(\d+)/g)) {
    if (!(column! in columns)) continue;
    if (query.params[Number(index) - 1] !== columns[column!]) return false;
  }
  return true;
}

beforeEach(() => {
  vi.clearAllMocks();
  selected = undefined;
  updated = undefined;
  spies.select.mockReturnValue({
    from: () => ({
      where: (where: any) => {
        selected = dialect.sqlToQuery(where);
        const query = selected;
        return { limit: async () => (rowMatches(query) ? [row] : []) };
      },
    }),
  });
  spies.update.mockReturnValue({
    set: () => ({
      where: async (where: any) => {
        updated = dialect.sqlToQuery(where);
      },
    }),
  });
});

describe('script builder sessions are private to their creator', () => {
  it('resolves a session for the user who created it', async () => {
    expect(await getScriptBuilderSession(row.id, authFor(OWNER))).toEqual(row);
    expect(selected?.sql).toContain('"ai_sessions"."user_id" = ');
    expect(selected?.params).toContain(OWNER);
  });

  it('does not resolve a session for another user in the same organization', async () => {
    expect(await getScriptBuilderSession(row.id, authFor(PEER))).toBeNull();
    expect(selected?.params).toContain(PEER);
  });

  it('does not let another user in the same organization close the session', async () => {
    await expect(closeScriptBuilderSession(row.id, authFor(PEER))).rejects.toThrow('Session not found');
    expect(spies.update).not.toHaveBeenCalled();
  });

  it('closes only the creator\'s row, bound to its owner and organization', async () => {
    await closeScriptBuilderSession(row.id, authFor(OWNER));
    expect(spies.update).toHaveBeenCalledTimes(1);
    expect(updated?.sql).toContain('"ai_sessions"."user_id" = ');
    expect(updated?.sql).toContain('"ai_sessions"."org_id" = ');
    expect(updated?.params).toEqual(expect.arrayContaining([row.id, OWNER, ORG]));
  });

  it('binds editor-context updates to the creator and the script builder session type', async () => {
    await updateEditorContext(row.id, {} as any, authFor(OWNER));
    expect(updated?.sql).toContain('"ai_sessions"."user_id" = ');
    expect(updated?.sql).toContain('"ai_sessions"."type" = ');
    expect(updated?.params).toEqual(expect.arrayContaining([row.id, OWNER, 'script_builder', ORG]));
  });
});
