import { beforeEach, describe, expect, it, vi } from 'vitest';

const ref = vi.hoisted(() => ({ db: null as any }));
vi.mock('../../db', () => ({ db: new Proxy({}, { get: (_, key) => ref.db[key] }) }));

import { makeDbMock } from './testing';
import { destinationHash } from './destinations';
import { isLiveCard, loadLinkDelivery, toPublicCard, type PublicLookup } from './publicLookup';

const id = '11111111-1111-4111-8111-111111111111';
const future = () => new Date(Date.now() + 60_000);

function lookup(over: Partial<PublicLookup> = {}): PublicLookup {
  return {
    id, method: 'sms', status: 'pending', createdAt: new Date(), expiresAt: future(),
    technicianLabel: 'Taylor', actionScope: 'reset_password', targetLabel: 'alex@example.com',
    reverseCode: '7291', challengeChoices: ['17', '42', '83'], contactName: '  Alex Example ',
    partnerName: 'Example MSP', logoUrl: 'javascript:alert(1)', accentColor: '#123456', headline: null,
    ...over,
  };
}

describe('toPublicCard', () => {
  it('projects only recipient fields, never ids or roles', () => {
    const card = toPublicCard(lookup() as PublicLookup & { challengeChoices: string[] });
    expect(Object.keys(card).sort()).toEqual(['actionScope', 'branding', 'choices', 'contactFirstName',
      'expiresAt', 'reverseCode', 'status', 'targetLabel', 'technicianLabel'].sort());
    expect(card.contactFirstName).toBe('Alex');
    expect(card.choices).toEqual(['17', '42', '83']);
    expect(JSON.stringify(card)).not.toContain(id);
    expect(JSON.stringify(card)).not.toMatch(/match|decoy|destination|tier|fence/i);
  });

  it('drops unsafe branding values', () => {
    const card = toPublicCard(lookup({ accentColor: 'red;background:url(x)' }) as PublicLookup & { challengeChoices: string[] });
    expect(card.branding).toEqual({ partnerName: 'Example MSP', logoUrl: null, accentColor: null, headline: null });
    expect(toPublicCard(lookup({ logoUrl: 'https://cdn.example.com/logo.png' }) as PublicLookup & { challengeChoices: string[] }).branding?.logoUrl)
      .toBe('https://cdn.example.com/logo.png');
    expect(toPublicCard(lookup({ partnerName: null }) as PublicLookup & { challengeChoices: string[] }).branding).toBeNull();
  });
});

describe('isLiveCard', () => {
  it.each([
    ['unknown', null],
    ['decided', lookup({ status: 'verified' })],
    ['rejected', lookup({ status: 'rejected_by_user' })],
    ['expired', lookup({ expiresAt: new Date(Date.now() - 1) })],
    ['unprepared', lookup({ challengeChoices: null })],
    ['workstation', lookup({ method: 'workstation' })],
  ])('hides a %s challenge', (_label, row) => {
    expect(isLiveCard(row)).toBe(false);
  });
  it('shows a pending prepared link challenge', () => {
    expect(isLiveCard(lookup())).toBe(true);
    expect(isLiveCard(lookup({ method: 'email' }))).toBe(true);
  });
});

describe('loadLinkDelivery', () => {
  let state: ReturnType<typeof makeDbMock>;
  const base = {
    id, orgId: 'org', contactId: 'contact', method: 'sms', status: 'pending', expiresAt: future(),
    challengeTokenHash: 'h'.repeat(64), sealedLinkToken: 'enc:v3:x', destinationId: 'dest',
    technicianLabel: 'Taylor', actionScope: 'disable_user', targetLabel: 'Alex', email: 'Alex@Example.com',
    mobile: '+1 555 555 0123', partnerId: 'partner', partnerName: 'Example MSP',
  };
  beforeEach(() => { state = makeDbMock(); ref.db = state.db; });

  it('resolves the current destination only when it still hashes to the snapshot', async () => {
    state.results.push([base], [{ id: 'dest', kind: 'mobile', valueHash: destinationHash('+15555550123') }]);
    expect(await loadLinkDelivery(id)).toMatchObject({ destination: '+15555550123', method: 'sms', partnerId: 'partner', requestLabel: 'disable the account for Alex' });
  });

  it('never redirects to a changed value', async () => {
    state.results.push([base], [{ id: 'dest', kind: 'mobile', valueHash: destinationHash('+15555550999') }]);
    expect((await loadLinkDelivery(id))?.destination).toBeNull();
    state.results.push([base], []);
    expect((await loadLinkDelivery(id))?.destination).toBeNull();
    state.results.push([{ ...base, method: 'email' }], [{ id: 'dest', kind: 'mobile', valueHash: destinationHash('alex@example.com') }]);
    expect((await loadLinkDelivery(id))?.destination).toBeNull();
  });

  it('resolves an email destination case-insensitively', async () => {
    state.results.push([{ ...base, method: 'email' }], [{ id: 'dest', kind: 'email', valueHash: destinationHash('alex@example.com') }]);
    expect((await loadLinkDelivery(id))?.destination).toBe('alex@example.com');
  });

  it.each([
    ['decided', { status: 'verified' }],
    ['expired', { expiresAt: new Date(Date.now() - 1) }],
    ['callback', { method: 'callback_attestation' }],
    ['tokenless', { challengeTokenHash: null }],
  ])('returns nothing for a %s row', async (_label, over) => {
    state.results.push([{ ...base, ...over }]);
    expect(await loadLinkDelivery(id)).toBeNull();
  });
});
