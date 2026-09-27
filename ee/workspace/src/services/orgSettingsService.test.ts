import { describe, it, expect, vi } from 'vitest';
import type { WorkspaceDatabase } from '../hostTypes';
import { getOrgSettings, DEFAULT_DLP_CONFIG } from './orgSettingsService';

/** drizzle-stub pattern (mirrors credentialService.test.ts): select(...).from(...).where(...) resolves rows. */
function fakeDbReturning(rows: Record<string, unknown>[]) {
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => rows) })),
    })),
  };
  return db as unknown as WorkspaceDatabase;
}

describe('orgSettingsService', () => {
  it('defaults to disabled + default DLP config when no row exists', async () => {
    const db = fakeDbReturning([]); // helper: select(...).from(...).where(...) resolves []
    const s = await getOrgSettings(db, 'org-1');
    expect(s.contentEnabled).toBe(false);
    expect(s.dlpConfig).toEqual(DEFAULT_DLP_CONFIG);
  });

  it('collapses unknown detector actions to the safe default (default-deny)', async () => {
    const db = fakeDbReturning([{ orgId: 'org-1', contentEnabled: true,
      dlpConfig: { detectors: { credit_card: 'shout', ssn: 'redact' } } }]);
    const s = await getOrgSettings(db, 'org-1');
    expect(s.dlpConfig.detectors.credit_card).toBe('redact'); // unknown → detector's default
    expect(s.dlpConfig.detectors.ssn).toBe('redact');
  });

  it('returns an independent dlpConfig object when no row exists, not the shared module-level singleton', async () => {
    const db = fakeDbReturning([]);
    const s = await getOrgSettings(db, 'org-1');
    // Reference identity, not just deep equality: a caller mutating the
    // returned dlpConfig in place must never corrupt DEFAULT_DLP_CONFIG for
    // every other org that later hits the same no-row branch.
    expect(s.dlpConfig).not.toBe(DEFAULT_DLP_CONFIG);
    expect(s.dlpConfig.detectors).not.toBe(DEFAULT_DLP_CONFIG.detectors);
  });

  it('DEFAULT_DLP_CONFIG is frozen (including nested detectors) as a defensive backstop', () => {
    expect(Object.isFrozen(DEFAULT_DLP_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DLP_CONFIG.detectors)).toBe(true);
  });

  describe('custom pattern safety gate', () => {
    it('keeps a well-formed custom pattern', async () => {
      const db = fakeDbReturning([{ orgId: 'org-1', contentEnabled: true,
        dlpConfig: { customPatterns: [{ name: 'Employee ID', pattern: 'EMP-\\d{6}', action: 'redact' }] } }]);
      const s = await getOrgSettings(db, 'org-1');
      expect(s.dlpConfig.customPatterns).toEqual([{ name: 'Employee ID', pattern: 'EMP-\\d{6}', action: 'redact' }]);
    });

    it('drops a catastrophic-backtracking custom pattern instead of trusting "compiles" as "bounded" (default-deny)', async () => {
      // (a|aa)+c: compiles fine (new RegExp alone would have accepted it),
      // but is exponential on worst-case input — this org's content-scan
      // hot path (content/dlp.ts) runs every enabled custom pattern
      // synchronously over every ingested document.
      const db = fakeDbReturning([{ orgId: 'org-1', contentEnabled: true,
        dlpConfig: { customPatterns: [{ name: 'bad', pattern: '(a|aa)+c', action: 'redact' }] } }]);
      const s = await getOrgSettings(db, 'org-1');
      expect(s.dlpConfig.customPatterns).toEqual([]);
    });

    it('drops a custom pattern over the length cap', async () => {
      const db = fakeDbReturning([{ orgId: 'org-1', contentEnabled: true,
        dlpConfig: { customPatterns: [{ name: 'long', pattern: 'a'.repeat(201), action: 'redact' }] } }]);
      const s = await getOrgSettings(db, 'org-1');
      expect(s.dlpConfig.customPatterns).toEqual([]);
    });

    it('keeps a separated-nested-quantifier "evil regex" that the JS heuristic misses — RE2 executes it safely regardless of shape', async () => {
      // ^(([a-z])+.)+[A-Z]([a-z])+$: passes validateRegexSafety (no
      // backreference, no immediately-adjacent nested quantifier, no
      // ambiguous alternation) but is catastrophic on a backtracking
      // engine. Kept (not dropped) because content/dlp.ts now scans with
      // RE2, which has no backtracking behavior for any pattern shape.
      const db = fakeDbReturning([{ orgId: 'org-1', contentEnabled: true,
        dlpConfig: { customPatterns: [{ name: 'evil', pattern: '^(([a-z])+.)+[A-Z]([a-z])+$', action: 'redact' }] } }]);
      const s = await getOrgSettings(db, 'org-1');
      expect(s.dlpConfig.customPatterns).toEqual([
        { name: 'evil', pattern: '^(([a-z])+.)+[A-Z]([a-z])+$', action: 'redact' },
      ]);
    });

    it('drops a stored pattern RE2 cannot compile (lookaround) even though the JS heuristic alone would have accepted it', async () => {
      const db = fakeDbReturning([{ orgId: 'org-1', contentEnabled: true,
        dlpConfig: { customPatterns: [{ name: 'legacy lookaround', pattern: '(?=E)EMP-\\d+', action: 'redact' }] } }]);
      const s = await getOrgSettings(db, 'org-1');
      expect(s.dlpConfig.customPatterns).toEqual([]);
    });
  });
});

