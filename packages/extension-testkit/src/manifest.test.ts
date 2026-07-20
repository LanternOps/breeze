import { describe, expect, it } from 'vitest';
import { assertManifestConformance } from './manifest';

function validManifest(): Record<string, unknown> {
  return {
    apiVersion: 'breeze.extensions/v1',
    name: 'acme-widgets',
    version: '1.0.0',
    routeNamespace: 'acme-widgets',
    requires: { breeze: '>=1.0.0', serverSdk: '^1.0.0', capabilities: [] },
    server: { entry: 'server.js' },
    schemaCompatibilityFloor: '1.0.0',
    jobs: [],
    aiTools: [],
  };
}

describe('assertManifestConformance', () => {
  it('reports all manifest contract errors in one result', () => {
    const result = assertManifestConformance({ apiVersion: 'bad', name: 'Breeze', version: 'latest' });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['apiVersion', 'name', 'version']),
    );
  });

  it('never fails fast — surfaces more than the first issue', () => {
    const result = assertManifestConformance({ apiVersion: 'bad', name: 'Breeze', version: 'latest' });
    expect(result.issues.length).toBeGreaterThan(2);
  });

  it('attaches a non-empty machine-readable code to every issue', () => {
    // Load-bearing: this fails if diagnostics regress to string-parsing (no `code`).
    const result = assertManifestConformance({ apiVersion: 'bad', name: 'Breeze', version: 'latest' });
    for (const issue of result.issues) {
      expect(typeof issue.code).toBe('string');
      expect(issue.code.length).toBeGreaterThan(0);
    }
  });

  it('accepts a valid manifest', () => {
    expect(assertManifestConformance(validManifest())).toEqual({ ok: true, issues: [] });
  });
});
