import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  db: null as any,
  contact: vi.fn(),
  bindings: vi.fn(),
  ready: vi.fn(),
}));
vi.mock('../../db', () => ({ db: new Proxy({}, { get: (_, key) => m.db[key] }) }));
vi.mock('./access', () => ({ reachableContact: m.contact }));
vi.mock('./subjects', () => ({ bindingsForContact: m.bindings }));
vi.mock('./workstationCapabilities', () => ({ workstationUserAvailable: m.ready }));

import { makeDbMock } from './testing';
import { deviceSuggestions, matchSuggestedUsername, suggestionCandidates } from './deviceSuggestions';
import type { CallerVerificationActor } from './types';

const actor: CallerVerificationActor = {
  userId: 'u', partnerId: 'p', scope: 'partner', accessibleOrgIds: null, allowedSiteIds: null, displayName: 'Sam',
};

describe('matchSuggestedUsername', () => {
  it('returns the device spelling and treats a binding as a hint only', () => {
    expect(matchSuggestedUsername('ACME\\Alex', ['acme\\alex'], ['ACME\\Alex'])).toEqual({ username: 'ACME\\Alex', hasBinding: true });
    expect(matchSuggestedUsername('alex', ['alex'], [])).toEqual({ username: 'alex', hasBinding: false });
    expect(matchSuggestedUsername('different', ['alex'], ['alex'])).toBeNull();
    expect(matchSuggestedUsername(null, ['alex'], [])).toBeNull();
    expect(matchSuggestedUsername('  ', ['alex'], [])).toBeNull();
  });
});

describe('suggestionCandidates', () => {
  it('derives login-name hints from the contact and its active bindings', () => {
    expect(suggestionCandidates(
      { name: 'Alex Smith', email: 'Alex.Smith@example.com' },
      [{ osUsername: 'asmith', upnSnapshot: 'alex@corp.example.com', revokedAt: null }] as never,
    ).sort()).toEqual(['alex', 'alex smith', 'alex.smith', 'alex.smith@example.com', 'alex@corp.example.com', 'asmith'].sort());
  });
  it('ignores revoked bindings and empty values', () => {
    expect(suggestionCandidates({ name: ' ', email: null }, [{ osUsername: 'x', upnSnapshot: null, revokedAt: new Date() }] as never)).toEqual([]);
  });
});

describe('deviceSuggestions', () => {
  let state: ReturnType<typeof makeDbMock>;
  beforeEach(() => {
    vi.clearAllMocks();
    state = makeDbMock(); m.db = state.db;
    m.contact.mockResolvedValue({ id: 'c', name: 'Alex', email: 'alex@example.com', siteId: null });
    m.bindings.mockResolvedValue([{ osUsername: 'alex', upnSnapshot: 'alex@example.com', revokedAt: null }]);
  });

  it('checks reach first and returns per-device readiness, including unavailable devices', async () => {
    state.results.push([
      { id: 'd1', hostname: 'ready-pc', lastUser: 'alex' },
      { id: 'd2', hostname: 'old-pc', lastUser: 'alex' },
    ]);
    m.ready.mockImplementation(async (_o: string, device: string) => device === 'd1');
    const rows = await deviceSuggestions(actor, 'org', 'c');
    expect(m.contact).toHaveBeenCalledWith(actor, 'org', 'c');
    expect(rows).toEqual([
      { deviceId: 'd1', hostname: 'ready-pc', username: 'alex', hasBinding: true, available: true },
      { deviceId: 'd2', hostname: 'old-pc', username: 'alex', hasBinding: true, available: false, unavailableReason: 'helper_outdated' },
    ]);
    expect(m.ready).toHaveBeenCalledWith('org', 'd1', 'alex');
  });

  it('refuses an unreachable contact before touching devices', async () => {
    m.contact.mockRejectedValue(Object.assign(new Error('Contact not found'), { code: 'not_found' }));
    await expect(deviceSuggestions(actor, 'org', 'c')).rejects.toMatchObject({ code: 'not_found' });
    expect(state.calls.some((c) => c.name === 'select')).toBe(false);
  });

  it('returns nothing for a site-restricted actor with no sites, or a contact with no hints', async () => {
    expect(await deviceSuggestions({ ...actor, allowedSiteIds: [] }, 'org', 'c')).toEqual([]);
    m.contact.mockResolvedValue({ id: 'c', name: ' ', email: null, siteId: null });
    m.bindings.mockResolvedValue([]);
    expect(await deviceSuggestions(actor, 'org', 'c')).toEqual([]);
    expect(state.calls.some((c) => c.name === 'select')).toBe(false);
  });
});
