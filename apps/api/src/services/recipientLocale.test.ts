import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each db.select(...) chain resolves to the next queued row array.
const selectResults: unknown[][] = [];

function queueSelect(rows: unknown[]) {
  selectResults.push(rows);
}

vi.mock('../db', () => {
  const chain = () => {
    const result = selectResults.shift() ?? [];
    const builder: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'orderBy']) {
      builder[method] = vi.fn(() => builder);
    }
    builder.limit = vi.fn(() => Promise.resolve(result));
    return builder;
  };
  return { db: { select: vi.fn(chain) } };
});

vi.mock('../db/schema', () => ({
  users: { id: 'users.id', preferences: 'users.preferences' },
  organizations: { id: 'organizations.id', settings: 'organizations.settings' },
  partners: { id: 'partners.id', settings: 'partners.settings' },
}));

import { resolveRecipientLocale } from './recipientLocale';

const USER_ID  = '11111111-1111-4111-8111-111111111111';
const ORG_ID   = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  selectResults.length = 0;
  vi.clearAllMocks();
});

describe('resolveRecipientLocale', () => {
  it('returns the explicit value immediately when it is a supported locale', async () => {
    const locale = await resolveRecipientLocale({ explicit: 'fr-CA' });
    expect(locale).toBe('fr-CA');
    // No DB queries should have been made
    expect(selectResults).toHaveLength(0);
  });

  it('ignores an unsupported explicit value and falls through', async () => {
    queueSelect([{ preferences: { locale: 'pt-BR' } }]); // user row
    const locale = await resolveRecipientLocale({ userId: USER_ID, explicit: 'xx' });
    expect(locale).toBe('pt-BR');
  });

  it('returns user preference locale when present', async () => {
    queueSelect([{ preferences: { locale: 'de-DE' } }]);
    const locale = await resolveRecipientLocale({ userId: USER_ID });
    expect(locale).toBe('de-DE');
  });

  it('falls through to org language when user preference is absent', async () => {
    queueSelect([{ preferences: {} }]);            // user — no locale
    queueSelect([{ settings: { language: 'es-419' } }]); // org
    const locale = await resolveRecipientLocale({ userId: USER_ID, orgId: ORG_ID });
    expect(locale).toBe('es-419');
  });

  it('falls through to org language when user row is missing', async () => {
    queueSelect([]);                                       // user not found
    queueSelect([{ settings: { language: 'fr-FR' } }]);   // org
    const locale = await resolveRecipientLocale({ userId: USER_ID, orgId: ORG_ID });
    expect(locale).toBe('fr-FR');
  });

  it('falls through to partner language when user and org have no locale', async () => {
    queueSelect([{ preferences: null }]);                  // user
    queueSelect([{ settings: {} }]);                       // org — no language
    queueSelect([{ settings: { language: 'it-IT' } }]);    // partner
    const locale = await resolveRecipientLocale({ userId: USER_ID, orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(locale).toBe('it-IT');
  });

  it('falls back to "en" when no identity is supplied', async () => {
    const locale = await resolveRecipientLocale({});
    expect(locale).toBe('en');
  });

  it('falls back to "en" when all rows are missing', async () => {
    queueSelect([]); // user not found
    queueSelect([]); // org not found
    queueSelect([]); // partner not found
    const locale = await resolveRecipientLocale({ userId: USER_ID, orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(locale).toBe('en');
  });

  it('falls back to "en" for an unsupported partner language', async () => {
    queueSelect([{ settings: { language: 'klingon' } }]); // partner — invalid
    const locale = await resolveRecipientLocale({ partnerId: PARTNER_ID });
    expect(locale).toBe('en');
  });

  it('handles null preferences/settings blobs gracefully', async () => {
    queueSelect([{ preferences: null }]);     // user
    queueSelect([{ settings: null }]);        // org
    queueSelect([{ settings: null }]);        // partner
    const locale = await resolveRecipientLocale({ userId: USER_ID, orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(locale).toBe('en');
  });

  it('skips user lookup when userId is not provided', async () => {
    queueSelect([{ settings: { language: 'tr-TR' } }]); // first select goes to org
    const locale = await resolveRecipientLocale({ orgId: ORG_ID });
    expect(locale).toBe('tr-TR');
  });

  it('resolves org-only path when only orgId is provided', async () => {
    queueSelect([{ settings: { language: 'pt-BR' } }]);
    const locale = await resolveRecipientLocale({ orgId: ORG_ID });
    expect(locale).toBe('pt-BR');
  });
});
