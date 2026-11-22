import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { AI_TOOL_DISCOVERY, aiToolExecutions, aiToolSearchEvents } from './ai';

// #12421 W01 T1: static contract between the creating migration and the
// Drizzle table. The RLS behaviour itself is proven on real Postgres in
// __tests__/integration/aiToolSearchEventsRls.integration.test.ts.

const MIGRATIONS_DIR = join(__dirname, '../../../migrations');
const MIGRATION = '2027-01-28-210000-ai-tool-search-events.sql';
// Fixed predecessor (the newest committed migration when W01 was written).
// Never "after every other file": that goes red the day the next one merges.
const PREDECESSOR = '2027-01-28-200000-agent-versions-min-os.sql';

const sqlText = readFileSync(join(MIGRATIONS_DIR, MIGRATION), 'utf8');

/** SQL with `--` comments removed, so a comment can never satisfy a regex. */
function stripComments(text: string): string {
  return text.replace(/--[^\n]*/g, '');
}

const STATEMENT_DML = /^\s*(INSERT|UPDATE|DELETE|MERGE)\b/im;
const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT)\s*;/im;
const POLICY_COMMANDS = ['select', 'insert', 'update', 'delete'] as const;

/** Names of the policies the migration creates on ai_tool_search_events. */
function createdPolicies(text: string): string[] {
  const body = stripComments(text);
  return [...body.matchAll(/CREATE POLICY\s+(\w+)\s+ON\s+ai_tool_search_events\b/gi)].map((m) => m[1]!);
}

function hasFourPolicies(text: string): boolean {
  const names = createdPolicies(text).sort();
  return JSON.stringify(names) === JSON.stringify(POLICY_COMMANDS.map((c) => `breeze_org_isolation_${c}`).sort());
}

/** The text of one CREATE POLICY statement (up to the `$POLICY$` / `;` that ends it). */
function policyStatement(text: string, command: (typeof POLICY_COMMANDS)[number]): string {
  const body = stripComments(text);
  const re = new RegExp(`CREATE POLICY\\s+breeze_org_isolation_${command}\\s+ON\\s+ai_tool_search_events[\\s\\S]*?(?=\\$POLICY\\$|;)`, 'i');
  const match = re.exec(body);
  if (!match) throw new Error(`no breeze_org_isolation_${command} policy`);
  return match[0];
}

/** Column names declared in the CREATE TABLE body (constraint lines excluded). */
function createTableColumns(text: string): string[] {
  const body = stripComments(text);
  const match = /CREATE TABLE IF NOT EXISTS ai_tool_search_events \(([\s\S]*?)\n\);/i.exec(body);
  if (!match) throw new Error('no CREATE TABLE ai_tool_search_events');
  return match[1]!
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(CONSTRAINT|CHECK)\b/i.test(line) && !line.startsWith(')'))
    .map((line) => line.split(/\s+/)[0]!)
    .filter((name) => /^[a-z_]+$/.test(name));
}

function snake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

