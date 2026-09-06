import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each db.select(...) chain resolves to the next queued row array, and records
// the `.where()` predicate it was given so a test can pin WHICH row the
// resolver asked for. A mock that ignores `.where()` would pass a resolver that
// queried the wrong id (PR #3918 review, must-fix 4).
const selectResults: unknown[][] = [];
const whereCalls: unknown[] = [];

function queueSelect(rows: unknown[]) {
  selectResults.push(rows);
}

let ambientContext: { scope: string } | undefined = { scope: 'system' };
const readWithPartnerAxisVisibility = vi.fn(async (fn: () => Promise<unknown>) => fn());
const captureMessage = vi.fn();

vi.mock('drizzle-orm', () => ({
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));

vi.mock('../db', () => {
  const chain = () => {
    const result = selectResults.shift() ?? [];
    const builder: Record<string, unknown> = {};
    builder.from = vi.fn(() => builder);
    builder.where = vi.fn((predicate: unknown) => {
      whereCalls.push(predicate);
      return builder;
    });
    builder.limit = vi.fn(() => Promise.resolve(result));
    return builder;
  };
  return {
    db: { select: vi.fn(chain) },
    getCurrentDbAccessContext: vi.fn(() => ambientContext),
  };
});

vi.mock('../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: (fn: () => Promise<unknown>) => readWithPartnerAxisVisibility(fn),
}));

vi.mock('./sentry', () => ({
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

vi.mock('../db/schema', () => ({
  users: { id: 'users.id', preferences: 'users.preferences' },
  organizations: { id: 'organizations.id', settings: 'organizations.settings' },
  partners: { id: 'partners.id', settings: 'partners.settings' },
}));

import { resolveRecipientLocale } from './recipientLocale';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  selectResults.length = 0;
  whereCalls.length = 0;
  ambientContext = { scope: 'system' };
  vi.clearAllMocks();
});

describe('resolveRecipientLocale', () => {
  it('returns the explicit value immediately when it is a supported locale', async () => {
    const locale = await resolveRecipientLocale({ explicit: 'fr-CA' });
    expect(locale).toBe('fr-CA');
    expect(whereCalls).toHaveLength(0);
    expect(readWithPartnerAxisVisibility).not.toHaveBeenCalled();
  });

  it('ignores an unsupported explicit value and falls through', async () => {
    queueSelect([{ preferences: { locale: 'pt-BR' } }]); // user row
    const locale = await resolveRecipientLocale({ userId: USER_ID, explicit: 'xx' });
    expect(locale).toBe('pt-BR');
  });

  it('returns user preference locale, pinned to the supplied user id', async () => {
    queueSelect([{ preferences: { locale: 'de-DE' } }]);
    const locale = await resolveRecipientLocale({ userId: USER_ID });
    expect(locale).toBe('de-DE');
    expect(whereCalls).toEqual([{ column: 'users.id', value: USER_ID }]);
  });

  it('falls through to org language when user preference is absent, pinned to the org id', async () => {
    queueSelect([{ preferences: {} }]); // user — no locale
    queueSelect([{ settings: { language: 'es-419' } }]); // org
    const locale = await resolveRecipientLocale({ userId: USER_ID, orgId: ORG_ID });
    expect(locale).toBe('es-419');
    expect(whereCalls).toEqual([
      { column: 'users.id', value: USER_ID },
      { column: 'organizations.id', value: ORG_ID },
    ]);
  });

  it('falls through to org language when user row is missing', async () => {
    queueSelect([]); // user not found
    queueSelect([{ settings: { language: 'fr-FR' } }]); // org
    const locale = await resolveRecipientLocale({ userId: USER_ID, orgId: ORG_ID });
    expect(locale).toBe('fr-FR');
  });

  it('falls through to partner language when user and org have no locale, pinned to the partner id', async () => {
    queueSelect([{ preferences: null }]); // user
    queueSelect([{ settings: {} }]); // org — no language
    queueSelect([{ settings: { language: 'it-IT' } }]); // partner
    const locale = await resolveRecipientLocale({ userId: USER_ID, orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(locale).toBe('it-IT');
    expect(whereCalls[2]).toEqual({ column: 'partners.id', value: PARTNER_ID });
  });

  it('falls back to "en" when no identity is supplied, without touching the DB or context', async () => {
    ambientContext = undefined;
    const locale = await resolveRecipientLocale({});
    expect(locale).toBe('en');
    expect(whereCalls).toHaveLength(0);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('falls back to "en" and reports when every row is missing', async () => {
    queueSelect([]); // user not found
    queueSelect([]); // org not found
    queueSelect([]); // partner not found
    const locale = await resolveRecipientLocale({ userId: USER_ID, orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(locale).toBe('en');
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage.mock.calls[0]?.[1]).toMatchObject({
      eventCode: 'recipient_locale_unresolved',
      tags: { org_id: ORG_ID, partner_id: PARTNER_ID },
    });
  });

  it('falls back to "en" for an unsupported partner language without reporting (row was found)', async () => {
    queueSelect([{ settings: { language: 'klingon' } }]); // partner — invalid
    const locale = await resolveRecipientLocale({ partnerId: PARTNER_ID });
    expect(locale).toBe('en');
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('handles null preferences/settings blobs gracefully', async () => {
    queueSelect([{ preferences: null }]); // user
    queueSelect([{ settings: null }]); // org
    queueSelect([{ settings: null }]); // partner
    const locale = await resolveRecipientLocale({ userId: USER_ID, orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(locale).toBe('en');
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('skips user lookup when userId is not provided', async () => {
    queueSelect([{ settings: { language: 'tr-TR' } }]); // first select goes to org
    const locale = await resolveRecipientLocale({ orgId: ORG_ID });
    expect(locale).toBe('tr-TR');
    expect(whereCalls).toEqual([{ column: 'organizations.id', value: ORG_ID }]);
  });

  it('throws when called with ids but no DB access context (silent-English guard)', async () => {
    ambientContext = undefined;
    await expect(resolveRecipientLocale({ orgId: ORG_ID })).rejects.toThrow(/DB access context/);
    expect(whereCalls).toHaveLength(0);
  });

  it('runs every DB hop inside ONE readWithPartnerAxisVisibility escape', async () => {
    ambientContext = { scope: 'organization' };
    queueSelect([{ preferences: {} }]);
    queueSelect([{ settings: {} }]);
    queueSelect([{ settings: { language: 'pt-BR' } }]);
    const locale = await resolveRecipientLocale({ userId: USER_ID, orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(locale).toBe('pt-BR');
    expect(readWithPartnerAxisVisibility).toHaveBeenCalledTimes(1);
    expect(whereCalls).toHaveLength(3);
  });
});
