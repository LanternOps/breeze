import { describe, expect, it, beforeEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

vi.mock('../src/services/secretCrypto', () => ({
  encryptSecret: (s: string | null | undefined) =>
    s == null ? null : `enc:v1:${Buffer.from(s, 'utf8').toString('base64')}`,
  decryptSecret: (s: string | null | undefined) =>
    s == null
      ? null
      : Buffer.from(s.replace(/^enc:v1:/, ''), 'base64').toString('utf8'),
  decryptForColumn: (_t: string, _c: string, s: string | null | undefined) =>
    s == null
      ? null
      : Buffer.from(s.replace(/^enc:v1:/, ''), 'base64').toString('utf8'),
}));

import {
  parseRotationArgs,
  runPrepare,
  runActivate,
  type RotationStore,
  type StoredDelegation,
  type StoredSigningKey,
} from './manifest-key-rotation';
import {
  manifestDelegationCanonicalBytes,
  verifyManifestKeyDelegation,
} from '../src/services/manifestSigning';

// ---------------------------------------------------------------------
// A fake RotationStore. It records the ORDER and ATOMICITY of writes so
// the tests can assert that `prepare` never activates anything and that
// `activate` performs its retire/activate/stamp as one unit.
// ---------------------------------------------------------------------
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  return {
    publicKeyB64: spki.subarray(spki.length - 32).toString('base64'),
    seedB64: pkcs8.subarray(pkcs8.length - 32).toString('base64'),
  };
}

const ACTIVE = keypair();

interface FakeState {
  keys: StoredSigningKey[];
  delegations: StoredDelegation[];
  writes: string[];
  failNextWrite: boolean;
}

function makeStore(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    keys: [
      {
        keyId: 'deploy-2026-05-09-aaaaaaaa',
        publicKeyB64: ACTIVE.publicKeyB64,
        privateKeyEnc: `enc:v1:${Buffer.from(ACTIVE.seedB64, 'utf8').toString('base64')}`,
        status: 'active',
      },
    ],
    delegations: [],
    writes: [],
    failNextWrite: false,
    ...overrides,
  };

  const store: RotationStore = {
    loadActiveKey: async () =>
      state.keys.find((k) => k.status === 'active') ?? null,
    loadDelegations: async () => [...state.delegations],
    insertPreparedRotation: async (input) => {
      state.writes.push('prepare:txn');
      if (state.failNextWrite) throw new Error('simulated write failure');
      // Both rows land together or not at all — mirrors the real
      // db.transaction.
      state.keys.push({
        keyId: input.newKey.keyId,
        publicKeyB64: input.newKey.publicKeyB64,
        privateKeyEnc: input.newKey.privateKeyEnc,
        // The new key is created RETIRED. `prepare` must not change which
        // key is signing.
        status: 'retired',
      });
      state.delegations.push({ ...input.delegation, activatedAt: null });
    },
    applyActivation: async (input) => {
      state.writes.push('activate:txn');
      if (state.failNextWrite) throw new Error('simulated write failure');
      for (const key of state.keys) {
        if (key.keyId === input.oldKeyId) key.status = 'retired';
        if (key.keyId === input.newKeyId) key.status = 'active';
      }
      const row = state.delegations.find((d) => d.epoch === input.epoch);
      if (row) row.activatedAt = input.activatedAt;
    },
  };

  return { store, state };
}

const NOW = new Date('2026-08-06T12:00:00Z');

describe('parseRotationArgs', () => {
  it('parses the prepare subcommand', () => {
    expect(parseRotationArgs(['prepare'])).toEqual({
      command: 'prepare',
      validDays: 30,
    });
    expect(parseRotationArgs(['prepare', '--valid-days', '7'])).toEqual({
      command: 'prepare',
      validDays: 7,
    });
  });

  it('parses the activate subcommand with --epoch and --confirm-adoption', () => {
    expect(
      parseRotationArgs(['activate', '--epoch', '3', '--confirm-adoption']),
    ).toEqual({ command: 'activate', epoch: 3, confirmAdoption: true });
  });

  it('records a missing --confirm-adoption rather than defaulting it on', () => {
    expect(parseRotationArgs(['activate', '--epoch', '3'])).toEqual({
      command: 'activate',
      epoch: 3,
      confirmAdoption: false,
    });
  });

  it('rejects an unknown subcommand, a missing subcommand, and unknown flags', () => {
    expect(() => parseRotationArgs([])).toThrow(/usage|subcommand/i);
    expect(() => parseRotationArgs(['rotate'])).toThrow(/usage|subcommand/i);
    expect(() => parseRotationArgs(['prepare', '--force'])).toThrow(/unknown/i);
  });

  it('rejects a non-numeric, negative or fractional --epoch', () => {
    for (const bad of ['abc', '-1', '1.5', '']) {
      expect(() =>
        parseRotationArgs(['activate', '--epoch', bad, '--confirm-adoption']),
        `--epoch ${bad} was accepted`,
      ).toThrow(/epoch/i);
    }
  });
});