describe('ai_tool_search_events migration contract (#12421 W01)', () => {
  it('migration file name localeCompare-sorts after the fixed predecessor', () => {
    expect(readdirSync(MIGRATIONS_DIR)).toContain(PREDECESSOR);
    expect(MIGRATION.localeCompare(PREDECESSOR)).toBeGreaterThan(0);
  });

  it('migration has no statement-initial DML and no transaction control', () => {
    expect(stripComments(sqlText)).not.toMatch(STATEMENT_DML);
    expect(stripComments(sqlText)).not.toMatch(TRANSACTION_CONTROL);
  });

  it('migration enables and forces RLS and creates exactly the four breeze_org_isolation policies', () => {
    const body = stripComments(sqlText);
    expect(body).toMatch(/ALTER TABLE ai_tool_search_events ENABLE ROW LEVEL SECURITY;/);
    expect(body).toMatch(/ALTER TABLE ai_tool_search_events FORCE ROW LEVEL SECURITY;/);
    expect(hasFourPolicies(sqlText)).toBe(true);
  });

  it('every policy joins through ai_sessions with breeze_has_org_access, guarded by pg_policies', () => {
    for (const command of POLICY_COMMANDS) {
      const stmt = policyStatement(sqlText, command);
      expect(stmt).toMatch(new RegExp(`FOR ${command.toUpperCase()}\\b`));
      expect(stmt).toMatch(/EXISTS \(SELECT 1 FROM ai_sessions s WHERE s\.id = ai_tool_search_events\.session_id AND public\.breeze_has_org_access\(s\.org_id\)\)/);
      expect(stripComments(sqlText)).toMatch(new RegExp(`policyname = 'breeze_org_isolation_${command}'`));
    }
  });

  it('the insert and update WITH CHECK bind turn_message_id to a message of the same session', () => {
    const sameSession = /ai_tool_search_events\.turn_message_id IS NULL\s+OR EXISTS \(SELECT 1 FROM ai_messages m WHERE m\.id = ai_tool_search_events\.turn_message_id AND m\.session_id = ai_tool_search_events\.session_id\)/;
    for (const command of ['insert', 'update'] as const) {
      const withCheck = policyStatement(sqlText, command).split(/WITH CHECK/i)[1] ?? '';
      expect(withCheck).toMatch(sameSession);
    }
    // SELECT and DELETE are read-side: no same-session clause, no WITH CHECK.
    for (const command of ['select', 'delete'] as const) {
      expect(policyStatement(sqlText, command)).not.toMatch(/WITH CHECK/i);
    }
  });

  it('Drizzle aiToolSearchEvents columns equal the migration column list', () => {
    const drizzle = Object.values(getTableColumns(aiToolSearchEvents)).map((c) => c.name).sort();
    const keys = Object.keys(getTableColumns(aiToolSearchEvents)).map(snake).sort();
    expect(drizzle).toEqual(keys);
    expect(createTableColumns(sqlText).sort()).toEqual(drizzle);
  });

  it('the kind CHECK and the query byte bound are in the migration', () => {
    expect(stripComments(sqlText)).toMatch(/CONSTRAINT ai_tool_search_events_kind_chk\s+CHECK \(kind IN \('search', 'turn'\)\)/);
    expect(stripComments(sqlText)).toMatch(/CONSTRAINT ai_tool_search_events_query_len_chk\s+CHECK \(query IS NULL OR octet_length\(query\) <= 1024\)/);
  });

  it('AI_TOOL_DISCOVERY equals the discovery CHECK value list', () => {
    const match = /CHECK \(discovery IS NULL OR discovery IN \(([^)]*)\)\)/.exec(stripComments(sqlText));
    expect(match).not.toBeNull();
    const literals = [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(literals).toEqual([...AI_TOOL_DISCOVERY]);
    expect(stripComments(sqlText)).toMatch(/conname = 'ai_tool_executions_discovery_chk'/);
  });

  it('discovery column is nullable text in both the migration and Drizzle', () => {
    expect(stripComments(sqlText)).toMatch(/ALTER TABLE ai_tool_executions ADD COLUMN IF NOT EXISTS discovery text;/);
    const col = getTableColumns(aiToolExecutions).discovery;
    expect(col.name).toBe('discovery');
    expect(col.getSQLType()).toBe('text');
    expect(col.notNull).toBe(false);
  });

  it('tool_use_id is nullable varchar(100) in both, and the migration creates no index on ai_tool_executions', () => {
    expect(stripComments(sqlText)).toMatch(/ALTER TABLE ai_tool_executions ADD COLUMN IF NOT EXISTS tool_use_id varchar\(100\);/);
    const col = getTableColumns(aiToolExecutions).toolUseId;
    expect(col.name).toBe('tool_use_id');
    expect(col.getSQLType()).toBe('varchar(100)');
    expect(col.notNull).toBe(false);
    expect(stripComments(sqlText)).not.toMatch(/CREATE (UNIQUE )?INDEX[^;]*\bON ai_tool_executions\b/i);
  });

  it('the Drizzle table declares the three migration indexes', () => {
    const names = getTableConfig(aiToolSearchEvents).indexes.map((i) => i.config.name).sort();
    expect(names).toEqual([
      'ai_tool_search_events_created_at_idx',
      'ai_tool_search_events_result_tool_names_gin_idx',
      'ai_tool_search_events_session_id_idx',
    ]);
    for (const name of names) {
      expect(stripComments(sqlText)).toMatch(new RegExp(`CREATE INDEX IF NOT EXISTS ${name}\\b`));
    }
    expect(stripComments(sqlText)).toMatch(/ai_tool_search_events_result_tool_names_gin_idx\s+ON ai_tool_search_events USING gin \(result_tool_names\)/);
  });

  describe('negative controls (the regexes can fail)', () => {
    it('the four-policy check fails when the DELETE policy statement is removed', () => {
      const withoutDelete = sqlText.replace(/CREATE POLICY\s+breeze_org_isolation_delete[\s\S]*?\$POLICY\$/, '$POLICY$');
      expect(withoutDelete).not.toBe(sqlText);
      expect(hasFourPolicies(withoutDelete)).toBe(false);
    });

    it('the DML regex matches a copy with a leading INSERT line', () => {
      expect(`INSERT INTO ai_tool_search_events DEFAULT VALUES;\n${sqlText}`).toMatch(STATEMENT_DML);
    });

    it('the DML regex does not trip on mid-statement FOR INSERT / ON DELETE CASCADE', () => {
      expect('CREATE POLICY p ON t FOR INSERT WITH CHECK (true);\n  session_id uuid REFERENCES s(id) ON DELETE CASCADE,').not.toMatch(STATEMENT_DML);
    });
  });
});