describe('orgSettingsService — DLP custom pattern safety (static re-check)', () => {
  it('drops a stored custom pattern using an unbounded backreference on every read', async () => {
    const db = fakeDbReturning([{
      orgId: 'org-1',
      contentEnabled: true,
      dlpConfig: {
        customPatterns: [
          { name: 'legacy-unsafe', pattern: '(a+)\\1', action: 'redact' },
          { name: 'ok', pattern: 'foo', action: 'redact' },
        ],
      },
    }]);
    const s = await getOrgSettings(db, 'org-1');
    expect(s.dlpConfig.customPatterns.map((p) => p.name)).toEqual(['ok']);
  });

  it('drops a stored custom pattern with a nested-quantifier shape on every read', async () => {
    const db = fakeDbReturning([{
      orgId: 'org-1',
      contentEnabled: true,
      dlpConfig: {
        customPatterns: [
          { name: 'legacy-catastrophic', pattern: '(a+)+$', action: 'redact' },
        ],
      },
    }]);
    const s = await getOrgSettings(db, 'org-1');
    expect(s.dlpConfig.customPatterns).toEqual([]);
  });

  it('drops a stored custom pattern longer than the shared length cap', async () => {
    const db = fakeDbReturning([{
      orgId: 'org-1',
      contentEnabled: true,
      dlpConfig: {
        customPatterns: [
          { name: 'too-long', pattern: 'a'.repeat(201), action: 'redact' },
        ],
      },
    }]);
    const s = await getOrgSettings(db, 'org-1');
    expect(s.dlpConfig.customPatterns).toEqual([]);
  });

  it('caps stored customPatterns at the shared max-rules limit on read', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `p${i}`, pattern: `p${i}`, action: 'redact' }));
    const db = fakeDbReturning([{ orgId: 'org-1', contentEnabled: true, dlpConfig: { customPatterns: many } }]);
    const s = await getOrgSettings(db, 'org-1');
    expect(s.dlpConfig.customPatterns.length).toBeLessThanOrEqual(50);
  });

  it('keeps a normal, safe custom pattern intact', async () => {
    const db = fakeDbReturning([{
      orgId: 'org-1',
      contentEnabled: true,
      dlpConfig: { customPatterns: [{ name: 'employee-id', pattern: 'EMP-\\d{6}', action: 'redact' }] },
    }]);
    const s = await getOrgSettings(db, 'org-1');
    expect(s.dlpConfig.customPatterns).toEqual([{ name: 'employee-id', pattern: 'EMP-\\d{6}', action: 'redact' }]);
  });
});
