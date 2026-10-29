/**
 * Tool Catalog W06 (#5221) Task B3 — the conversion switch on REAL Postgres as
 * `breeze_app` under FORCE RLS, through the real services: the conversion
 * ledger, the normal script-create path, saveDraftFlow, the webhook secret
 * service, enableFlow (validation, rule 7, the fleet lane) and B2's legacy
 * loader. What only a database can show:
 *
 *  - the switch is ONE transaction: a refusal from enableFlow, after the
 *    generated scripts, the draft rewrite and the carried webhook secret were
 *    written, leaves none of them and leaves the ledger and the Job untouched;
 *  - the switched row has exactly the shape B2's legacy loader looks for, and
 *    `switch_at` is exactly SWITCH_LEAD_MS after `switched_at`;
 *  - the owner axis stays the Job's (org Job, partner-wide Job);
 *  - generated scripts exist only in the switch transaction, so enable's
 *    script reads go through that transaction (`scriptReadExecutor`): the
 *    owner predicate still refuses a foreign script there, and the fleet
 *    binding digest equals the one the run path recomputes in system context;
 *  - lock order automation → flow → ledger: a concurrent Job edit and a switch
 *    never deadlock.
 *
 * Mocked: only the flow-run slice enqueue (a slice is driven directly).
 * All tenants are synthetic.
 */
import { getTestDb } from './setup';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { eq, like, sql } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { Hono } from 'hono';
import { SWITCH_LEAD_MS, type ConversionSwitchRequest } from '@breeze/shared';

vi.mock('../../jobs/flowRunQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../jobs/flowRunQueue')>()),
  enqueueFlowRunSlice: vi.fn(async () => 'job'),
}));

