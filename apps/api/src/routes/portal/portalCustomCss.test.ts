import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { PORTAL_CUSTOM_CSS_MAX_LENGTH, portalCustomCssSchema } from '@breeze/shared';

// Single-read DB mock (same convention as featureFlags.test.ts). The system
// context wrappers record that they ran, so the test can prove the partner
// read happens outside the portal user's tenant context.
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: [] as unknown[],
    where: undefined as unknown,
    error: undefined as Error | undefined,
    systemContextCalls: 0,
    outsideContextCalls: 0,
  },
}));
const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: captureMock }));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'limit']) chain[m] = vi.fn(() => chain);
  chain.where = vi.fn((predicate: unknown) => {
    dbState.where = predicate;
    return chain;
  });
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    (dbState.error ? Promise.reject(dbState.error) : Promise.resolve(dbState.rows)).then(resolve, reject);
  return {
    db: chain,
    runOutsideDbContext: <T>(fn: () => T): T => {
      dbState.outsideContextCalls += 1;
      return fn();
    },
    withSystemDbAccessContext: <T>(fn: () => Promise<T>): Promise<T> => {
      dbState.systemContextCalls += 1;
      return fn();
    },
  };
});

import { combinePortalCustomCss, loadPartnerPortalCustomCss, partnerPortalCustomCss } from './portalCustomCss';

const ORG_ID = '22222222-2222-2222-2222-222222222222';

describe('partnerPortalCustomCss', () => {
  it('returns the trimmed CSS saved under settings.branding.customCss', () => {
    expect(partnerPortalCustomCss({ branding: { customCss: '  .a { color: red; }\n' } })).toBe('.a { color: red; }');
  });

  it.each([
    ['null settings', null],
    ['no branding block', {}],
    ['branding without customCss', { branding: { primaryColor: '#000' } }],
    ['a non-string customCss', { branding: { customCss: 42 } }],
    ['a whitespace-only customCss', { branding: { customCss: '  \n ' } }],
    ['a non-object branding', { branding: 'x' }],
  ])('returns null for %s', (_label, settings) => {
    expect(partnerPortalCustomCss(settings)).toBeNull();
  });

  // Rows saved before the partner write path validated Custom CSS (#9674)
  // can hold anything, so the read side re-applies the org rules and drops a
  // value that fails them rather than serving it to every child org.
  it.each([
    ['@import', '@import "https://evil.example/x.css";'],
    ['a non-https url()', '.a { background: url(http://evil.example/x.png); }'],
    ['an escaped expression()', '.a { width: exp\\72 ession(x); }'],
  ])('drops stored CSS containing %s', (_label, css) => {
    expect(partnerPortalCustomCss({ branding: { customCss: css } })).toBeNull();
  });

  it('drops stored CSS over the portal size cap', () => {
    const css = `/*${'a'.repeat(PORTAL_CUSTOM_CSS_MAX_LENGTH)}*/`;
    expect(partnerPortalCustomCss({ branding: { customCss: css } })).toBeNull();
  });

  it('keeps CSS exactly at the size cap', () => {
    const css = `/*${'a'.repeat(PORTAL_CUSTOM_CSS_MAX_LENGTH - 4)}*/`;
    expect(partnerPortalCustomCss({ branding: { customCss: css } })).toBe(css);
  });

  // The cap is counted the way the write schema counts it, so CSS a save
  // accepted is never silently dropped on read.
  it('agrees with the write schema on CSS with astral characters', () => {
    const css = `.a::after { content: "${'\u{1F600}'.repeat(40_000)}"; }`;
    expect(portalCustomCssSchema.safeParse(css).success).toBe(true);
    expect(partnerPortalCustomCss({ branding: { customCss: css } })).toBe(css);
  });
});

describe('combinePortalCustomCss', () => {
  it('puts the partner CSS first so the org CSS that follows can override it', () => {
    expect(combinePortalCustomCss('.a { color: red; }', '.a { color: blue; }')).toBe(
      '.a { color: red; }\n\n.a { color: blue; }',
    );
  });

  it('returns whichever side is set when the other is empty', () => {
    expect(combinePortalCustomCss('.p {}', null)).toBe('.p {}');
    expect(combinePortalCustomCss(null, '.o {}')).toBe('.o {}');
    expect(combinePortalCustomCss(null, '   ')).toBeNull();
  });

  it('returns null when neither level has CSS', () => {
    expect(combinePortalCustomCss(null, null)).toBeNull();
    expect(combinePortalCustomCss(null, undefined)).toBeNull();
  });
});

describe('loadPartnerPortalCustomCss', () => {
  beforeEach(() => {
    dbState.rows = [];
    dbState.where = undefined;
    dbState.error = undefined;
    dbState.systemContextCalls = 0;
    dbState.outsideContextCalls = 0;
    captureMock.mockClear();
  });

  it("reads the org's partner settings in system scope, keyed only by the org id", async () => {
    dbState.rows = [{ partnerId: 'p-ok', settings: { branding: { customCss: '.p { color: red; }' } } }];

    await expect(loadPartnerPortalCustomCss(ORG_ID)).resolves.toBe('.p { color: red; }');

    expect(dbState.outsideContextCalls).toBe(1);
    expect(dbState.systemContextCalls).toBe(1);
    const query = new PgDialect().sqlToQuery(dbState.where as SQL);
    expect(query.sql).toContain('"organizations"."id" = $1');
    expect(query.params).toEqual([ORG_ID]);
  });

  it('returns null when the org has no partner row', async () => {
    dbState.rows = [];
    await expect(loadPartnerPortalCustomCss(ORG_ID)).resolves.toBeNull();
  });

  it('returns null when the stored partner CSS fails the safety rules, warning once per partner', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      dbState.rows = [{ partnerId: 'p-bad', settings: { branding: { customCss: '@import "x.css";' } } }];
      await expect(loadPartnerPortalCustomCss(ORG_ID)).resolves.toBeNull();
      await expect(loadPartnerPortalCustomCss(ORG_ID)).resolves.toBeNull();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toEqual({ partnerId: 'p-bad' });
      // The CSS itself never reaches the log.
      expect(JSON.stringify(warn.mock.calls)).not.toContain('@import');
    } finally {
      warn.mockRestore();
    }
  });

  it('degrades to null and reports when the lookup fails, so branding still renders', async () => {
    dbState.error = new Error('connection reset');

    await expect(loadPartnerPortalCustomCss(ORG_ID)).resolves.toBeNull();

    expect(captureMock).toHaveBeenCalledWith(dbState.error, undefined, { area: 'portal-branding-partner-css' });
  });
});
