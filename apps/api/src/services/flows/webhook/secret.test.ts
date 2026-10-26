import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../middleware/auth';

/**
 * Tool Catalog W05 (#5220) Task A5 — the per-flow webhook secret: row-bound
 * encryption, reveal-once create/rotate, partner-wide gate, audit without the
 * secret. Real secretCrypto (v3, row-bound AAD); the SQL boundary is a fake.
 */

const { selects, updates, calls } = vi.hoisted(() => {
  process.env.APP_ENCRYPTION_KEY = 'w5-webhook-secret-test-key-material-0123456789';
  process.env.APP_ENCRYPTION_KEY_ID = 'w5test';
  return { selects: [] as unknown[][], updates: [] as unknown[][], calls: [] as Array<{ kind: string; ops: Array<{ op: string; args: unknown[] }> }> };
});

vi.mock('../../../db', () => {
  const chain = (kind: 'select' | 'update') => {
    const rec = { kind, ops: [] as Array<{ op: string; args: unknown[] }> };
    calls.push(rec);
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const value = (kind === 'select' ? selects : updates).shift() ?? [];
          return (res: (v: unknown) => void) => Promise.resolve(value).then(res);
        }
        return (...args: unknown[]) => { rec.ops.push({ op: String(prop), args }); return proxy; };
      },
    });
    return proxy;
  };
  return { db: { select: () => chain('select'), update: () => chain('update') } };
});
vi.mock('../../auditEvents', () => ({ writeAuditEvent: vi.fn(), requestLikeFromSnapshot: () => ({}) }));
vi.mock('../../partnerWideAccess', () => ({ canManagePartnerWidePolicies: vi.fn() }));

import { writeAuditEvent } from '../../auditEvents';
import { canManagePartnerWidePolicies } from '../../partnerWideAccess';
import { createOrRotateWebhookSecret, decryptFlowWebhookSecret, encryptFlowWebhookSecret } from './secret';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const FLOW_A = '33333333-3333-4333-8333-333333333333';
const FLOW_B = '33333333-3333-4333-8333-444444444444';
const USER = '44444444-4444-4444-8444-444444444444';

const WEBHOOK_DOC = { version: 1, name: 'Inbound', trigger: { type: 'webhook', auth: 'hmac' }, inputs: [], steps: [] };

function flowRow(over: Record<string, unknown> = {}) {
  return { id: FLOW_A, orgId: ORG, partnerId: null, name: 'Inbound', definition: WEBHOOK_DOC, webhookSecretFingerprint: null, ...over };
}
function auth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' }, scope: 'organization', orgId: ORG, partnerId: PARTNER, partnerOrgAccess: null,
    accessibleOrgIds: [ORG], canAccessOrg: (id: string) => id === ORG, user: { id: USER, email: 'u@example.com' }, ...over,
  } as unknown as AuthContext;
}
const setOf = (rec: { ops: Array<{ op: string; args: unknown[] }> }) => rec.ops.find((o) => o.op === 'set')!.args[0] as Record<string, unknown>;

beforeEach(() => {
  selects.length = 0;
  updates.length = 0;
  calls.length = 0;
  vi.mocked(writeAuditEvent).mockReset();
  vi.mocked(canManagePartnerWidePolicies).mockReset().mockReturnValue(true);
});

describe('flow webhook secret encryption', () => {
  it('round-trips under the flow row', () => {
    const sealed = encryptFlowWebhookSecret(FLOW_A, 'bwh_abc');
    expect(sealed).toMatch(/^enc:v3:w5test:/);
    expect(decryptFlowWebhookSecret({ id: FLOW_A, webhookSecretEncrypted: sealed })).toBe('bwh_abc');
  });

  it('ciphertext of flow A does not decrypt as flow B', () => {
    const sealed = encryptFlowWebhookSecret(FLOW_A, 'bwh_abc');
    expect(() => decryptFlowWebhookSecret({ id: FLOW_B, webhookSecretEncrypted: sealed })).toThrow();
  });

  it('no stored secret is null, and a plaintext column value is never accepted as a secret', () => {
    expect(decryptFlowWebhookSecret({ id: FLOW_A, webhookSecretEncrypted: null })).toBeNull();
    expect(decryptFlowWebhookSecret({ id: FLOW_A, webhookSecretEncrypted: 'bwh_plain' })).toBeNull();
  });
});