describe('runPrepare', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates the new key as RETIRED and does NOT activate anything', async () => {
    const { store, state } = makeStore();
    await runPrepare(store, { command: 'prepare', validDays: 30 }, NOW);

    expect(state.keys).toHaveLength(2);
    const active = state.keys.filter((k) => k.status === 'active');
    // The single most important property of `prepare`: the deployment is
    // still signing with the SAME key it was signing with before.
    expect(active).toHaveLength(1);
    expect(active[0]!.keyId).toBe('deploy-2026-05-09-aaaaaaaa');
    expect(state.keys[1]!.status).toBe('retired');
  });

  it('records the delegation unactivated, with epoch 1 on a first rotation', async () => {
    const { store, state } = makeStore();
    await runPrepare(store, { command: 'prepare', validDays: 30 }, NOW);

    expect(state.delegations).toHaveLength(1);
    const delegation = state.delegations[0]!;
    expect(delegation.epoch).toBe(1);
    expect(delegation.activatedAt).toBeNull();
    expect(delegation.oldKeyId).toBe('deploy-2026-05-09-aaaaaaaa');
    expect(delegation.newKeyId).toBe(state.keys[1]!.keyId);
  });

  it('signs the delegation with the CURRENT ACTIVE key, over the canonical bytes', async () => {
    const { store, state } = makeStore();
    await runPrepare(store, { command: 'prepare', validDays: 30 }, NOW);

    const d = state.delegations[0]!;
    const fields = {
      oldKeyId: d.oldKeyId,
      newKeyId: d.newKeyId,
      newPublicKeyB64: d.newPublicKeyB64,
      epoch: d.epoch,
      notBefore: d.notBefore,
      notAfter: d.notAfter,
    };
    // Verifies with the OLD key — the one the fleet already trusts.
    expect(
      verifyManifestKeyDelegation(fields, d.signatureB64, ACTIVE.publicKeyB64),
    ).toBe(true);
    // And NOT with the new key, which no agent trusts yet.
    expect(
      verifyManifestKeyDelegation(fields, d.signatureB64, d.newPublicKeyB64),
    ).toBe(false);
    // Over the canonical payload, not some other serialization.
    expect(manifestDelegationCanonicalBytes(fields).toString('utf8')).toContain(
      'breeze-manifest-key-delegation-v1\n',
    );
  });

  it('sets a validity window starting now and running --valid-days', async () => {
    const { store, state } = makeStore();
    await runPrepare(store, { command: 'prepare', validDays: 7 }, NOW);

    const d = state.delegations[0]!;
    expect(d.notBefore).toBe('2026-08-06T12:00:00Z');
    expect(d.notAfter).toBe('2026-08-13T12:00:00Z');
  });

  it('refuses a SECOND prepared delegation while one is still pending', async () => {
    const { store, state } = makeStore();
    await runPrepare(store, { command: 'prepare', validDays: 30 }, NOW);
    const writesAfterFirst = state.writes.length;

    await expect(
      runPrepare(store, { command: 'prepare', validDays: 30 }, NOW),
    ).rejects.toThrow(/already prepared|pending/i);

    // Nothing written on the refusal — no orphan key, no consumed epoch.
    expect(state.writes).toHaveLength(writesAfterFirst);
    expect(state.delegations).toHaveLength(1);
    expect(state.keys).toHaveLength(2);
  });

  it('allows a new prepare once the pending delegation has been activated, with a strictly greater epoch', async () => {
    const { store, state } = makeStore();
    await runPrepare(store, { command: 'prepare', validDays: 30 }, NOW);
    await runActivate(
      store,
      { command: 'activate', epoch: 1, confirmAdoption: true },
      NOW,
    );

    await runPrepare(store, { command: 'prepare', validDays: 30 }, NOW);
    expect(state.delegations.map((d) => d.epoch)).toEqual([1, 2]);
  });

  it('never reuses an epoch, even after an expired unactivated delegation', async () => {
    const { store, state } = makeStore({
      delegations: [
        {
          epoch: 9,
          oldKeyId: 'deploy-old',
          newKeyId: 'deploy-abandoned',
          newPublicKeyB64: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
          notBefore: '2026-01-01T00:00:00Z',
          notAfter: '2026-02-01T00:00:00Z',
          signatureB64: 'c2ln',
          activatedAt: null,
        },
      ],
    });

    // Expired, so it no longer blocks a new prepare...
    await runPrepare(store, { command: 'prepare', validDays: 30 }, NOW);
    // ...but the epoch counter is monotonic over ALL history, never
    // "highest live". A reused epoch is a replay every agent would
    // reject, and it would strand the rotation.
    expect(state.delegations.map((d) => d.epoch)).toEqual([9, 10]);
  });

  it('refuses to prepare when there is no active signing key', async () => {
    const { store, state } = makeStore({ keys: [] });
    await expect(
      runPrepare(store, { command: 'prepare', validDays: 30 }, NOW),
    ).rejects.toThrow(/no active/i);
    expect(state.writes).toEqual([]);
  });

  it('rejects a non-positive or absurd --valid-days rather than minting an unusable window', async () => {
    const { store } = makeStore();
    for (const validDays of [0, -1, 4000]) {
      await expect(
        runPrepare(store, { command: 'prepare', validDays }, NOW),
        `validDays=${validDays} was accepted`,
      ).rejects.toThrow(/valid-days/i);
    }
  });
});

