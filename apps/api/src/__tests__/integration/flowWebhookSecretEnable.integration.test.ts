/**
 * #10270 "Needs Todd" 1, option (b): a webhook secret minted against a draft
 * is invalidated when a LATER draft is published. Real Postgres as breeze_app
 * under FORCE RLS, through the real services: saveDraftFlow,
 * createOrRotateWebhookSecret, enableFlow / disableFlow and ingestFlowWebhook.
 *
 *  1. Draft edited after the mint: the enable clears the secret
 *     (`webhookSecretInvalidated: true`). A delivery signed with the old
 *     secret gets the uniform 401, and a fresh mint is accepted.
 *  2. Mint after the last edit: the secret survives the enable and its
 *     deliveries are accepted.
 *  3. Re-enable with no draft change: the secret survives.
 *  4. The secret generation changes between verify and run creation (a
 *     rotation, or an enable that invalidates): the delivery verified a moment
 *     earlier is refused `409 flow_changed`, with no run.
 *  5. A draft save whose timestamp matches the mint's to the millisecond still
 *     counts as an edit.
 *
 * The validator still refuses webhook triggers until PR B (B1 lifts
 * `trigger_not_available`). This suite strips that one issue and leaves the
 * rest of validation real. Rule branches are unit-tested in
 * services/flows/versions.test.ts.
 */
import './setup';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const hooks = vi.hoisted(() => ({ beforeCreateFlowRun: null as null | (() => Promise<void>) }));

vi.mock('../../jobs/flowRunQueue', () => ({ enqueueFlowRunSlice: vi.fn(async () => 'job') }));
vi.mock('../../services/flowValidator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/flowValidator')>();
  return {
    ...actual,
    validateFlowDocument: async (...args: Parameters<typeof actual.validateFlowDocument>) => {
      const r = await actual.validateFlowDocument(...args);
      const issues = r.issues.filter((i) => i.code !== 'trigger_not_available');
      return { ...r, issues, valid: issues.every((i) => i.severity !== 'error') };
    },
  };
});
// Runs a one-shot hook between the ingress's verification and createFlowRun:
// a write committed in that window is what a concurrent request would do.
vi.mock('../../services/flows/runService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/flows/runService')>();
  return {
    ...actual,
    createFlowRun: async (...args: Parameters<typeof actual.createFlowRun>) => {
      const hook = hooks.beforeCreateFlowRun;
      hooks.beforeCreateFlowRun = null;
      if (hook) await hook();
      return actual.createFlowRun(...args);
    },
  };
});

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { flowRuns, flows } from '../../db/schema';
import { saveDraftFlow } from '../../services/flows/service';
import { disableFlow, enableFlow } from '../../services/flows/versions';
import { ingestFlowWebhook } from '../../services/flows/webhook/ingest';
import { createOrRotateWebhookSecret } from '../../services/flows/webhook/secret';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createUser,
} from './db-utils';
import { interactiveOrgAuth, orgContext } from './helpers/flowRls';

const STEP_DEFAULTS = { approval: 'default', onFailure: 'stop', timeoutSec: 300 } as const;
const DRAFT_V1 = {
  version: 1, name: 'On webhook', trigger: { type: 'webhook', auth: 'hmac' }, inputs: [],
  steps: [{ id: 'pause', tool: 'wait', input: { minutes: 1 }, ...STEP_DEFAULTS }],
};
/**
 * The edit the residual is about: content the original minter was never
 * checked against. A built-in step keeps the case independent of the core tool
 * catalog. The rule keys on the edit, not on what it adds.
 */
const DRAFT_V2 = {
  ...DRAFT_V1,
  steps: [...DRAFT_V1.steps, { id: 'pause_again', tool: 'wait', input: { minutes: 2 }, ...STEP_DEFAULTS }],
};

