import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
import { fetchWithAuth } from '../../../stores/auth';
import { featureOutranked, fetchPolicyPrecedence, parsePrecedence } from './precedenceApi';

const fetchMock = vi.mocked(fetchWithAuth);
const respond = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

// Fixtures are the literals `computePolicyPrecedence` returns (#12553):
// `{ capped: true }` or `{ capped: false, features: { <featureType>: { reached, outranked } } }`.
describe('parsePrecedence (#12472)', () => {
  it('reads capped as capped, whatever else the body holds', () => {
    expect(parsePrecedence({ capped: true })).toEqual({ capped: true });
    expect(parsePrecedence({ capped: true, features: { patch: { reached: 0, outranked: 0 } } })).toEqual({
      capped: true,
    });
  });

  it('reads the per-feature counts', () => {
    expect(
      parsePrecedence({
        capped: false,
        features: { patch: { reached: 40, outranked: 3 }, backup: { reached: 40, outranked: 0 } },
      }),
    ).toEqual({
      capped: false,
      features: { patch: { reached: 40, outranked: 3 }, backup: { reached: 40, outranked: 0 } },
    });
  });

  it('an empty features record is counts with no data, not unknown', () => {
    expect(parsePrecedence({ capped: false, features: {} })).toEqual({ capped: false, features: {} });
  });

  it('drops an entry whose key is not a feature type or whose counts are not counts', () => {
    const parsed = parsePrecedence({
      capped: false,
      features: {
        patch: { reached: 10, outranked: 2 },
        not_a_feature: { reached: 10, outranked: 2 },
        backup: { reached: 10, outranked: -1 },
        monitors: { reached: 10, outranked: 1.5 },
        security: { reached: '10', outranked: 1 },
        pam: { outranked: 1 },
        helper: null,
        // More outranked than reached cannot be a real answer.
        warranty: { reached: 1, outranked: 2 },
      },
    });
    expect(parsed).toEqual({ capped: false, features: { patch: { reached: 10, outranked: 2 } } });
  });

  it('anything else is unknown (null), never zero', () => {
    for (const body of [
      null,
      undefined,
      'capped',
      [],
      {},
      { capped: 'true' },
      { capped: 1 },
      { capped: false },
      { capped: false, features: null },
      { capped: false, features: [] },
      { error: 'Configuration policy not found' },
    ]) {
      expect(parsePrecedence(body)).toBeNull();
    }
  });
});

describe('featureOutranked (#12472)', () => {
  const counts = parsePrecedence({
    capped: false,
    features: { patch: { reached: 40, outranked: 3 }, backup: { reached: 40, outranked: 0 } },
  });

  it('names the count when another policy wins on some devices', () => {
    expect(featureOutranked(counts, 'patch')).toEqual({ kind: 'outranked', count: 3, reached: 40 });
  });

  it('zero outranked, a missing feature and an unknown answer are all nothing to show', () => {
    expect(featureOutranked(counts, 'backup')).toBeNull();
    expect(featureOutranked(counts, 'monitors')).toBeNull();
    expect(featureOutranked(null, 'patch')).toBeNull();
  });

  it('capped is its own state for every feature', () => {
    expect(featureOutranked({ capped: true }, 'patch')).toEqual({ kind: 'capped' });
  });
});

describe('fetchPolicyPrecedence (#12472)', () => {
  beforeEach(() => fetchMock.mockReset());

  it('reads GET /configuration-policies/:id/precedence through the parser', async () => {
    fetchMock.mockResolvedValue(respond(200, { capped: false, features: { patch: { reached: 5, outranked: 1 } } }));
    await expect(fetchPolicyPrecedence('pol-1')).resolves.toEqual({
      capped: false,
      features: { patch: { reached: 5, outranked: 1 } },
    });
    expect(fetchMock).toHaveBeenCalledWith('/configuration-policies/pol-1/precedence');
  });

  it('a refused read throws rather than answering', async () => {
    fetchMock.mockResolvedValue(respond(404, { error: 'Configuration policy not found' }));
    await expect(fetchPolicyPrecedence('pol-1')).rejects.toThrow();
    fetchMock.mockResolvedValue(respond(500, null));
    await expect(fetchPolicyPrecedence('pol-1')).rejects.toThrow();
  });

  it('a malformed 200 is unknown', async () => {
    fetchMock.mockResolvedValue(respond(200, { capped: false }));
    await expect(fetchPolicyPrecedence('pol-1')).resolves.toBeNull();
  });
});