describe('runActivate', () => {
  async function prepared(now: Date = NOW) {
    const made = makeStore();
    await runPrepare(made.store, { command: 'prepare', validDays: 30 }, now);
    return made;
  }

  it('refuses without --confirm-adoption, writing nothing', async () => {
    const { store, state } = await prepared();
    const writesBefore = state.writes.length;

    await expect(
      runActivate(
        store,
        { command: 'activate', epoch: 1, confirmAdoption: false },
        NOW,
      ),
    ).rejects.toThrow(/confirm-adoption/i);

    expect(state.writes).toHaveLength(writesBefore);
    expect(state.delegations[0]!.activatedAt).toBeNull();
    expect(state.keys.find((k) => k.status === 'active')!.keyId).toBe(
      'deploy-2026-05-09-aaaaaaaa',
    );
  });

  it('refuses when --epoch does not match the prepared epoch', async () => {
    const { store, state } = await prepared();
    await expect(
      runActivate(
        store,
        { command: 'activate', epoch: 2, confirmAdoption: true },
        NOW,
      ),
    ).rejects.toThrow(/epoch/i);
    expect(state.delegations[0]!.activatedAt).toBeNull();
  });

  it('refuses when the delegation window has expired', async () => {
    const { store, state } = await prepared();
    const afterExpiry = new Date('2026-10-01T00:00:00Z');

    await expect(
      runActivate(
        store,
        { command: 'activate', epoch: 1, confirmAdoption: true },
        afterExpiry,
      ),
    ).rejects.toThrow(/expired/i);
    expect(state.delegations[0]!.activatedAt).toBeNull();
    expect(state.keys.find((k) => k.status === 'active')!.keyId).toBe(
      'deploy-2026-05-09-aaaaaaaa',
    );
  });

  it('refuses when nothing is prepared', async () => {
    const { store } = makeStore();
    await expect(
      runActivate(
        store,
        { command: 'activate', epoch: 1, confirmAdoption: true },
        NOW,
      ),
    ).rejects.toThrow(/no prepared|not prepared/i);
  });

  it('refuses to re-activate an already-activated epoch (epoch reuse)', async () => {
    const { store, state } = await prepared();
    await runActivate(
      store,
      { command: 'activate', epoch: 1, confirmAdoption: true },
      NOW,
    );
    const writesAfter = state.writes.length;

    await expect(
      runActivate(
        store,
        { command: 'activate', epoch: 1, confirmAdoption: true },
        NOW,
      ),
    ).rejects.toThrow(/no prepared|already/i);
    expect(state.writes).toHaveLength(writesAfter);
  });

  it('retires the old key, activates the new one, and stamps activation in ONE transaction', async () => {
    const { store, state } = await prepared();
    const newKeyId = state.keys[1]!.keyId;

    await runActivate(
      store,
      { command: 'activate', epoch: 1, confirmAdoption: true },
      NOW,
    );

    const active = state.keys.filter((k) => k.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0]!.keyId).toBe(newKeyId);
    expect(
      state.keys.find((k) => k.keyId === 'deploy-2026-05-09-aaaaaaaa')!.status,
    ).toBe('retired');
    expect(state.delegations[0]!.activatedAt).toEqual(NOW);

    // Exactly one write call for activation — the retire, the activate and
    // the stamp are not three separately-failable steps.
    expect(state.writes.filter((w) => w === 'activate:txn')).toHaveLength(1);
  });

  it('activates the LIVE prepared record even when an abandoned expired one is still unactivated', async () => {
    // Regression: runActivate used to take pending[0] from a list loaded with
    // no ORDER BY. With a stale expired prepare sitting alongside a live one,
    // it could pick the expired row — and then --epoch <live> failed with
    // "does not match the prepared epoch <expired>", while --epoch <expired>
    // failed with "expired". Rotation was unactivatable until someone deleted
    // the stale row by hand, and DELETE is not part of the granted lifecycle.
    const { store, state } = makeStore({
      delegations: [
        {
          epoch: 9,
          oldKeyId: 'deploy-2026-05-09-aaaaaaaa',
          newKeyId: 'deploy-abandoned',
          newPublicKeyB64: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
          notBefore: '2026-01-01T00:00:00Z',
          notAfter: '2026-02-01T00:00:00Z',
          signatureB64: 'c2ln',
          activatedAt: null,
        },
      ],
    });

    // A new prepare is allowed (the stale one is expired, so not "pending").
    await runPrepare(store, { command: 'prepare', validDays: 30 }, NOW);
    expect(state.delegations.map((d) => d.epoch)).toEqual([9, 10]);
    const newKeyId = state.keys[1]!.keyId;

    // The live epoch must activate, regardless of the stale row's position.
    await runActivate(
      store,
      { command: 'activate', epoch: 10, confirmAdoption: true },
      NOW,
    );

    const active = state.keys.filter((k) => k.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0]!.keyId).toBe(newKeyId);
    expect(state.delegations.find((d) => d.epoch === 10)!.activatedAt).toEqual(NOW);
    // The abandoned record is untouched.
    expect(state.delegations.find((d) => d.epoch === 9)!.activatedAt).toBeNull();
  });

  it('refuses --epoch naming an expired unactivated record, and says so', async () => {
    // Selecting by identity must not make an expired record activatable.
    const { store, state } = makeStore({
      delegations: [
        {
          epoch: 9,
          oldKeyId: 'deploy-2026-05-09-aaaaaaaa',
          newKeyId: 'deploy-abandoned',
          newPublicKeyB64: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
          notBefore: '2026-01-01T00:00:00Z',
          notAfter: '2026-02-01T00:00:00Z',
          signatureB64: 'c2ln',
          activatedAt: null,
        },
      ],
    });

    await expect(
      runActivate(
        store,
        { command: 'activate', epoch: 9, confirmAdoption: true },
        NOW,
      ),
    ).rejects.toThrow(/expired/i);
    expect(state.writes).toEqual([]);
  });

  it('refuses an --epoch that matches no prepared record', async () => {
    const { store, state } = await prepared();
    await expect(
      runActivate(
        store,
        { command: 'activate', epoch: 77, confirmAdoption: true },
        NOW,
      ),
    ).rejects.toThrow(/no prepared delegation with epoch 77/i);
    expect(state.delegations[0]!.activatedAt).toBeNull();
  });

  it('leaves everything unchanged when the activation transaction fails', async () => {
    const { store, state } = await prepared();
    state.failNextWrite = true;

    await expect(
      runActivate(
        store,
        { command: 'activate', epoch: 1, confirmAdoption: true },
        NOW,
      ),
    ).rejects.toThrow(/simulated write failure/);

    expect(state.keys.find((k) => k.status === 'active')!.keyId).toBe(
      'deploy-2026-05-09-aaaaaaaa',
    );
    expect(state.delegations[0]!.activatedAt).toBeNull();
  });
});