import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  automations,
  flowAutomationConversions,
  flowRuns,
  flowRunSteps,
  flows,
  flowVersions,
  organizationUsers,
  scripts,
} from '../../db/schema';
import type { FlowRunJobData } from '../../jobs/queueSchemas';
import { processFlowRunJob } from '../../jobs/flowRunner';
import { buildRunScriptSnapshot } from '../../services/actionIntents/runScriptSnapshot';
import { validateFlowDocument } from '../../services/flowValidator';
import { legacyPrefers, loadSwitchedConvertedAutomations } from '../../services/flows/conversion/claims';
import { automationSourceDigest, generatedScriptPlaceholderId } from '../../services/flows/conversion/convertAutomation';
import { createConversion } from '../../services/flows/conversion/service';
import { getFlow, saveDraftFlow } from '../../services/flows/service';
import { flowDocumentDigest, resetShadowIfChanged } from '../../services/flows/conversion/ledger';
import { switchConversion } from '../../services/flows/conversion/switch';
import { revertConversion } from '../../services/flows/conversion/revert';
import { automationRoutes } from '../../routes/automations';
import { createAccessToken } from '../../services/jwt';
import { fleetScriptMaterialFromSnapshot } from '../../services/flows/fleetPreApproval';
import { assessPreApprovals } from '../../services/flows/preApproval';
import { startManualRun } from '../../services/flows/runService';
import { enableFlow } from '../../services/flows/versions';
import { decryptFlowWebhookSecret } from '../../services/flows/webhook/secret';
import { verifyFlowWebhook } from '../../services/flows/webhook/verify';
import { encryptSecret } from '../../services/secretCrypto';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createDevice,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { interactiveOrgAuth, interactivePartnerAuth, orgContext, partnerContext } from './helpers/flowRls';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const ENV_KEYS = ['FLOWS_ENABLED'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.FLOWS_ENABLED = 'true';
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

const PERMS = [
  { resource: 'automations', action: 'read' },
  { resource: 'automations', action: 'write' },
  { resource: 'scripts', action: 'read' },
  { resource: 'scripts', action: 'write' },
  { resource: 'scripts', action: 'execute' },
  { resource: 'devices', action: 'read' },
];

async function tenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const sibling = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const otherSite = await createSite({ orgId: org.id });
  const orgRole = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
  await grantRolePermissions(orgRole.id, PERMS);
  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(partnerRole.id, PERMS);

  const member = async (label: string, siteIds?: string[]) => {
    const u = await createUser({ partnerId: partner.id, orgId: org.id, email: `sw-${label}-${randomUUID()}@switch.test` });
    await assignUserToOrganization(u.id, org.id, orgRole.id);
    if (siteIds) {
      await system(() => db.update(organizationUsers).set({ siteIds }).where(eq(organizationUsers.userId, u.id)));
    }
    return { id: u.id, email: u.email };
  };
  const partnerMember = async (label: string, access: 'all' | 'selected' = 'all') => {
    const u = await createUser({ partnerId: partner.id, email: `sw-${label}-${randomUUID()}@switch.test` });
    await assignUserToPartner(u.id, partner.id, partnerRole.id, access);
    return { id: u.id, email: u.email };
  };

  const switcher = await member('switcher');
  const creator = await member('creator');
  const partnerSwitcher = await partnerMember('pswitcher');
  const partnerCreator = await partnerMember('pcreator');
  const device = await createDevice({ orgId: org.id, siteId: site!.id });
  const [siblingScript] = await system(() => db.insert(scripts).values({
    orgId: sibling.id, partnerId: partner.id, name: `sib-${randomUUID().slice(0, 6)}`, language: 'powershell', content: 'Write-Output sibling',
    osTypes: ['windows'], runAs: 'system', timeoutSeconds: 60,
  }).returning({ id: scripts.id }));

  return {
    partnerId: partner.id,
    orgId: org.id,
    siblingId: sibling.id,
    siteId: site!.id,
    otherSiteId: otherSite!.id,
    orgRoleId: orgRole.id,
    partnerRoleId: partnerRole.id,
    deviceId: device.id,
    siblingScriptId: siblingScript!.id,
    switcher,
    creator,
    partnerSwitcher,
    partnerCreator,
    member,
    partnerMember,
    orgAuth: (u: { id: string; email: string } = switcher) => interactiveOrgAuth(org.id, partner.id, u, orgRole.id),
    partnerAuth: (u: { id: string; email: string } = partnerSwitcher, access: 'all' | 'selected' = 'all') =>
      interactivePartnerAuth(partner.id, [org.id, sibling.id], u, access, partnerRole.id),
    asOrg: <T>(fn: () => Promise<T>, u: { id: string } = switcher) => withDbAccessContext(orgContext(org.id, partner.id, u.id), fn),
    asPartner: <T>(fn: () => Promise<T>, u: { id: string } = partnerSwitcher) =>
      withDbAccessContext(partnerContext(partner.id, [org.id, sibling.id], u.id), fn),
  };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

const COMMAND = 'Write-Output "héllo — world"\r\n  Get-Date   \n\t# trailing  ';

async function job(t: Tenant, values: Partial<typeof automations.$inferInsert>) {
  const [row] = await system(() => db.insert(automations).values({
    orgId: t.orgId,
    name: `Nightly ${randomUUID().slice(0, 6)}`,
    trigger: { type: 'schedule', cronExpression: '0 3 * * *', timezone: 'UTC' },
    conditions: { type: 'devices', deviceIds: [t.deviceId] },
    actions: [{ type: 'execute_command', command: COMMAND, shell: 'powershell', whenOffline: 'queue' }],
    onFailure: 'stop',
    createdBy: t.creator.id,
    ...values,
  } as typeof automations.$inferInsert).returning());
  return row!;
}

type AutomationRow = Awaited<ReturnType<typeof job>>;

/**
 * A shadow conversion through the real createConversion (as the Job's owner
 * side: an org Job by the org user, a partner-wide Job by the partner user),
 * then aged and counted as the case needs.
 */
async function converted(t: Tenant, row: AutomationRow, o: { ageMs?: number; runs?: number; divergences?: number } = {}) {
  const create = { expectedSourceDigest: automationSourceDigest(row) };
  const r = row.orgId
    ? await t.asOrg(() => createConversion(t.orgAuth(), row.id, create))
    : await t.asPartner(() => createConversion(t.partnerAuth(), row.id, create));
  if (!r.ok) throw new Error(`createConversion refused: ${JSON.stringify(r)}`);
  await system(() => db.update(flowAutomationConversions).set({
    shadowRuns: o.runs ?? 5,
    shadowDivergences: o.divergences ?? 0,
    shadowStartedAt: new Date(Date.now() - (o.ageMs ?? 8 * 86_400_000)),
  }).where(eq(flowAutomationConversions.id, r.conversion.id)));
  return { conversionId: r.conversion.id, flowId: r.conversion.flowId, findings: r.conversion.findings };
}

const req = (over: Partial<ConversionSwitchRequest> = {}): ConversionSwitchRequest => ({
  expectedFlowVersion: 1,
  preApprovals: [],
  acceptScopeWidening: false,
  acceptDelegatorLifecycle: true,
  acknowledgeDivergence: false,
  ...over,
});

const ledgerRow = (id: string) => system(async () => (await db.select().from(flowAutomationConversions).where(eq(flowAutomationConversions.id, id)))[0]!);
const flowRow = (id: string) => system(async () => (await db.select().from(flows).where(eq(flows.id, id)))[0]!);
const automationRow = (id: string) => system(async () => (await db.select().from(automations).where(eq(automations.id, id)))[0]!);
const generatedScripts = (row: AutomationRow) => system(() => db.select().from(scripts)
  .where(like(scripts.name, `Moved from Job "${row.name}"%`)));
const publicationsOf = (flowId: string) => system(() => db.select().from(flowVersions).where(eq(flowVersions.flowId, flowId)));

function scriptIdOf(definition: unknown, stepId: string): string {
  const steps = (definition as { steps: Array<{ id: string; input: { scriptId?: string } }> }).steps;
  return steps.find((s) => s.id === stepId)!.input.scriptId!;
}

describe('flow conversion switch (real Postgres, #5221 B3)', () => {
  runDb('switch is one transaction and switch_at is 60 s ahead; the legacy loader then treats the row as switched', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const s = await converted(t, row, {});

    const r = await t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req()));
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const ledger = await ledgerRow(s.conversionId);
    expect(ledger).toMatchObject({ state: 'switched', switchedBy: t.switcher.id, divergenceAcknowledged: false, scopeWideningAccepted: false });
    expect(ledger.switchAt!.getTime() - ledger.switchedAt!.getTime()).toBe(SWITCH_LEAD_MS);
    // The shadow evidence the gate judged is kept, not reset by the draft rewrite.
    expect(ledger.shadowRuns).toBe(5);

    const automation = await automationRow(row.id);
    expect(automation).toMatchObject({ enabled: false, retiredReason: 'converted_to_flow', convertedToFlowId: s.flowId });
    expect(automation.retiredAt).toBeInstanceOf(Date);

    const flow = await flowRow(s.flowId);
    // The delegator is the switching user, never the Job's creator.
    expect(flow).toMatchObject({ status: 'enabled', enabledByUserId: t.switcher.id, orgId: t.orgId, partnerId: null });
    const [publication] = await publicationsOf(s.flowId);
    expect(publication).toMatchObject({ enabledByUserId: t.switcher.id, definitionVersion: flow.definitionVersion });
    expect(ledger.documentDigest).toBe(flowDocumentDigest(flow.definition));

    // B2's legacy loader finds exactly this row, switched, and prefers legacy only before switch_at.
    const loaded = await system(() => loadSwitchedConvertedAutomations(db, eq(automations.id, row.id)));
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.conversion).toEqual({ id: s.conversionId, state: 'switched', switchAt: ledger.switchAt });
    expect(legacyPrefers(loaded[0]!.conversion, new Date(ledger.switchAt!.getTime() - 1), false)).toBe(true);
    expect(legacyPrefers(loaded[0]!.conversion, ledger.switchAt, false)).toBe(false);

    // C3: the flow detail names the Job it moved from, read in the caller's context.
    const detail = await t.asOrg(() => getFlow(t.orgAuth(), s.flowId));
    expect(detail?.flow.convertedFrom).toEqual({
      automationId: row.id, name: automation.name, conversionId: s.conversionId, state: 'switched',
    });
  });

  runDb('enable refusal rolls back scripts, secret and ledger', async () => {
    const t = await tenant();
    const row = await job(t, { trigger: { type: 'webhook', secret: encryptSecret('legacy-s3cret') } });
    const s = await converted(t, row, {});
    const before = await ledgerRow(s.conversionId);

    // A step id the document does not have: enableFlow refuses AFTER the
    // switch created the generated script, rewrote the draft and carried the secret.
    const r = await t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req({ preApprovals: [{ stepId: 'not_a_step', maxTargets: 1 }] })));
    expect(r).toMatchObject({ ok: false, error: 'invalid' });

    expect(await generatedScripts(row)).toEqual([]);
    const flow = await flowRow(s.flowId);
    expect(flow).toMatchObject({
      status: 'draft', definitionVersion: 1, webhookSecretEncrypted: null, webhookSecretFingerprint: null, webhookSecretRotatedAt: null,
    });
    expect(await publicationsOf(s.flowId)).toEqual([]);
    expect(await ledgerRow(s.conversionId)).toEqual(before);
    expect(await automationRow(row.id)).toMatchObject({ enabled: true, retiredAt: null, retiredReason: null, convertedToFlowId: null });
  });

  runDb('site-limited user cannot switch', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const s = await converted(t, row, {});

    // A site ceiling on the membership…
    const limited = await t.member('limited', [t.siteId]);
    expect(await t.asOrg(() => switchConversion(t.orgAuth(limited), s.conversionId, req()), limited))
      .toEqual({ ok: false, error: 'delegation_scope_restricted' });
    // …or on the token.
    const tokenLimited = { ...t.orgAuth(), allowedSiteIds: [t.siteId] } as ReturnType<Tenant['orgAuth']>;
    expect(await t.asOrg(() => switchConversion(tokenLimited, s.conversionId, req())))
      .toEqual({ ok: false, error: 'delegation_scope_restricted' });

    expect(await generatedScripts(row)).toEqual([]);
    expect((await ledgerRow(s.conversionId)).state).toBe('shadow');
  });

  runDb("owner axis is the automation's", async () => {
    const t = await tenant();
    // Org Job → org flow, org script.
    const orgJob = await job(t, {});
    const so = await converted(t, orgJob, {});
    const ro = await t.asOrg(() => switchConversion(t.orgAuth(), so.conversionId, req()));
    expect(ro.ok, JSON.stringify(ro)).toBe(true);
    expect(await flowRow(so.flowId)).toMatchObject({ orgId: t.orgId, partnerId: null });
    expect((await generatedScripts(orgJob)).map((x) => [x.orgId, x.partnerId])).toEqual([[t.orgId, t.partnerId]]);

    // Partner-wide Job → partner-wide flow and script; the delegator is the partner user.
    const pwJob = await job(t, {
      orgId: null, partnerId: t.partnerId, conditions: [], createdBy: t.partnerCreator.id,
    });
    const sp = await converted(t, pwJob, {});

    // A selected-access partner user is refused before anything is written.
    const selected = await t.partnerMember('selected', 'selected');
    expect(await t.asPartner(() => switchConversion(t.partnerAuth(selected, 'selected'), sp.conversionId, req()), selected))
      .toEqual({ ok: false, error: 'partner_wide_forbidden' });
    // An org token does not see a partner-wide conversion at all.
    expect(await t.asOrg(() => switchConversion(t.orgAuth(), sp.conversionId, req())))
      .toEqual({ ok: false, error: 'conversion_not_found' });

    const rp = await t.asPartner(() => switchConversion(t.partnerAuth(), sp.conversionId, req()));
    expect(rp.ok, JSON.stringify(rp)).toBe(true);
    expect(await flowRow(sp.flowId)).toMatchObject({ orgId: null, partnerId: t.partnerId, enabledByUserId: t.partnerSwitcher.id });
    expect((await generatedScripts(pwJob)).map((x) => [x.orgId, x.partnerId])).toEqual([[null, t.partnerId]]);
    expect(await ledgerRow(sp.conversionId)).toMatchObject({ orgId: null, partnerId: t.partnerId, state: 'switched' });
    expect(await automationRow(pwJob.id)).toMatchObject({ orgId: null, partnerId: t.partnerId, convertedToFlowId: sp.flowId });
  });

  runDb('edited source refuses switch', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const s = await converted(t, row, {});
    await system(() => db.update(automations)
      .set({ actions: [{ type: 'execute_command', command: 'Get-Service', shell: 'powershell', whenOffline: 'queue' }] })
      .where(eq(automations.id, row.id)));
    expect(await t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req({ acknowledgeDivergence: true }))))
      .toEqual({ ok: false, error: 'source_changed' });
    expect(await generatedScripts(row)).toEqual([]);
  });

  runDb('shadow younger than 10 min refuses even with acknowledgement', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const s = await converted(t, row, { ageMs: 9 * 60_000, runs: 0 });
    expect(await t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req({ acknowledgeDivergence: true }))))
      .toEqual({ ok: false, error: 'shadow_too_new' });

    // Older than 10 min but short of the gate: only an acknowledgement switches, and it is recorded.
    const row2 = await job(t, {});
    const s2 = await converted(t, row2, { ageMs: 11 * 60_000, runs: 1, divergences: 1 });
    expect(await t.asOrg(() => switchConversion(t.orgAuth(), s2.conversionId, req())))
      .toEqual({ ok: false, error: 'shadow_divergent' });
    const r = await t.asOrg(() => switchConversion(t.orgAuth(), s2.conversionId, req({ acknowledgeDivergence: true })));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await ledgerRow(s2.conversionId)).toMatchObject({ state: 'switched', divergenceAcknowledged: true });
  });

  runDb('scope widening needs acceptance', async () => {
    const t = await tenant();
    const limitedCreator = await t.member('limited-creator', [t.siteId]);
    const row = await job(t, { createdBy: limitedCreator.id });
    const s = await converted(t, row, {});
    expect(s.findings.map((f) => f.code)).toContain('site_ceiling_removed');

    expect(await t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req())))
      .toEqual({ ok: false, error: 'scope_widening_not_accepted' });
    expect(await generatedScripts(row)).toEqual([]);

    const r = await t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req({ acceptScopeWidening: true })));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await ledgerRow(s.conversionId)).toMatchObject({ state: 'switched', scopeWideningAccepted: true });
  });

  runDb('pre-approvals are unticked unless sent', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const s = await converted(t, row, {});
    const r = await t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req()));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const [publication] = await publicationsOf(s.flowId);
    expect(publication!.preApprovals).toEqual([]);

    const row2 = await job(t, {});
    const s2 = await converted(t, row2, {});
    const r2 = await t.asOrg(() => switchConversion(t.orgAuth(), s2.conversionId, req({ preApprovals: [{ stepId: 'a0_command', maxTargets: 3 }] })));
    expect(r2.ok, JSON.stringify(r2)).toBe(true);
    const [publication2] = await publicationsOf(s2.flowId);
    expect((publication2!.preApprovals as Array<{ stepId: string; maxTargets: number }>).map((b) => [b.stepId, b.maxTargets])).toEqual([['a0_command', 3]]);
  });

  runDb('generated script body equals the command', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const s = await converted(t, row, {});
    const r = await t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req()));
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const [script, ...more] = await generatedScripts(row);
    expect(more).toEqual([]);
    expect(script!.content).toBe(COMMAND);
    expect(Buffer.from(script!.content, 'utf8').equals(Buffer.from(COMMAND, 'utf8'))).toBe(true);
    expect(script).toMatchObject({
      name: `Moved from Job "${row.name}" — command 1`, language: 'powershell', runAs: 'system',
      createdBy: t.switcher.id, orgId: t.orgId, isSystem: false,
    });
    // The published draft names the generated script, not the placeholder.
    const flow = await flowRow(s.flowId);
    expect(scriptIdOf(flow.definition, 'a0_command')).toBe(script!.id);
  });

  runDb("fleet pre-approval binds the generated script's digest, and the run path's system-context recompute agrees", async () => {
    const t = await tenant();
    const row = await job(t, { trigger: { type: 'manual' } });
    const s = await converted(t, row, {});
    const r = await t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req({ preApprovals: [{ stepId: 'a0_command', maxTargets: 5 }] })));
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const [script] = await generatedScripts(row);
    const [publication] = await publicationsOf(s.flowId);
    const [binding] = publication!.preApprovals as Array<{ scriptId: string; scriptMaterialSha256: string; stepId: string }>;
    expect(binding).toMatchObject({ stepId: 'a0_command', scriptId: script!.id });

    // The release worker's recompute: system context, the real device.
    const step = (publication!.definition as { steps: Array<{ id: string; input: Record<string, unknown> }> }).steps.find((x) => x.id === 'a0_command')!;
    const built = await system(() => buildRunScriptSnapshot({ scriptId: script!.id, deviceIds: [t.deviceId] }, db));
    if (built.kind !== 'snapshot') throw new Error(built.kind);
    expect(fleetScriptMaterialFromSnapshot(built.snapshot, step.input).scriptMaterialSha256).toBe(binding!.scriptMaterialSha256);

    // And end to end: a UI run honours the pre-approval (any drift would fail it binding_drift).
    const started = await t.asOrg(() => startManualRun(t.orgAuth(), s.flowId, { inputs: {} }, 'ui'));
    if (!started.ok) throw new Error(JSON.stringify(started));
    await processFlowRunJob({ id: `it-${randomUUID()}`, name: 'flow-run-slice', data: { runId: started.runId } } as unknown as Job<FlowRunJobData>);
    const [run] = await system(() => db.select().from(flowRuns).where(eq(flowRuns.id, started.runId)));
    expect(run, JSON.stringify({ error: run?.error, code: run?.errorCode })).toMatchObject({ status: 'completed', errorCode: null });
    const head = (await system(() => db.select().from(flowRunSteps).where(eq(flowRunSteps.runId, started.runId))))
      .find((x) => x.stepId === 'a0_command' && x.itemIndex === null)!;
    expect(head).toMatchObject({ status: 'completed', approvalMode: 'pre_approved' });
  });

  runDb('carried secret verifies the old signature and survives enable', async () => {
    const t = await tenant();
    const legacySecret = `legacy-${randomUUID()}`;
    const row = await job(t, { trigger: { type: 'webhook', secret: encryptSecret(legacySecret) } });
    const s = await converted(t, row, {});

    // What the sender signs today, with the secret it already has.
    const body = JSON.stringify({ hello: 'world' });
    const ts = String(Date.now());
    const signature = `sha256=${createHmac('sha256', legacySecret).update(`${ts}.${body}`).digest('hex')}`;

    const r = await t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req()));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.webhookSecretInvalidated).toBe(false);
    expect(JSON.stringify(r)).not.toContain(legacySecret);

    const flow = await flowRow(s.flowId);
    expect(flow.status).toBe('enabled');
    expect(flow.webhookSecretRotatedAt).toBeInstanceOf(Date);
    const stored = decryptFlowWebhookSecret(flow);
    expect(stored).toBe(legacySecret);
    const headers = new Headers({ 'x-breeze-timestamp': ts, 'x-breeze-signature': signature });
    expect(verifyFlowWebhook({ rawBody: body, headers, secret: stored!, mode: 'hmac', now: Date.now() })).toMatchObject({ ok: true });
    const forged = new Headers({ 'x-breeze-timestamp': ts, 'x-breeze-signature': `sha256=${createHmac('sha256', 'other').update(`${ts}.${body}`).digest('hex')}` });
    expect(verifyFlowWebhook({ rawBody: body, headers: forged, secret: stored!, mode: 'hmac', now: Date.now() })).toMatchObject({ ok: false });
  });

  runDb("a shadow conversion's draft cannot be enabled directly", async () => {
    const t = await tenant();
    const [script] = await system(() => db.insert(scripts).values({
      orgId: t.orgId, partnerId: t.partnerId, name: `lib-${randomUUID().slice(0, 6)}`, language: 'powershell', content: 'Write-Output lib',
      osTypes: ['windows'], runAs: 'system', timeoutSeconds: 60,
    }).returning({ id: scripts.id }));
    const row = await job(t, { actions: [{ type: 'run_script', scriptId: script!.id, whenOffline: 'queue' }] });
    const s = await converted(t, row, {});
    expect(await t.asOrg(() => enableFlow(t.orgAuth(), s.flowId, { expectedVersion: 1, preApprovedStepIds: [] })))
      .toEqual({ ok: false, error: 'flow_conversion_not_switched' });
  });

  runDb('a command Job converts through createConversion, its draft stays editable in shadow, and the switch from it succeeds', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const s = await converted(t, row);
    const placeholder = generatedScriptPlaceholderId(row.id, 0);
    expect(scriptIdOf((await flowRow(s.flowId)).definition, 'a0_command')).toBe(placeholder);

    // A user edit during shadow keeps the placeholder (and restarts the shadow).
    const draft = (await flowRow(s.flowId)).definition as Record<string, unknown>;
    const edited = await t.asOrg(() => saveDraftFlow(t.orgAuth(), { flowId: s.flowId, expectedVersion: 1, document: { ...draft, name: 'Renamed in shadow' } }));
    expect(edited.saved, JSON.stringify(edited)).toBe(true);
    expect((await ledgerRow(s.conversionId)).shadowRuns).toBe(0);
    // A real script of another tenant is still refused in that draft.
    const foreign = await t.asOrg(() => saveDraftFlow(t.orgAuth(), {
      flowId: s.flowId, expectedVersion: 2,
      document: { ...draft, steps: (draft.steps as Array<Record<string, unknown>>).map((st) => ({ ...st, input: { ...(st.input as object), scriptId: t.siblingScriptId } })) },
    }));
    expect(foreign).toMatchObject({ saved: false, validation: { issues: [expect.objectContaining({ code: 'reference_not_owned' })] } });

    await system(() => db.update(flowAutomationConversions).set({ shadowRuns: 5, shadowStartedAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(flowAutomationConversions.id, s.conversionId)));
    const r = await t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req({ expectedFlowVersion: 2 })));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const flow = await flowRow(s.flowId);
    expect(flow).toMatchObject({ status: 'enabled', name: 'Renamed in shadow' });
    const [script] = await generatedScripts(row);
    expect(scriptIdOf(flow.definition, 'a0_command')).toBe(script!.id);
  });

  runDb('enable keeps the full check: a draft still naming a placeholder never publishes, even on its switch path', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const s = await converted(t, row);
    const r = await t.asOrg(() => enableFlow(t.orgAuth(), s.flowId, { expectedVersion: 1, preApprovedStepIds: [] }, { switchingConversionId: s.conversionId }));
    expect(r).toMatchObject({ ok: false, error: 'invalid', validation: { issues: [expect.objectContaining({ code: 'reference_not_owned', stepId: 'a0_command' })] } });
    expect(await publicationsOf(s.flowId)).toEqual([]);
  });

  runDb('the ambient-transaction script read keeps the owner predicate: a foreign script is still refused', async () => {
    const t = await tenant();
    const owner = { orgId: t.orgId, partnerId: t.partnerId };
    const doc = (scriptId: string) => ({
      version: 1, name: 'Executor probe', trigger: { type: 'manual' }, inputs: [],
      steps: [{
        id: 'a0', tool: 'run_script_on_targets', approval: 'default', onFailure: 'continue', timeoutSec: 300,
        input: { scriptId, whenOffline: 'queue', target: { type: 'devices', deviceIds: [t.deviceId] } },
      }],
    });
    const pins = [{ stepId: 'a0', tool: 'run_script_on_targets', source: 'builtin', tier: 3, approvalScope: 'supervised' }] as const;

    await t.asOrg(async () => {
      // Another org's script, read through the caller's transaction: not owned, not pre-approvable.
      const foreign = await validateFlowDocument(doc(t.siblingScriptId), { owner, scriptReadExecutor: db });
      expect(foreign.issues.map((i) => i.code)).toContain('reference_not_owned');
      const foreignAssessment = await assessPreApprovals(doc(t.siblingScriptId) as never, [...pins], owner, ['a0'], {
        publicationId: randomUUID(), fleetMaxTargets: { a0: 1 }, scriptReadExecutor: db,
      });
      expect(foreignAssessment.eligibility.a0).toEqual({ eligible: false, reason: 'script_not_found' });

      // A script this transaction just created: visible through the executor only.
      const [mine] = await db.insert(scripts).values({
        orgId: t.orgId, partnerId: t.partnerId, name: `tx-${randomUUID().slice(0, 6)}`, language: 'powershell', content: 'Write-Output tx',
        osTypes: ['windows'], runAs: 'system', timeoutSeconds: 60,
      }).returning({ id: scripts.id });
      const viaDefault = await validateFlowDocument(doc(mine!.id), { owner });
      expect(viaDefault.issues.map((i) => i.code)).toContain('reference_not_owned');
      const viaExecutor = await validateFlowDocument(doc(mine!.id), { owner, scriptReadExecutor: db });
      expect(viaExecutor.issues.filter((i) => i.severity === 'error')).toEqual([]);
      // Roll the probe back.
      throw new RollbackProbe();
    }).catch((err) => {
      if (!(err instanceof RollbackProbe)) throw err;
    });
    // A partner-owned script of ANOTHER partner is refused too.
    const otherPartner = await createPartner();
    const [theirs] = await system(() => db.insert(scripts).values({
      orgId: null, partnerId: otherPartner.id, name: `op-${randomUUID().slice(0, 6)}`, language: 'powershell', content: 'Write-Output x',
      osTypes: ['windows'], runAs: 'system', timeoutSeconds: 60,
    }).returning({ id: scripts.id }));
    await t.asOrg(async () => {
      const v = await validateFlowDocument(doc(theirs!.id), { owner, scriptReadExecutor: db });
      expect(v.issues.map((i) => i.code)).toContain('reference_not_owned');
    });
  });

  runDb('a concurrent Job edit and a switch never deadlock: both finish, or the switch is a clean source_changed', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const s = await converted(t, row, {});

    // The automation PUT's transaction: row update, then the ledger reset —
    // held open long enough for the switch to start and wait.
    let edited = false;
    const put = t.asOrg(() => db.transaction(async (tx) => {
      await tx.update(automations)
        .set({ actions: [{ type: 'execute_command', command: 'Get-Service', shell: 'powershell', whenOffline: 'queue' }] })
        .where(eq(automations.id, row.id));
      await tx.execute(sql`SELECT pg_sleep(0.6)`);
      await resetShadowIfChanged(tx, { automationId: row.id, previous: row });
      edited = true;
    }), t.creator);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const sw = t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req({ acknowledgeDivergence: true })));

    const [putResult, swResult] = await Promise.allSettled([put, sw]);
    expect(putResult.status, JSON.stringify(putResult)).toBe('fulfilled');
    expect(swResult.status, JSON.stringify(swResult)).toBe('fulfilled');
    expect(edited).toBe(true);
    // The edit committed first, so the switch saw a different source.
    expect(swResult.status === 'fulfilled' ? swResult.value : null).toEqual({ ok: false, error: 'source_changed' });
    expect(await generatedScripts(row)).toEqual([]);
    expect((await automationRow(row.id)).enabled).toBe(true);
  });

  runDb('the switch refuses a conversion that is not shadow', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const s = await converted(t, row, {});
    expect((await t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req()))).ok).toBe(true);
    expect(await t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req({ expectedFlowVersion: 2 }))))
      .toEqual({ ok: false, error: 'not_shadow' });
    expect(await generatedScripts(row)).toHaveLength(1);
  });

  runDb('a stale expectedFlowVersion is version_conflict and writes nothing', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const s = await converted(t, row, {});
    expect(await t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req({ expectedFlowVersion: 7 }))))
      .toEqual({ ok: false, error: 'version_conflict' });
    expect(await generatedScripts(row)).toEqual([]);
    expect(automationSourceDigest(await automationRow(row.id))).toBe(automationSourceDigest(row));
  });

  // ── review round (#10685) ────────────────────────────────────────────────

  runDb('a switch of a disabled Job is automation_disabled and writes nothing', async () => {
    const t = await tenant();
    const row = await job(t, { enabled: false });
    const s = await converted(t, row, {});
    expect(await t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req({ acknowledgeDivergence: true }))))
      .toEqual({ ok: false, error: 'automation_disabled' });
    expect(await generatedScripts(row)).toEqual([]);
    expect((await ledgerRow(s.conversionId)).state).toBe('shadow');
    expect((await flowRow(s.flowId)).status).toBe('draft');
  });

  runDb('switch and revert never wait on a flow admission holding KEY SHARE on the Job (the claim FK)', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const s = await converted(t, row, {});
    // A flow-side admission's claim INSERT holds FOR KEY SHARE on the automations row
    // (automation_occurrence_claims_automation_fk) while it holds the flow FOR SHARE.
    // Switch and revert must not queue behind it, or revert (Job lock → flow FOR UPDATE) deadlocks.
    const underKeyShare = <T>(fn: () => Promise<T>) => getTestDb().transaction(async (htx) => {
      await htx.execute(sql`SELECT 1 FROM automations WHERE id = ${row.id} FOR KEY SHARE`);
      return withTimeout(fn(), 5_000);
    });
    const sw = await underKeyShare(() => t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req({ acknowledgeDivergence: true }))));
    expect(sw.ok, JSON.stringify(sw)).toBe(true);
    const rv = await underKeyShare(() => t.asOrg(() => revertConversion(t.orgAuth(), s.conversionId)));
    expect(rv.ok, JSON.stringify(rv)).toBe(true);
  }, 30_000);

  runDb('GET /automations lists a switched Job (read-only, with its flow) but never a monitor-retired one (#5221 C2)', async () => {
    const t = await tenant();
    const switched = await job(t, {});
    const s = await converted(t, switched, {});
    const sw = await t.asOrg(() => switchConversion(t.orgAuth(), s.conversionId, req()));
    expect(sw.ok, JSON.stringify(sw)).toBe(true);
    // A row retired for any other reason (the W05c1 monitor conversion) stays out of the list.
    const monitorRetired = await job(t, {});
    await system(() => db.update(automations)
      .set({ enabled: false, retiredAt: new Date(), retiredReason: 'monitor_deleted' })
      .where(eq(automations.id, monitorRetired.id)));

    const token = await createAccessToken({
      sub: t.switcher.id, email: t.switcher.email, roleId: t.orgRoleId, orgId: t.orgId, partnerId: t.partnerId,
      scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
    const app = new Hono();
    app.route('/automations', automationRoutes);
    const list = async () => {
      const res = await app.request('/automations?limit=100', { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status, await res.clone().text()).toBe(200);
      const body = await res.json() as { data: Array<{ id: string; conversion: unknown }>; pagination?: { total: number } };
      return body;
    };
    const before = await list();
    const ids = before.data.map((r) => r.id);
    expect(ids).toContain(switched.id);
    expect(ids).not.toContain(monitorRetired.id);
    expect(before.data.find((r) => r.id === switched.id)?.conversion).toEqual({ id: s.conversionId, state: 'switched', flowId: s.flowId });
    expect(before.pagination?.total ?? before.data.length).toBe(before.data.length);

    // A partner-scope caller sees a switched partner-wide Job too (the partner branch ANDs on the same predicate).
    const pwJob = await job(t, { orgId: null, partnerId: t.partnerId, conditions: [], createdBy: t.partnerCreator.id });
    const sp = await converted(t, pwJob, {});
    const pr = await t.asPartner(() => switchConversion(t.partnerAuth(), sp.conversionId, req()));
    expect(pr.ok, JSON.stringify(pr)).toBe(true);
    const pwRetired = await job(t, { orgId: null, partnerId: t.partnerId, conditions: [], createdBy: t.partnerCreator.id });
    await system(() => db.update(automations)
      .set({ enabled: false, retiredAt: new Date(), retiredReason: 'monitor_deleted' })
      .where(eq(automations.id, pwRetired.id)));
    const partnerToken = await createAccessToken({
      sub: t.partnerSwitcher.id, email: t.partnerSwitcher.email, roleId: t.partnerRoleId, orgId: null, partnerId: t.partnerId,
      scope: 'partner', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
    const pres = await app.request('/automations?limit=100', { headers: { Authorization: `Bearer ${partnerToken}` } });
    expect(pres.status, await pres.clone().text()).toBe(200);
    const pbody = await pres.json() as { data: Array<{ id: string; conversion: unknown }>; pagination?: { total: number } };
    const pids = pbody.data.map((r) => r.id);
    expect(pids).toContain(pwJob.id);
    expect(pids).toContain(switched.id);
    expect(pids).not.toContain(pwRetired.id);
    expect(pids).not.toContain(monitorRetired.id);
    expect(pbody.data.find((r) => r.id === pwJob.id)?.conversion).toEqual({ id: sp.conversionId, state: 'switched', flowId: sp.flowId });
    expect(pbody.pagination?.total ?? pbody.data.length).toBe(pbody.data.length);

    // After a revert the Job is an ordinary row again.
    const rv = await t.asOrg(() => revertConversion(t.orgAuth(), s.conversionId));
    expect(rv.ok, JSON.stringify(rv)).toBe(true);
    const after = await list();
    expect(after.data.find((r) => r.id === switched.id)?.conversion).toEqual({ id: s.conversionId, state: 'reverted', flowId: s.flowId });
  }, 30_000);

  for (const method of ['PATCH', 'DELETE'] as const) {
    runDb(`a ${method} that read the Job before a switch committed does not land on the switched row`, async () => {
      const t = await tenant();
      const row = await job(t, {});
      const s = await converted(t, row, {});
      const token = await createAccessToken({
        sub: t.switcher.id, email: t.switcher.email, roleId: t.orgRoleId, orgId: t.orgId, partnerId: t.partnerId,
        scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
      });
      const app = new Hono();
      app.route('/automations', automationRoutes);

      // The switch's lock on the Job is held while the request reads the row (unconverted),
      // passes its frozen check and reaches its write; then the switch's writes commit.
      const response = await getTestDb().transaction(async (htx) => {
        await htx.execute(sql`SELECT 1 FROM automations WHERE id = ${row.id} FOR NO KEY UPDATE`);
        const pending = app.request(`/automations/${row.id}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(method === 'PATCH' ? { body: JSON.stringify({ enabled: true, description: 'edited after the switch' }) } : {}),
        });
        await waitForLockedWrite(row.id);
        await htx.execute(sql`UPDATE automations SET enabled = false, retired_at = now(), retired_reason = 'converted_to_flow',
          converted_to_flow_id = ${s.flowId} WHERE id = ${row.id}`);
        return { pending };
      }).then(({ pending }) => pending);

      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toEqual({ error: 'automation_converted', flowId: s.flowId });
      const after = await automationRow(row.id);
      expect(after).toMatchObject({ enabled: false, convertedToFlowId: s.flowId });
      expect(after.description).not.toBe('edited after the switch');
    }, 30_000);
  }
});

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms (lock wait)`)), ms))]);
}

/** Until a breeze_app backend is blocked on a lock while writing (UPDATE/DELETE) the automations table. */
async function waitForLockedWrite(automationId: string): Promise<void> {
  void automationId;
  for (let i = 0; i < 100; i += 1) {
    const rows = await getTestDb().execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND (query ILIKE 'update "automations"%' OR query ILIKE 'delete from "automations"%'
        OR query ILIKE 'select%from "automations"%for update%')`);
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the request never reached its write on the automations row');
}

class RollbackProbe extends Error {}

