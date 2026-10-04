// apps/api/src/__tests__/integration/fixMemoryRunConsumer.integration.test.ts
//
// AI Suggested Fixes W3 — the proven-fix lookup an agent run makes at context
// load (runLoop.loadRunContext → loadProvenFixesForRun) runs under SYSTEM
// scope, i.e. with RLS bypassed. These cases prove its explicit org/partner
// filter is what keeps memory inside the owning tenant, against real Postgres.
import './setup';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { alerts, devices, fixMemory, organizations, scripts, scriptVersions } from '../../db/schema';
import { alertSignature } from '../../services/fixMemory/signatureLoader';
import { loadProvenFixesForRun } from '../../services/fixMemory/runMemory';
import { createOrganization, createPartner, createSite } from './db-utils';

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

async function enableFlag(orgId: string) {
  await sys(() => db.update(organizations).set({
    settings: sql`jsonb_set(coalesce(${organizations.settings}, '{}'::jsonb), '{mlFeatureFlags}', '{"ml.remediation_suggestions.enabled": true}'::jsonb)`,
  }).where(eq(organizations.id, orgId)));
}

async function mkDevice(orgId: string) {
  const site = await createSite({ orgId });
  const [d] = await sys(() => db.insert(devices).values({
    orgId, siteId: site.id, agentId: randomUUID(), hostname: `host-${randomUUID().slice(0, 6)}`,
    osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
  }).returning({ id: devices.id }));
  return d!.id;
}

async function mkScript(owner: { orgId?: string; partnerId?: string }) {
  const [s] = await sys(() => db.insert(scripts).values({
    name: `fix-${randomUUID().slice(0, 6)}`, language: 'powershell', content: 'Restart-Service Spooler',
    osTypes: ['windows'], orgId: owner.orgId ?? null, partnerId: owner.partnerId ?? null,
  }).returning({ id: scripts.id, name: scripts.name }));
  const [v] = await sys(() => db.insert(scriptVersions).values({
    scriptId: s!.id, version: 1, content: 'Restart-Service Spooler', language: 'powershell', timeoutSeconds: 300,
    runAs: 'system', contentDigest: createHash('sha256').update(s!.id).digest('hex'),
  }).returning({ id: scriptVersions.id }));
  return { scriptId: s!.id, name: s!.name, versionId: v!.id };
}

async function mkAlert(orgId: string, deviceId: string, watchedScriptId: string) {
  const [a] = await sys(() => db.insert(alerts).values({
    orgId, deviceId, severity: 'high', title: 'exit 3',
    context: { source: 'script_exit_code', scriptId: watchedScriptId, exitCode: 3 },
  }).returning({ id: alerts.id }));
  return a!.id;
}

/** Two orgs under one partner, each with a device. */
async function world() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  return { partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, dA: await mkDevice(orgA.id), dB: await mkDevice(orgB.id) };
}

type SeedFix = { scriptId: string; versionId: string } | { builtinAction: 'reboot' };

/** A proven memory row for the alert's signature, owned as given. */
async function seedProven(alertId: string, owner: { orgId?: string; partnerId?: string }, fix: SeedFix) {
  const resolved = await sys(() => alertSignature(alertId));
  expect(resolved?.signature.broad).toBe(false);
  const kind = 'builtinAction' in fix
    ? { fixKind: 'builtin_action' as const, fixIdentity: `builtin:${fix.builtinAction}`, builtinAction: fix.builtinAction }
    : {
      fixKind: owner.orgId ? 'org_script' as const : 'partner_script' as const, fixIdentity: `script_version:${fix.versionId}`,
      scriptId: fix.scriptId, scriptVersionId: fix.versionId,
    };
  await sys(() => db.insert(fixMemory).values({
    orgId: owner.orgId ?? null, partnerId: owner.partnerId ?? null,
    signatureVersion: resolved!.signature.version, signatureKey: resolved!.signature.key, broadKey: resolved!.signature.broadKey,
    osType: 'windows',
    ...kind,
    attempts: 4, verifiedCount: 4, rollingSuccessRate: 1, recentOutcomes: ['verified', 'verified', 'verified', 'verified'],
    status: 'active', lastVerifiedAt: new Date(),
  }));
}

const runLookup = (orgId: string, partnerId: string, alertId: string) =>
  sys(() => loadProvenFixesForRun({ orgId, partnerId, alertId, correlationGroupId: null }));

