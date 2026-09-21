import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { scriptVersions, scriptOriginEnum } from './scripts';

describe('scriptVersions schema', () => {
  const config = getTableConfig(scriptVersions);
  const byName = new Map(config.columns.map((c) => [c.name, c]));

  it('declares the script_origin enum values in pg order', () => {
    expect(scriptOriginEnum.enumValues).toEqual(['human', 'ai_proposal', 'imported', 'system']);
  });

  it('carries the execution-definition columns as NOT NULL', () => {
    for (const name of ['language', 'timeout_seconds', 'run_as', 'content_digest', 'origin']) {
      expect(byName.get(name), `missing column ${name}`).toBeDefined();
      expect(byName.get(name)!.notNull, `${name} must be NOT NULL`).toBe(true);
    }
  });

  it('carries the nullable provenance columns', () => {
    for (const name of ['proposal_id', 'review_id', 'reviewed_at', 'approved_by', 'approved_at', 'approval_method', 'parameters']) {
      expect(byName.get(name), `missing column ${name}`).toBeDefined();
      expect(byName.get(name)!.notNull, `${name} must be nullable`).toBe(false);
    }
  });

  it('declares the unique (script_id, version) constraint', () => {
    const uniqueNames = config.uniqueConstraints.map((u) => u.name);
    expect(uniqueNames).toContain('script_versions_script_id_version_key');
  });

  it('cascades from the parent script', () => {
    const scriptFk = config.foreignKeys.find((f) => f.reference().columns.some((c) => c.name === 'script_id'));
    expect(scriptFk).toBeDefined();
    expect(scriptFk?.onDelete).toBe('cascade');
  });
});