const ENV_KEYS = ['FLOWS_ENABLED', 'APP_ENCRYPTION_KEY_ID', 'APP_ENCRYPTION_KEYRING'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const KEY_ID = 'flowwh-enable';

beforeAll(() => {
  process.env.FLOWS_ENABLED = 'true';
});
beforeEach(() => {
  hooks.beforeCreateFlowRun = null;
  process.env.APP_ENCRYPTION_KEY_ID = KEY_ID;
  process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ [KEY_ID]: 'flowwh-enable-key-material-0123456789' });
});
afterEach(() => {
  hooks.beforeCreateFlowRun = null;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  process.env.FLOWS_ENABLED = 'true';
});
afterAll(() => {
  if (savedEnv.FLOWS_ENABLED === undefined) delete process.env.FLOWS_ENABLED;
  else process.env.FLOWS_ENABLED = savedEnv.FLOWS_ENABLED;
});

const UNAUTHORIZED = { http: 401, body: { error: 'Unauthorized' } };

/** An org with one interactive user holding an org role, and a draft webhook flow at definition_version 1. */
async function setup() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `wh-enable-${randomUUID()}@flows.test` });
  await assignUserToOrganization(user.id, org.id, role.id);
  const [flow] = await withSystemDbAccessContext(() => db.insert(flows).values({
    orgId: org.id,
    slug: `wh_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    name: DRAFT_V1.name,
    definition: DRAFT_V1,
    effectiveTier: 1,
  }).returning({ id: flows.id }));
  const ctx = orgContext(org.id, partner.id, user.id);
  const auth = interactiveOrgAuth(org.id, partner.id, user);
  const as = <T>(fn: () => Promise<T>) => withDbAccessContext(ctx, fn);
  const flowId = flow!.id;

  async function mint(): Promise<string> {
    const r = await as(() => createOrRotateWebhookSecret(auth, flowId));
    if (!r.ok) throw new Error(`mint refused: ${JSON.stringify(r)}`);
    return r.secret;
  }
  async function edit(document: Record<string, unknown>, expectedVersion: number): Promise<void> {
    const r = await as(() => saveDraftFlow(auth, { document, flowId, expectedVersion }));
    if (!r.saved) throw new Error(`draft save refused: ${JSON.stringify(r)}`);
  }
  const enable = (expectedVersion: number) => as(() => enableFlow(auth, flowId, { expectedVersion, preApprovedStepIds: [] }));
  const disable = () => as(() => disableFlow(auth, flowId));
  const row = () => withSystemDbAccessContext(async () => (await db.select().from(flows).where(eq(flows.id, flowId)))[0]!);
  const runs = () => withSystemDbAccessContext(() => db.select({ id: flowRuns.id }).from(flowRuns).where(eq(flowRuns.flowId, flowId)));
  return { flowId, mint, edit, enable, disable, row, runs };
}

function deliver(flowId: string, secret: string) {
  const body = JSON.stringify({ event: 'ticket.created', nonce: randomUUID() });
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  return ingestFlowWebhook({
    flowId,
    rawBody: body,
    headers: new Headers({ 'content-type': 'application/json', 'x-breeze-timestamp': ts, 'x-breeze-signature': signature }),
    receivedAt: new Date(),
    clientIp: '198.51.100.9',
  });
}

describe('webhook secret binding at enable (#10270 option b, real Postgres)', () => {
  it('a draft edited after the mint: the enable invalidates the secret, its deliveries get the uniform 401, and a fresh mint is accepted', async () => {
    const f = await setup();
    const stale = await f.mint();
    await f.edit(DRAFT_V2, 1);

    const r = await f.enable(2);
    expect(r).toMatchObject({ ok: true, webhookSecretInvalidated: true, publication: { publicationSeq: 1, definitionVersion: 2 } });
    expect(await f.row()).toMatchObject({
      status: 'enabled', webhookSecretEncrypted: null, webhookSecretFingerprint: null, webhookSecretRotatedAt: null,
    });
    if (r.ok) expect(r.flow.webhook).toMatchObject({ secretFingerprint: null, secretRotatedAt: null });

    expect(await deliver(f.flowId, stale)).toEqual(UNAUTHORIZED);
    expect(await f.runs()).toHaveLength(0);

    const fresh = await f.mint();
    expect(await deliver(f.flowId, fresh)).toMatchObject({ http: 202, body: { status: 'accepted' } });
    expect(await deliver(f.flowId, stale)).toEqual(UNAUTHORIZED);
    expect(await f.runs()).toHaveLength(1);
  });

  it('a draft save stamped in the same millisecond as the mint still invalidates at enable (no timestamp collision keeps the secret)', async () => {
    const f = await setup();
    const stale = await f.mint();
    const minted = (await f.row()).webhookSecretRotatedAt!;
    // The save computes its timestamp before it can wait on the mint's row lock, so
    // on a busy host (or another API instance) the two can coincide to the millisecond.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(minted);
    try {
      await f.edit(DRAFT_V2, 1);
    } finally {
      vi.useRealTimers();
    }
    expect((await f.row()).updatedAt.getTime()).toBeGreaterThan(minted.getTime());

    expect(await f.enable(2)).toMatchObject({ ok: true, webhookSecretInvalidated: true });
    expect(await deliver(f.flowId, stale)).toEqual(UNAUTHORIZED);
  });

  it('a secret minted after the last draft edit survives the enable and its deliveries are accepted', async () => {
    const f = await setup();
    await f.edit(DRAFT_V2, 1);
    const secret = await f.mint();
    const before = await f.row();

    const r = await f.enable(2);
    expect(r).toMatchObject({ ok: true, webhookSecretInvalidated: false });
    const after = await f.row();
    expect(after.webhookSecretFingerprint).toBe(before.webhookSecretFingerprint);
    expect(after.webhookSecretRotatedAt?.getTime()).toBe(before.webhookSecretRotatedAt?.getTime());

    expect(await deliver(f.flowId, secret)).toMatchObject({ http: 202, body: { status: 'accepted' } });
  });

  it('re-enable with no draft change keeps the secret, even though the enable and the disable wrote the row since the mint', async () => {
    const f = await setup();
    const secret = await f.mint();
    expect(await f.enable(1)).toMatchObject({ ok: true, webhookSecretInvalidated: false });
    expect((await f.disable()).ok).toBe(true);

    const again = await f.enable(1);
    expect(again).toMatchObject({ ok: true, webhookSecretInvalidated: false, publication: { publicationSeq: 2 } });
    expect(await deliver(f.flowId, secret)).toMatchObject({ http: 202, body: { status: 'accepted' } });
  });

  it('control: an edit after the FIRST publication still invalidates a secret that survived it', async () => {
    const f = await setup();
    const secret = await f.mint();
    expect(await f.enable(1)).toMatchObject({ ok: true, webhookSecretInvalidated: false });
    expect((await f.disable()).ok).toBe(true);
    await f.edit(DRAFT_V2, 1);

    expect(await f.enable(2)).toMatchObject({ ok: true, webhookSecretInvalidated: true });
    expect(await deliver(f.flowId, secret)).toEqual(UNAUTHORIZED);
  });

  it('a rotation between verification and run creation refuses the verified delivery 409 flow_changed, with no run', async () => {
    const f = await setup();
    const first = await f.mint();
    expect(await f.enable(1)).toMatchObject({ ok: true, webhookSecretInvalidated: false });

    let second = '';
    hooks.beforeCreateFlowRun = async () => { second = await f.mint(); };
    expect(await deliver(f.flowId, first)).toEqual({ http: 409, body: { status: 'refused', code: 'flow_changed' } });
    expect(second).not.toBe('');
    expect(await f.runs()).toHaveLength(0);

    expect(await deliver(f.flowId, first)).toEqual(UNAUTHORIZED);
    expect(await deliver(f.flowId, second)).toMatchObject({ http: 202, body: { status: 'accepted' } });
  });

  // The new publication (seq 1 -> 2) is what refuses here; the rotated_at
  // binding on its own is the rotation case above.
  it('an enable that invalidates the secret between verification and run creation refuses the verified delivery 409 flow_changed', async () => {
    const f = await setup();
    const secret = await f.mint();
    expect(await f.enable(1)).toMatchObject({ ok: true, webhookSecretInvalidated: false });

    hooks.beforeCreateFlowRun = async () => {
      expect((await f.disable()).ok).toBe(true);
      await f.edit(DRAFT_V2, 1);
      expect(await f.enable(2)).toMatchObject({ ok: true, webhookSecretInvalidated: true });
    };
    expect(await deliver(f.flowId, secret)).toEqual({ http: 409, body: { status: 'refused', code: 'flow_changed' } });
    expect(await f.runs()).toHaveLength(0);
    expect(await deliver(f.flowId, secret)).toEqual(UNAUTHORIZED);
  });
});