describe('createOrRotateWebhookSecret', () => {
  it('creates a reveal-once secret, stores only ciphertext and fingerprint', async () => {
    selects.push([flowRow()]);
    updates.push([{ id: FLOW_A }]);
    const r = await createOrRotateWebhookSecret(auth(), FLOW_A);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.secret).toMatch(/^bwh_[A-Za-z0-9_-]{43}$/);
    const set = setOf(calls.find((c) => c.kind === 'update')!);
    expect(set.webhookSecretEncrypted).toMatch(/^enc:v3:/);
    expect(set.webhookSecretEncrypted).not.toContain(r.secret);
    expect(set.webhookSecretFingerprint).toBe(r.fingerprint);
    expect(set.webhookSecretRotatedAt).toBeInstanceOf(Date);
    expect(decryptFlowWebhookSecret({ id: FLOW_A, webhookSecretEncrypted: set.webhookSecretEncrypted as string })).toBe(r.secret);
  });

  it('rotation replaces ciphertext and fingerprint', async () => {
    selects.push([flowRow()], [flowRow({ webhookSecretFingerprint: 'fp-old' })]);
    updates.push([{ id: FLOW_A }], [{ id: FLOW_A }]);
    const first = await createOrRotateWebhookSecret(auth(), FLOW_A);
    const second = await createOrRotateWebhookSecret(auth(), FLOW_A);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.secret).not.toBe(first.secret);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    const [s1, s2] = calls.filter((c) => c.kind === 'update').map(setOf);
    expect(s2!.webhookSecretEncrypted).not.toBe(s1!.webhookSecretEncrypted);
  });

  it('api key cannot rotate', async () => {
    const r = await createOrRotateWebhookSecret(auth({ principal: { kind: 'api_key', apiKeyId: 'k' } } as Partial<AuthContext>), FLOW_A);
    expect(r).toEqual({ ok: false, error: 'interactive_session_required' });
    expect(calls).toHaveLength(0);
  });

  it('partner-wide rotate needs canManagePartnerWidePolicies', async () => {
    const partner = auth({ scope: 'partner', orgId: null, partnerOrgAccess: 'all' } as Partial<AuthContext>);
    vi.mocked(canManagePartnerWidePolicies).mockReturnValue(false);
    selects.push([flowRow({ orgId: null, partnerId: PARTNER })]);
    expect(await createOrRotateWebhookSecret(partner, FLOW_A)).toEqual({ ok: false, error: 'partner_wide_forbidden' });
    expect(calls.some((c) => c.kind === 'update')).toBe(false);

    vi.mocked(canManagePartnerWidePolicies).mockReturnValue(true);
    selects.push([flowRow({ orgId: null, partnerId: PARTNER })]);
    updates.push([{ id: FLOW_A }]);
    expect((await createOrRotateWebhookSecret(partner, FLOW_A)).ok).toBe(true);
  });

  it('an org token never rotates a partner-wide flow it can read (not found)', async () => {
    selects.push([flowRow({ orgId: null, partnerId: PARTNER })]);
    expect(await createOrRotateWebhookSecret(auth(), FLOW_A)).toEqual({ ok: false, error: 'flow_not_found' });
  });

  it('non-webhook flow is not_webhook', async () => {
    selects.push([flowRow({ definition: { ...WEBHOOK_DOC, trigger: { type: 'manual' } } })]);
    expect(await createOrRotateWebhookSecret(auth(), FLOW_A)).toEqual({ ok: false, error: 'not_webhook' });
    expect(calls.some((c) => c.kind === 'update')).toBe(false);
  });

  it('a flow the caller cannot write is flow_not_found', async () => {
    selects.push([]);
    expect(await createOrRotateWebhookSecret(auth(), FLOW_A)).toEqual({ ok: false, error: 'flow_not_found' });
  });

  it('audit never contains the secret', async () => {
    selects.push([flowRow()]);
    updates.push([{ id: FLOW_A }]);
    const r = await createOrRotateWebhookSecret(auth(), FLOW_A);
    if (!r.ok) throw new Error('expected ok');
    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    const event = vi.mocked(writeAuditEvent).mock.calls[0]![1];
    expect(event).toMatchObject({ action: 'flow.webhook_secret.rotate', resourceId: FLOW_A, details: { flowId: FLOW_A, fingerprint: r.fingerprint } });
    const serialized = JSON.stringify(vi.mocked(writeAuditEvent).mock.calls);
    expect(serialized).not.toContain(r.secret);
    expect(serialized).not.toContain('enc:v3:');
  });
});
