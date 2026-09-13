import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  aiWorkspaceBackend,
  aiWorkspaceRegion,
  aiWorkspaceStatus,
} from './aiWorkspace';

const MIGRATION = path.join(
  __dirname,
  '../../../migrations/2026-10-16-180300-ai-run-workspaces-compute.sql',
);

/**
 * The TS tuples and the SQL CHECK constraints are two copies of one
 * vocabulary. Nothing else compares them, so a member added to one and not the
 * other would ship as a runtime 23514 on the first row that used it.
 */
describe('ai_run_workspaces vocabulary', () => {
  const sqlText = fs.readFileSync(MIGRATION, 'utf8');

  it.each([
    ['backend', aiWorkspaceBackend],
    ['status', aiWorkspaceStatus],
    ['region', aiWorkspaceRegion],
  ])('%s CHECK lists exactly the TS members', (column, members) => {
    const match = new RegExp(
      `ai_run_workspaces_${column}_chk[\\s\\S]*?CHECK \\(${column} IN \\(([^)]*)\\)\\)`,
    ).exec(sqlText);
    expect(match, `no CHECK found for ${column}`).not.toBeNull();
    const listed = (match?.[1] ?? '')
      .split(',')
      .map((v) => v.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
      .sort();
    expect(listed).toEqual([...members].sort());
  });

  it('creates the table with RLS enabled AND forced, and four policies', () => {
    expect(sqlText).toContain('ALTER TABLE ai_run_workspaces ENABLE ROW LEVEL SECURITY;');
    expect(sqlText).toContain('ALTER TABLE ai_run_workspaces FORCE ROW LEVEL SECURITY;');
    for (const cmd of ['select', 'insert', 'update', 'delete']) {
      expect(sqlText).toContain(`CREATE POLICY breeze_org_isolation_${cmd} ON ai_run_workspaces`);
    }
    expect(sqlText).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON ai_run_workspaces TO breeze_app;');
  });

  it('makes the composite tenant FK deferrable — org merge aborts otherwise', () => {
    expect(sqlText).toMatch(
      /ai_run_workspaces_run_org_fk[\s\S]*?REFERENCES ai_agent_runs \(id, org_id\)[\s\S]*?DEFERRABLE INITIALLY IMMEDIATE/,
    );
  });

  it('gives ai_agent_runs.workspace_id NO foreign key (2-node cascade cycle)', () => {
    expect(sqlText).toContain('workspace_id uuid');
    expect(sqlText).not.toMatch(/workspace_id[^;]*REFERENCES ai_run_workspaces/);
  });
});
