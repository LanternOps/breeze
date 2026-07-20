import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GENERIC_TOOL_ERROR_MESSAGE,
  looksLikeInternalErrorDetail,
  sanitizeThrownToolError,
  scrubErrorFieldsDeep,
  scrubErrorText,
  toolErrorResult,
} from './aiToolErrors';

/**
 * The exact payload reported in #2603 — a Drizzle/postgres.js "Failed query"
 * error carrying the full column list, streamed into the chat as a tool result.
 */
const RAW_DRIZZLE_ERROR =
  'Failed query: select "org_id", "baseline_id", "name", "benchmark_version", "level", ' +
  '"is_active", "os_type", "device_id", "hostname", "status", "os_type", "checked_at", ' +
  '"score" from (select "cis_baseline_results"."id" ... ) "ranked_cis_tool_results" where "rn" = $1';

describe('aiToolErrors', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('looksLikeInternalErrorDetail', () => {
    it.each([
      ['drizzle failed query', RAW_DRIZZLE_ERROR],
      ['ambiguous column', 'column reference "os_type" is ambiguous'],
      ['missing relation', 'relation "cis_baselines" does not exist'],
      ['unique violation', 'duplicate key value violates unique constraint "devices_pkey"'],
      ['fk violation', 'insert or update violates foreign key constraint "fk_org"'],
      ['rls violation', 'new row violates row-level security policy for table "devices"'],
      ['sqlstate', 'error 23503 raised during insert'],
      ['network', 'connect ECONNREFUSED 10.1.2.3:5432'],
      ['dns', 'getaddrinfo ENOTFOUND db.internal.example'],
      ['stack trace', 'Boom\n    at Object.handler (/app/dist/index.js:12:3)'],
      ['module path', 'Cannot find module /home/app/node_modules/pg/lib/index.js'],
    ])('flags %s', (_label, text) => {
      expect(looksLikeInternalErrorDetail(text)).toBe(true);
    });

    it('flags any over-long message regardless of pattern', () => {
      expect(looksLikeInternalErrorDetail('x'.repeat(400))).toBe(true);
    });

    it('does not flag short author-written messages', () => {
      for (const safe of [
        'Device not found or access denied',
        'No CIS compliance data available yet',
        'checkIds must include at least one check id',
        'Access denied to this organization',
      ]) {
        expect(looksLikeInternalErrorDetail(safe)).toBe(false);
      }
    });
  });

  describe('scrubErrorText', () => {
    it('replaces a raw driver error with the generic message', () => {
      const scrubbed = scrubErrorText(RAW_DRIZZLE_ERROR);
      expect(scrubbed).toBe(GENERIC_TOOL_ERROR_MESSAGE);
      // The regression that matters: no SQL or column names survive.
      expect(scrubbed).not.toContain('select');
      expect(scrubbed).not.toContain('benchmark_version');
      expect(scrubbed).not.toContain('org_id');
    });

    it('preserves author-written tool errors so the model keeps useful signal', () => {
      expect(scrubErrorText('Device not found or access denied')).toBe(
        'Device not found or access denied',
      );
    });

    it('passes through empty/non-string input unchanged', () => {
      expect(scrubErrorText('')).toBe('');
    });
  });

  describe('scrubErrorFieldsDeep', () => {
    it('scrubs error-ish keys at any depth without touching data fields', () => {
      const payload = {
        count: 2,
        hostname: 'select-server-01',
        results: [
          { deviceId: 'd1', error: RAW_DRIZZLE_ERROR },
          { deviceId: 'd2', queueError: 'relation "jobs" does not exist' },
        ],
        nested: { deep: { scheduleWarning: RAW_DRIZZLE_ERROR } },
        warning: 'Partial results returned',
      };

      const out = scrubErrorFieldsDeep(payload) as typeof payload;

      expect(out.count).toBe(2);
      // A data field that merely contains the word "select" must survive.
      expect(out.hostname).toBe('select-server-01');
      expect(out.results[0]!.error).toBe(GENERIC_TOOL_ERROR_MESSAGE);
      expect(out.results[1]!.queueError).toBe(GENERIC_TOOL_ERROR_MESSAGE);
      expect(out.nested.deep.scheduleWarning).toBe(GENERIC_TOOL_ERROR_MESSAGE);
      // Short author-written warning is preserved.
      expect(out.warning).toBe('Partial results returned');

      expect(JSON.stringify(out)).not.toContain('benchmark_version');
    });

    it('handles null, primitives and arrays safely', () => {
      expect(scrubErrorFieldsDeep(null)).toBeNull();
      expect(scrubErrorFieldsDeep(42)).toBe(42);
      expect(scrubErrorFieldsDeep(['a', { error: RAW_DRIZZLE_ERROR }])).toEqual([
        'a',
        { error: GENERIC_TOOL_ERROR_MESSAGE },
      ]);
    });
  });

  describe('sanitizeThrownToolError', () => {
    it('genericizes a thrown driver error and logs the full detail server-side', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const out = sanitizeThrownToolError('get_cis_compliance', new Error(RAW_DRIZZLE_ERROR));

      expect(out).toBe(GENERIC_TOOL_ERROR_MESSAGE);
      expect(out).not.toContain('os_type');

      // Full error still reaches the logs — that is where it belongs.
      const logged = spy.mock.calls.flat().join(' ');
      expect(logged).toContain('get_cis_compliance');
      expect(logged).toContain('Failed query');
    });

    it('fails closed for an unrecognized error rather than passing it through', () => {
      expect(sanitizeThrownToolError('t', new Error('something oddly specific'))).toBe(
        GENERIC_TOOL_ERROR_MESSAGE,
      );
    });

    it('preserves allowlisted timeout messages, which are app-constructed', () => {
      const msg = 'Tool execution timed out after 30000ms: get_cis_compliance';
      expect(sanitizeThrownToolError('get_cis_compliance', new Error(msg))).toBe(msg);
    });

    it('handles non-Error throws', () => {
      expect(sanitizeThrownToolError('t', 'a bare string')).toBe(GENERIC_TOOL_ERROR_MESSAGE);
      expect(sanitizeThrownToolError('t', undefined)).toBe(GENERIC_TOOL_ERROR_MESSAGE);
    });
  });

  describe('toolErrorResult', () => {
    it('produces the {"error": ...} shape with a sanitized message', () => {
      const raw = toolErrorResult('get_cis_compliance', new Error(RAW_DRIZZLE_ERROR));
      expect(JSON.parse(raw)).toEqual({ error: GENERIC_TOOL_ERROR_MESSAGE });
      expect(raw).not.toContain('benchmark_version');
    });
  });
});
