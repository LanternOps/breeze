import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { PORTAL_CUSTOM_CSS_MAX_LENGTH } from '@breeze/shared';

// Single-read DB mock (same convention as featureFlags.test.ts). The system
// context wrappers record that they ran, so the test can prove the partner
// read happens outside the portal user's tenant context.
const { dbState } = vi.hoisted(() => ({
  dbState: {
    rows: [] as unknown[],
    where: undefined as unknown,
    systemContextCalls: 0,
    outsideContextCalls: 0,
  },
}));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'innerJoin', 'limit']) chain[m] = vi.fn(() => chain);
  chain.where = vi.fn((predicate: unknown) => {
    dbState.where = predicate;
    return chain;
  });
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(dbState.rows).then(resolve);
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
    dbState.systemContextCalls = 0;
    dbState.outsideContextCalls = 0;
  });

  it("reads the org's partner settings in system scope, keyed only by the org id", async () => {
    dbState.rows = [{ settings: { branding: { customCss: '.p { color: red; }' } } }];

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

  it('returns null when the stored partner CSS fails the safety rules', async () => {
    dbState.rows = [{ settings: { branding: { customCss: '@import "x.css";' } } }];
    await expect(loadPartnerPortalCustomCss(ORG_ID)).resolves.toBeNull();
  });
});
