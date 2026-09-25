import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PAM_AUDIT_DETAIL_ALLOWLIST,
  PAM_AUDIT_EXPORT_COLUMNS,
  PAM_AUDIT_WRITER_DETAIL_KEYS,
  decodeExportCursor,
  encodeExportCursor,
  projectAuditDetails,
  serializeElevationAuditPage,
  type ExportRecord,
} from './pamAuditExport';
import { exportQuerySchema } from '../routes/pamAuditExport';

const ID = '3f1c2b7e-9a41-4d52-8f0e-2b6c1d9e7a10';

function record(over: Partial<ExportRecord> = {}): ExportRecord {
  const base = Object.fromEntries(PAM_AUDIT_EXPORT_COLUMNS.map((c) => [c, null])) as ExportRecord;
  return { ...base, id: ID, event_type: 'approved', actor: 'user', details: {}, ...over };
}

describe('export cursor (#4910)', () => {
  it('round-trips Postgres timestamptz text at full microsecond precision', () => {
    const ts = '2026-09-25 04:10:00.123456+00';
    expect(decodeExportCursor(encodeExportCursor(ts, ID))).toEqual({ recordedAt: ts, id: ID });
  });

  it('rejects anything that is not a timestamp|uuid pair', () => {
    for (const raw of ['', 'x', `now()|${ID}`, '2026-09-25 04:10:00+00|not-a-uuid', "2026-09-25 04:10:00+00|' OR 1=1 --"]) {
      expect(decodeExportCursor(Buffer.from(raw, 'utf8').toString('base64url'))).toBeNull();
    }
    expect(decodeExportCursor('%%%not-base64%%%')).toBeNull();
  });
});

describe('elevation_audit writer inventory (#4910)', () => {
  const SRC = join(__dirname, '..');
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === '__tests__' ? [] : walk(path);
      return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
    });
  }

  it('every file that inserts into elevation_audit has its details keys inventoried (a new writer fails here until reviewed)', () => {
    const writers = walk(SRC)
      .filter((path) => {
        const text = readFileSync(path, 'utf8');
        return text.includes('insert(elevationAudit)') || /INSERT\s+INTO\s+elevation_audit\b/i.test(text);
      })
      .map((path) => relative(SRC, path).split('\\').join('/'))
      .sort();
    expect(writers).toEqual(Object.keys(PAM_AUDIT_WRITER_DETAIL_KEYS).sort());
  });

  it('the export allowlist is exactly the inventoried writer keys', () => {
    expect([...PAM_AUDIT_DETAIL_ALLOWLIST].sort()).toEqual(
      [...new Set(Object.values(PAM_AUDIT_WRITER_DETAIL_KEYS).flat())].sort(),
    );
    expect(PAM_AUDIT_DETAIL_ALLOWLIST).toEqual(
      expect.arrayContaining(['assurance_level', 'factor', 'software_policy_id', 'matched_field', 'commandId', 'pamRuleId', 'actuationId', 'generation']),
    );
  });
});

describe('projectAuditDetails (#4910)', () => {
  it('keeps only allowlisted scalar keys and drops everything else', () => {
    expect(
      projectAuditDetails({
        reason: 'ok',
        duration_minutes: 30,
        pam_rule_name: 'r',
        secret_token: 'leak',
        nested: { reason: 'x' },
        tool_name: { not: 'scalar' },
      }),
    ).toEqual({ reason: 'ok', duration_minutes: 30, pam_rule_name: 'r' });
  });

  it('treats non-object details as empty', () => {
    expect(projectAuditDetails(null)).toEqual({});
    expect(projectAuditDetails(['reason'])).toEqual({});
    expect(projectAuditDetails('reason')).toEqual({});
  });
});

describe('serializeElevationAuditPage (#4910)', () => {
  it('CSV: header on the page, every cell quoted, spreadsheet formulas neutralized, details JSON-encoded', () => {
    const out = serializeElevationAuditPage(
      [record({ request_reason: '=HYPERLINK("http://x")', details: { reason: 'a,b' } })],
      'csv',
    );
    const [header, row] = out.trimEnd().split('\n');
    expect(header!.split(',')).toHaveLength(PAM_AUDIT_EXPORT_COLUMNS.length);
    expect(header!.startsWith('"id","org_id"')).toBe(true);
    expect(row).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(row).toContain('"{""reason"":""a,b""}"');
  });

  it('CSV of an empty page is just the header', () => {
    expect(serializeElevationAuditPage([], 'csv').trimEnd().split('\n')).toHaveLength(1);
  });

  it('JSONL: one object per line, strings untouched', () => {
    const out = serializeElevationAuditPage([record({ request_reason: '=1+1' }), record({ id: 'b' })], 'jsonl');
    const lines = out.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).request_reason).toBe('=1+1');
    expect(serializeElevationAuditPage([], 'jsonl')).toBe('');
  });
});

describe('exportQuerySchema (#4910)', () => {
  const ok = { from: '2026-09-01T00:00:00Z', to: '2026-09-25T00:00:00Z' };

  it('defaults to CSV and a 1000-row page', () => {
    expect(exportQuerySchema.parse(ok)).toMatchObject({ format: 'csv', limit: 1000 });
  });

  it('requires both bounds, from before to, and a window of at most 366 days', () => {
    expect(exportQuerySchema.safeParse({ from: ok.from }).success).toBe(false);
    expect(exportQuerySchema.safeParse({ from: ok.to, to: ok.from }).success).toBe(false);
    expect(exportQuerySchema.safeParse({ from: '2025-01-01T00:00:00Z', to: '2026-09-25T00:00:00Z' }).success).toBe(false);
    expect(exportQuerySchema.safeParse({ from: '2025-09-25T00:00:00Z', to: '2026-09-25T00:00:00Z' }).success).toBe(true);
  });

  it('caps the page size at 1000', () => {
    expect(exportQuerySchema.safeParse({ ...ok, limit: '1001' }).success).toBe(false);
    expect(exportQuerySchema.safeParse({ ...ok, limit: '0' }).success).toBe(false);
  });
});
