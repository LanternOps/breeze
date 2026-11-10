import { describe, expect, it, vi } from 'vitest';
import { PORTAL_LOGIN_CANDIDATE_CAP, resolveLoginCandidate } from './loginCandidates';

const DUMMY = 'dummy-hash';
const cand = (id: string, passwordHash: string | null) => ({ id, passwordHash, orgId: `org-${id}` });

/** verify(hash, pw) is true when the hash is `ok:<pw>`. */
const makeVerify = () => vi.fn(async (hash: string, pw: string) => hash === `ok:${pw}`);
const dummyHash = vi.fn(async () => DUMMY);

describe('resolveLoginCandidate', () => {
  it('returns the single candidate whose password verifies', async () => {
    const verify = makeVerify();
    const solo = cand('a', 'ok:pw');
    expect(await resolveLoginCandidate([solo], 'pw', verify, dummyHash)).toBe(solo);
  });

  it('returns the only candidate whose password verifies among several', async () => {
    const verify = makeVerify();
    const winner = cand('b', 'ok:pw');
    const result = await resolveLoginCandidate([cand('a', 'ok:other'), winner, cand('c', null)], 'pw', verify, dummyHash);
    expect(result).toBe(winner);
  });

  // Review Focus 3: one person, two orgs, same password → the generic failure, never an arbitrary org.
  it('returns null when two candidates verify (same password in two orgs)', async () => {
    const verify = makeVerify();
    expect(await resolveLoginCandidate([cand('a', 'ok:pw'), cand('b', 'ok:pw')], 'pw', verify, dummyHash)).toBeNull();
  });

  it('verifies every hashed candidate even after a match (no short-circuit)', async () => {
    const verify = makeVerify();
    await resolveLoginCandidate([cand('a', 'ok:pw'), cand('b', 'ok:x'), cand('c', 'ok:y')], 'pw', verify, dummyHash);
    expect(verify).toHaveBeenCalledTimes(3);
    expect(verify.mock.calls.map((c) => c[0])).toEqual(['ok:pw', 'ok:x', 'ok:y']);
  });

  it('runs one dummy verify when no candidate has a hash (and for an unknown address)', async () => {
    const verify = makeVerify();
    expect(await resolveLoginCandidate([cand('a', null), cand('b', null)], 'pw', verify, dummyHash)).toBeNull();
    expect(verify.mock.calls).toEqual([[DUMMY, 'pw']]);

    const verify2 = makeVerify();
    expect(await resolveLoginCandidate([], 'pw', verify2, dummyHash)).toBeNull();
    expect(verify2.mock.calls).toEqual([[DUMMY, 'pw']]);
  });

  it('returns null above the candidate cap after a dummy verify', async () => {
    const verify = makeVerify();
    const many = Array.from({ length: PORTAL_LOGIN_CANDIDATE_CAP + 1 }, (_, i) => cand(String(i), 'ok:pw'));
    expect(await resolveLoginCandidate(many, 'pw', verify, dummyHash)).toBeNull();
    expect(verify.mock.calls).toEqual([[DUMMY, 'pw']]);
  });

  it('still verifies all candidates at exactly the cap', async () => {
    const verify = makeVerify();
    const atCap = Array.from({ length: PORTAL_LOGIN_CANDIDATE_CAP }, (_, i) => cand(String(i), i === 3 ? 'ok:pw' : 'ok:no'));
    expect((await resolveLoginCandidate(atCap, 'pw', verify, dummyHash))?.id).toBe('3');
    expect(verify).toHaveBeenCalledTimes(PORTAL_LOGIN_CANDIDATE_CAP);
  });

  it('treats a verifier that throws as a non-match', async () => {
    const verify = vi.fn(async (hash: string) => { if (hash === 'boom') throw new Error('corrupt hash'); return hash === 'ok:pw'; });
    const winner = cand('b', 'ok:pw');
    expect(await resolveLoginCandidate([cand('a', 'boom'), winner], 'pw', verify, dummyHash)).toBe(winner);
  });
});