describe('fix memory consumed by agent runs (real Postgres, system scope like loadRunContext)', () => {
  it('a partner-wide proven fix reaches runs in every org of the partner (ruling 5)', async () => {
    const w = await world();
    const watched = await mkScript({ partnerId: w.partnerId });
    const fix = await mkScript({ partnerId: w.partnerId });
    const alertA = await mkAlert(w.orgA, w.dA, watched.scriptId);
    await seedProven(alertA, { partnerId: w.partnerId }, fix);
    await enableFlag(w.orgA);
    await enableFlag(w.orgB);
    const alertB = await mkAlert(w.orgB, w.dB, watched.scriptId);

    const forA = await runLookup(w.orgA, w.partnerId, alertA);
    const forB = await runLookup(w.orgB, w.partnerId, alertB);
    expect(forA?.proven).toEqual([expect.objectContaining({ scriptName: fix.name, scope: 'all_clients', verified: 4, attempts: 4 })]);
    expect(forB?.proven).toEqual([expect.objectContaining({ scriptName: fix.name, scope: 'all_clients' })]);
  });

  it('a partner-wide proven fix never reaches a run in another partner’s org (ruling 5)', async () => {
    const owner = await world();
    const other = await world();
    // A SYSTEM script, so the other partner's alert can carry the identical
    // signature (same monitored script, exit code and OS).
    const [watchedRow] = await sys(() => db.insert(scripts).values({
      name: `watched-${randomUUID().slice(0, 6)}`, language: 'powershell', content: 'exit 3', osTypes: ['windows'], isSystem: true,
    }).returning({ id: scripts.id }));
    const fix = await mkScript({ partnerId: owner.partnerId });
    const ownerAlert = await mkAlert(owner.orgA, owner.dA, watchedRow!.id);
    await seedProven(ownerAlert, { partnerId: owner.partnerId }, fix);
    await enableFlag(owner.orgA);
    await enableFlag(other.orgA);
    const otherAlert = await mkAlert(other.orgA, other.dA, watchedRow!.id);
    const [ownerSig, otherSig] = await Promise.all([sys(() => alertSignature(ownerAlert)), sys(() => alertSignature(otherAlert))]);
    expect(otherSig!.signature.key).toBe(ownerSig!.signature.key);

    expect(await runLookup(other.orgA, other.partnerId, otherAlert)).toBeNull();
    expect((await runLookup(owner.orgA, owner.partnerId, ownerAlert))?.proven.map((p) => p.scriptName)).toEqual([fix.name]);
  });

  it('org B’s run never sees org A’s private fix (Review Focus 1, ruling 4)', async () => {
    const w = await world();
    const watched = await mkScript({ partnerId: w.partnerId });
    const privateFix = await mkScript({ orgId: w.orgA });
    const alertA = await mkAlert(w.orgA, w.dA, watched.scriptId);
    await seedProven(alertA, { orgId: w.orgA }, privateFix);
    await enableFlag(w.orgA);
    await enableFlag(w.orgB);
    const alertB = await mkAlert(w.orgB, w.dB, watched.scriptId);
    const [sigA, sigB] = await Promise.all([sys(() => alertSignature(alertA)), sys(() => alertSignature(alertB))]);
    expect(sigB!.signature.key).toBe(sigA!.signature.key);

    expect(await runLookup(w.orgB, w.partnerId, alertB)).toBeNull();
    const forA = await runLookup(w.orgA, w.partnerId, alertA);
    expect(forA?.proven).toEqual([expect.objectContaining({ scriptName: privateFix.name, scope: 'this_client' })]);
  });

  it('org B’s run never sees org A’s private built-in fix — no script-owner backstop, the row filter alone (ruling 4)', async () => {
    const w = await world();
    const watched = await mkScript({ partnerId: w.partnerId });
    const alertA = await mkAlert(w.orgA, w.dA, watched.scriptId);
    await seedProven(alertA, { orgId: w.orgA }, { builtinAction: 'reboot' });
    await enableFlag(w.orgA);
    await enableFlag(w.orgB);
    const alertB = await mkAlert(w.orgB, w.dB, watched.scriptId);

    expect(await runLookup(w.orgB, w.partnerId, alertB)).toBeNull();
    const forA = await runLookup(w.orgA, w.partnerId, alertA);
    expect(forA?.proven).toEqual([expect.objectContaining({ scriptName: null, builtinAction: 'reboot', fixKind: 'builtin_action', scope: 'this_client' })]);
  });

  it('flag off for the run org → null even with proven memory (Review Focus 2)', async () => {
    const w = await world();
    const watched = await mkScript({ partnerId: w.partnerId });
    const fix = await mkScript({ partnerId: w.partnerId });
    const alertA = await mkAlert(w.orgA, w.dA, watched.scriptId);
    await seedProven(alertA, { partnerId: w.partnerId }, fix);
    expect(await runLookup(w.orgA, w.partnerId, alertA)).toBeNull();
  });
});
