/**
 * Tests for getOrgAgentVersionPinsBatch — the batch variant of
 * getOrgAgentUpdateConfig's pin resolution (routes/agents/helpers.ts), for
 * read paths that need MANY orgs' effective agent-version pins in one round
 * trip (issue #5285: the Devices list "Agent Version" badge, resolved once
 * per page load across every visible org).
 *
 * Deliberately its own file with its own minimal mock harness: this module
 * imports only db/schema + @breeze/shared, NOT routes/agents/helpers.ts
 * (whose import graph is far larger and broke unrelated route tests when
 * this function briefly lived there — see the comment in the source file).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock } = vi.hoisted(() => {
  let nextResult: unknown[] = [];
  const chains: any[] = [];

  const makeSelectChain = () => {
    const chain: any = {
      from: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
    };
    chain.then = (resolve: any, reject: any) => Promise.resolve(nextResult).then(resolve, reject);
    chains.push(chain);
    return chain;
  };

  const dbMock = {
    select: vi.fn(() => makeSelectChain()),
    _setResult(rows: unknown[]) {
      nextResult = rows;
    },
  };

  return { dbMock };
});

vi.mock('../db', () => ({ db: dbMock }));
vi.mock('../db/schema', () => ({
  organizations: { id: 'orgs.id', settings: 'orgs.settings', partnerId: 'orgs.partner_id' },
  partners: { id: 'partners.id', settings: 'partners.settings' },
}));

import { getOrgAgentVersionPinsBatch } from './orgAgentVersionPins';

describe('getOrgAgentVersionPinsBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an empty map without querying for an empty input', async () => {
    const result = await getOrgAgentVersionPinsBatch([]);
    expect(result).toEqual({});
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('resolves pins for multiple orgs from ONE joined query', async () => {
    dbMock._setResult([
      { id: 'org-a', orgSettings: { defaults: { agentVersionPins: { agent: '0.88.0' } } }, partnerSettings: null },
      { id: 'org-b', orgSettings: { defaults: {} }, partnerSettings: { defaults: { agentVersionPins: { agent: '0.90.0' } } } },
      { id: 'org-c', orgSettings: { defaults: {} }, partnerSettings: null },
    ]);
    const result = await getOrgAgentVersionPinsBatch(['org-a', 'org-b', 'org-c']);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      'org-a': { agent: '0.88.0', watchdog: null },
      'org-b': { agent: '0.90.0', watchdog: null },
      'org-c': { agent: null, watchdog: null },
    });
  });

  it('org pin overrides an inherited partner pin, same precedence as the single-org resolver', async () => {
    dbMock._setResult([
      {
        id: 'org-a',
        orgSettings: { defaults: { agentVersionPins: { agent: '0.80.0' } } },
        partnerSettings: { defaults: { agentVersionPins: { agent: '0.88.0' } } },
      },
    ]);
    const result = await getOrgAgentVersionPinsBatch(['org-a']);
    expect(result).toEqual({ 'org-a': { agent: '0.80.0', watchdog: null } });
  });

  it('org inherits the partner pin per component where the org has not set it', async () => {
    dbMock._setResult([
      {
        id: 'org-a',
        orgSettings: { defaults: { agentVersionPins: { watchdog: '0.70.0' } } },
        partnerSettings: { defaults: { agentVersionPins: { agent: '0.88.0' } } },
      },
    ]);
    const result = await getOrgAgentVersionPinsBatch(['org-a']);
    expect(result).toEqual({ 'org-a': { agent: '0.88.0', watchdog: '0.70.0' } });
  });

  it("normalizes the 'latest' sentinel to null (no pin), same as the single-org resolver", async () => {
    dbMock._setResult([
      { id: 'org-a', orgSettings: { defaults: { agentVersionPins: { agent: 'latest' } } }, partnerSettings: null },
    ]);
    const result = await getOrgAgentVersionPinsBatch(['org-a']);
    expect(result).toEqual({ 'org-a': { agent: null, watchdog: null } });
  });

  it('an org missing from the result rows (e.g. deleted mid-request) is simply absent, not a crash', async () => {
    dbMock._setResult([
      { id: 'org-a', orgSettings: { defaults: {} }, partnerSettings: null },
    ]);
    const result = await getOrgAgentVersionPinsBatch(['org-a', 'org-missing']);
    expect(result).toEqual({ 'org-a': { agent: null, watchdog: null } });
  });
});
