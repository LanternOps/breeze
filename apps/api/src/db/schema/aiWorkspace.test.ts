import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { AI_ARTIFACT_KINDS } from '@breeze/shared';
import { aiArtifactKind, aiRunArtifacts } from './aiWorkspace';

describe('ai_run_artifacts Drizzle schema (spec §6.1)', () => {
  it('has exactly the spec columns in snake_case, plus blob_key', () => {
    expect(getTableName(aiRunArtifacts)).toBe('ai_run_artifacts');
    const names = Object.values(getTableColumns(aiRunArtifacts))
      .map((c) => c.name)
      .sort();
    expect(names).toEqual([
      'blob_key',
      'bytes',
      'content_type',
      'created_at',
      'created_by_tool',
      'expires_at',
      'head_preview',
      'id',
      'kind',
      'name',
      'org_id',
      'run_id',
      'session_id',
      'sha256',
      'source_device_id',
      'tail_preview',
    ]);
  });

  it('names the device pointer source_device_id, never device_id (must not join the device cascade lists)', () => {
    const names = Object.values(getTableColumns(aiRunArtifacts)).map((c) => c.name);
    expect(names).not.toContain('device_id');
    expect(names).toContain('source_device_id');
  });

  it('kind enum matches the shared AI_ARTIFACT_KINDS', () => {
    expect(aiArtifactKind.enumName).toBe('ai_artifact_kind');
    expect([...aiArtifactKind.enumValues]).toEqual([...AI_ARTIFACT_KINDS]);
  });

  it('run_id is nullable (chat-session captures have no run) and org_id is not', () => {
    const cols = getTableColumns(aiRunArtifacts);
    expect(cols.runId.notNull).toBe(false);
    expect(cols.orgId.notNull).toBe(true);
    expect(cols.sessionId.notNull).toBe(false);
  });
});
