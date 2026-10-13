/**
 * Caller verification workstation tier (#6354 W02) — live-DB suite.
 *
 * Proves against real Postgres + Redis what mocks cannot: the command and
 * verification commit or roll back together inside `start`; delivery only
 * pushes the pre-created command and a retry never mints another; the shared
 * result handler applies a decision once under any ambient context, refuses
 * a command it cannot tie to the device's org, and binds the agent-reported
 * principal only after a verified match; a late "not me" survives a terminal
 * command and is repaired by reconciliation; device suggestions keep mixed
 * per-device readiness and never cross org or site reach. Only the socket
 * transport (`dispatchCommandToAgent`) is mocked.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import './setup';
import { createOrganization, createSite, createUser, setupTestEnvironment } from './db-utils';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { contacts } from '../../db/schema/contacts';
import { auditLogs } from '../../db/schema/audit';
import { devices, deviceCommands } from '../../db/schema';
import { callerVerifications as v, callerVerificationSubjectBindings as b } from '../../db/schema/callerVerification';
import * as service from '../../services/callerVerification/service';
import { recordWorkstationCapabilities } from '../../services/callerVerification/workstationCapabilities';
import { deliverWorkstation } from '../../services/callerVerification/deliverers/workstation';
import { handleCallerVerifyResult, persistCallerNotMeReceipt } from '../../services/callerVerification/workstationResult';
import { deviceSuggestions } from '../../services/callerVerification/deviceSuggestions';
import { reconcileCallerVerifications } from '../../jobs/callerVerificationReconciliation';
import type { CallerVerificationActor } from '../../services/callerVerification/types';

const dispatch = vi.hoisted(() => vi.fn());
vi.mock('../../services/agentCommandRelay', async (orig) => ({
  ...await orig<typeof import('../../services/agentCommandRelay')>(),
  dispatchCommandToAgent: dispatch,
}));

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn, 'callerVerification.workstation.integration');

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(opts: { partnerId?: string; upn?: string } = {}) {
  // A real partner member (role + membership): the claim-time eligibility
  // check cancels commands whose requester is not an active member.
  let partnerId: string, org: { id: string }, site: { id: string }, user: { id: string };
  if (opts.partnerId) {
    partnerId = opts.partnerId;
    org = (await createOrganization({ partnerId }))!;
    site = (await createSite({ orgId: org.id }))!;
    user = (await createUser({ partnerId, email: `cvw-${randomUUID()}@example.com`, status: 'active' }))!;
  } else {
    const env = await setupTestEnvironment({ scope: 'partner' });
    partnerId = env.partner.id; org = env.organization; site = env.site; user = env.user;
  }
  const otherSite = (await createSite({ orgId: org.id }))!;
  const actor: CallerVerificationActor = {
    userId: user.id, partnerId, scope: 'partner', accessibleOrgIds: [org.id], allowedSiteIds: null, displayName: 'Sam Tech',
  };
  const context = { scope: 'partner' as const, orgId: null, accessibleOrgIds: [org.id], accessiblePartnerIds: [partnerId], currentPartnerId: partnerId, userId: user.id };
  const orgContext = { scope: 'organization' as const, orgId: org.id, accessibleOrgIds: [org.id], accessiblePartnerIds: [], currentPartnerId: partnerId, userId: user.id };
  const upn = opts.upn ?? `alex-${randomUUID().slice(0, 8)}@example.com`;
  const data = await sys(async () => {
    const [contact] = await db.insert(contacts).values({ orgId: org.id, siteId: site.id, name: 'Alex', email: upn }).returning();
    const [binding] = await db.insert(b).values({
      orgId: org.id, contactId: contact!.id, entraTenantId: randomUUID(), entraOid: randomUUID(), upnSnapshot: upn, source: 'directory_sync',
    }).returning();
    const [device] = await db.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: randomUUID(), hostname: 'ready-pc', osType: 'windows', osVersion: '11',
      architecture: 'x86_64', agentVersion: 'test', lastUser: 'alex', status: 'online',
    }).returning();
    return { contact: contact!, binding: binding!, device: device! };
  });
  await recordWorkstationCapabilities(org.id, data.device.id, { callerVerify: true, usernames: ['alex'] });
  return { partnerId, org, site, otherSite, user, actor, context, orgContext, upn, ...data };
}

const startInput = (f: Fixture, over: Partial<Parameters<typeof service.start>[1]> = {}) => ({
  orgId: f.org.id, contactId: f.contact.id, method: 'workstation' as const, actionScope: 'any' as const,
  deviceId: f.device.id, username: 'alex', ...over,
});

async function loaded(id: string) {
  return sys(async () => {
    const [row] = await db.select().from(v).where(eq(v.id, id));
    const [command] = row?.agentCommandId ? await db.select().from(deviceCommands).where(eq(deviceCommands.id, row.agentCommandId)) : [];
    return { row: row!, command };
  });
}

function resultParams(f: Fixture, command: typeof deviceCommands.$inferSelect, stdout: string) {
  return { agentId: f.device.agentId!, command, commandId: command.id, resolvedDeviceId: f.device.id, result: { status: 'completed' as const }, stdout };
}

beforeEach(() => {
  process.env.CALLER_VERIFICATION_ENABLED = 'true';
  dispatch.mockReset().mockResolvedValue({ status: 'sent', via: 'local' });
});
afterEach(() => {
  delete process.env.CALLER_VERIFICATION_ENABLED;
});

it('start commits the verification and its caller_verify command together, or neither', async () => {
  const f = await fixture();
  let rolledBackId = '';
  await expect(withDbAccessContext(f.context, async () => {
    const view = await service.start(f.actor, startInput(f));
    rolledBackId = view.id;
    const [row] = await db.select().from(v).where(eq(v.id, view.id));
    expect(row!.agentCommandId).toBeTruthy();
    throw new Error('rollback-control');
  })).rejects.toThrow('rollback-control');
  expect(rolledBackId).not.toBe('');
  await sys(async () => {
    expect(await db.select().from(v).where(eq(v.id, rolledBackId))).toHaveLength(0);
    expect(await db.select().from(deviceCommands).where(eq(deviceCommands.deviceId, f.device.id))).toHaveLength(0);
  });

  const view = await withDbAccessContext(f.context, () => service.start(f.actor, startInput(f)));
  expect(view).toMatchObject({ status: 'pending', method: 'workstation', tier: 1, deviceHostname: 'ready-pc', osUsername: 'alex' });
  const { row, command } = await loaded(view.id);
  expect(command).toMatchObject({ type: 'caller_verify', status: 'pending', targetRole: 'agent', submittedOrgId: f.org.id, createdBy: f.user.id });
  expect(command!.deliverBy!.getTime()).toBe(row.expiresAt.getTime());
  const payload = command!.payload as Record<string, any>;
  expect(payload).toMatchObject({ verificationId: view.id, username: 'alex', technicianName: 'Sam Tech', reverseCode: row.reverseCode });
  expect([...payload.choices].sort()).toEqual([row.matchValue, ...row.decoyValues].sort());
  expect(row.challengeChoices).toEqual(payload.choices);
});

it('delivery pushes only the pre-created command; a retry after an infrastructure error re-uses it', async () => {
  const f = await fixture();
  const view = await withDbAccessContext(f.context, () => service.start(f.actor, startInput(f)));
  const { command } = await loaded(view.id);

  dispatch.mockResolvedValueOnce({ status: 'infrastructure_error', message: 'relay down' });
  await expect(deliverWorkstation(view.id)).rejects.toThrow('relay down');
  expect((await loaded(view.id)).command!.status).toBe('pending'); // claim released

  await deliverWorkstation(view.id);
  expect(dispatch).toHaveBeenLastCalledWith(f.device.agentId, expect.objectContaining({ id: command!.id, type: 'caller_verify' }));
  expect((await loaded(view.id)).command!.status).toBe('sent');
  await sys(async () => {
    expect(await db.select().from(deviceCommands).where(eq(deviceCommands.deviceId, f.device.id))).toHaveLength(1);
  });
  // Already claimed: a further publisher pass pushes nothing.
  dispatch.mockClear();
  await deliverWorkstation(view.id);
  expect(dispatch).not.toHaveBeenCalled();
});

it('applies a duplicated approval once, binds the agent principal only after the verified match, and keeps it tier 1', async () => {
  const f = await fixture();
  const view = await withDbAccessContext(f.context, () => service.start(f.actor, startInput(f)));
  const { row, command } = await loaded(view.id);
  const stdout = JSON.stringify({ delivered: true, choice: row.matchValue, principal: { sid: 'S-1-5-21-1000-2000-3000-1001', username: 'alex', upn: f.upn } });
  // Same leaf handler, the two transports' contexts: HTTP's org request tx and WS's org finalize context.
  await withDbAccessContext(f.orgContext, () => handleCallerVerifyResult(resultParams(f, command!, stdout)));
  await withDbAccessContext(f.orgContext, () => handleCallerVerifyResult(resultParams(f, command!, stdout)));
  const after = await loaded(view.id);
  expect(after.row).toMatchObject({ status: 'verified', tier: 1, tierReason: 'unbound_principal', osPrincipalObserved: 'S-1-5-21-1000-2000-3000-1001' });
  await sys(async () => {
    const [binding] = await db.select().from(b).where(eq(b.id, f.binding.id));
    expect(binding).toMatchObject({ osPrincipal: 'S-1-5-21-1000-2000-3000-1001', osUsername: 'alex', source: 'observed_login' });
    const verifiedAudits = await db.select().from(auditLogs).where(and(eq(auditLogs.resourceId, view.id), eq(auditLogs.action, 'caller_verification.verified')));
    expect(verifiedAudits).toHaveLength(1);
  });

  // The next challenge answered by that same principal is bound: tier 3.
  const second = await withDbAccessContext(f.context, () => service.start(f.actor, startInput(f)));
  const next = await loaded(second.id);
  await withDbAccessContext(f.orgContext, () => handleCallerVerifyResult(resultParams(f, next.command!, JSON.stringify({
    delivered: true, choice: next.row.matchValue, principal: { sid: 'S-1-5-21-1000-2000-3000-1001', username: 'alex', upn: f.upn },
  }))));
  expect((await loaded(second.id)).row).toMatchObject({ status: 'verified', tier: 3, tierReason: 'bound_principal' });
});

it('a wrong number never binds and a handler rollback leaves the verification pending', async () => {
  const f = await fixture();
  const view = await withDbAccessContext(f.context, () => service.start(f.actor, startInput(f)));
  const { row, command } = await loaded(view.id);
  const decoy = row.decoyValues[0]!;
  // A principal that WOULD bind (SID + matching directory UPN) if observed.
  const principal = { sid: 'S-1-5-21-1000-2000-3000-1002', username: 'alex', upn: f.upn };

  await expect(withDbAccessContext(f.orgContext, async () => {
    await handleCallerVerifyResult(resultParams(f, command!, JSON.stringify({ delivered: true, choice: row.matchValue, principal })));
    throw new Error('transport persistence failed');
  })).rejects.toThrow('transport persistence failed');
  expect((await loaded(view.id)).row).toMatchObject({ status: 'pending', decidedAt: null, osPrincipalObserved: null });

  await withDbAccessContext(f.orgContext, () => handleCallerVerifyResult(resultParams(f, command!, JSON.stringify({ delivered: true, choice: decoy, principal }))));
  expect((await loaded(view.id)).row).toMatchObject({ status: 'wrong_choice', osPrincipalObserved: 'S-1-5-21-1000-2000-3000-1002' });
  await sys(async () => {
    expect((await db.select().from(b).where(eq(b.id, f.binding.id)))[0]!.osPrincipal).toBeNull();
  });
});

it('ignores a result it cannot tie to the device and org that own the verification', async () => {
  const f = await fixture();
  const other = await fixture({ partnerId: f.partnerId });
  const view = await withDbAccessContext(f.context, () => service.start(f.actor, startInput(f)));
  const { row, command } = await loaded(view.id);
  const stdout = JSON.stringify({ delivered: true, choice: row.matchValue, principal: { uid: 501, username: 'alex' } });
  // Another org's device reporting this command id.
  await sys(() => handleCallerVerifyResult({ ...resultParams(f, command!, stdout), resolvedDeviceId: other.device.id }));
  expect((await loaded(view.id)).row.status).toBe('pending');
  // Another org's context cannot see the verification at all.
  await withDbAccessContext(other.orgContext, () => handleCallerVerifyResult(resultParams(f, command!, stdout)));
  expect((await loaded(view.id)).row.status).toBe('pending');
  // A receipt for a command on a different device is refused.
  expect(await sys(() => persistCallerNotMeReceipt({ commandId: command!.id, deviceId: other.device.id, result: { delivered: true, choice: 'not_me' } }))).toBe(false);
});

it('a late "not me" survives a terminal command and reconciliation applies it once', async () => {
  const f = await fixture();
  const view = await withDbAccessContext(f.context, () => service.start(f.actor, startInput(f)));
  const { row, command } = await loaded(view.id);
  const stdout = JSON.stringify({ delivered: true, choice: row.matchValue, principal: { uid: 501, username: 'alex' } });
  await sys(async () => {
    await db.update(deviceCommands).set({ status: 'completed', completedAt: new Date(), result: { status: 'completed', stdout } }).where(eq(deviceCommands.id, command!.id));
  });
  await withDbAccessContext(f.orgContext, () => handleCallerVerifyResult(resultParams(f, command!, stdout)));
  expect((await loaded(view.id)).row.status).toBe('verified');

  // Simulated crash: the receipt commits, the decision never runs.
  expect(await sys(() => persistCallerNotMeReceipt({ commandId: command!.id, deviceId: f.device.id, result: { delivered: true, choice: 'not_me' } }))).toBe(true);
  const stored = (await loaded(view.id)).command!;
  expect(stored.status).toBe('completed'); // never reopened
  expect(stored.result).toMatchObject({ status: 'completed', stdout, callerVerificationNotMe: true });

  await reconcileCallerVerifications();
  await reconcileCallerVerifications();
  expect((await loaded(view.id)).row.status).toBe('rejected_by_user');
  await sys(async () => {
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.resourceId, view.id), eq(auditLogs.action, 'caller_verification.rejected_by_user')));
    expect(audits.length).toBeLessThanOrEqual(1);
  });
});

it.each([
  ['a cancelled command', { status: 'cancelled', result: { reason: 'org_moved' } }, 'undeliverable'],
  ['a terminal number result', 'match', 'verified'],
  ['an agent with no console user', { status: 'completed', result: { status: 'completed', stdout: JSON.stringify({ delivered: false, error: 'no_session_for_user' }) } }, 'undeliverable'],
] as const)('reconciles a pending verification after %s', async (_label, shape, expected) => {
  const f = await fixture();
  const view = await withDbAccessContext(f.context, () => service.start(f.actor, startInput(f)));
  const { row, command } = await loaded(view.id);
  const set = shape === 'match'
    ? { status: 'completed' as const, result: { status: 'completed', stdout: JSON.stringify({ delivered: true, choice: row.matchValue, principal: { uid: 501, username: 'alex' } }) } }
    : shape;
  await sys(async () => { await db.update(deviceCommands).set(set as never).where(eq(deviceCommands.id, command!.id)); });
  await reconcileCallerVerifications();
  const after = (await loaded(view.id)).row;
  expect(after.status).toBe(expected);
  if (_label === 'an agent with no console user') expect(after.reason).toBe('no_session_for_user');
});

it('keeps mixed per-device readiness, aggregates it for the contact and refuses a selected outdated helper', async () => {
  const f = await fixture();
  const old = await sys(async () => {
    const [d] = await db.insert(devices).values({
      orgId: f.org.id, siteId: f.site.id, agentId: randomUUID(), hostname: 'old-pc', osType: 'windows', osVersion: '10',
      architecture: 'x86_64', agentVersion: 'old', lastUser: 'alex', status: 'online',
    }).returning();
    return d!;
  });
  await recordWorkstationCapabilities(f.org.id, old.id, undefined); // an old agent sends nothing
  await withDbAccessContext(f.context, async () => {
    const rows = await deviceSuggestions(f.actor, f.org.id, f.contact.id);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: f.device.id, username: 'alex', available: true }),
      expect.objectContaining({ deviceId: old.id, username: 'alex', available: false, unavailableReason: 'helper_outdated' }),
    ]));
    const methods = await service.methodsForContact(f.actor, f.org.id, f.contact.id, 'any');
    expect(methods.find((m) => m.method === 'workstation')).toMatchObject({ available: true, tier: 1 });
  });
  await expect(withDbAccessContext(f.context, () => service.start(f.actor, startInput(f, { deviceId: old.id })))).rejects.toMatchObject({ code: 'helper_outdated' });
  await expect(withDbAccessContext(f.context, () => service.start(f.actor, startInput(f, { username: 'mallory' })))).rejects.toMatchObject({ code: 'helper_outdated' });
  await sys(async () => {
    expect(await db.select().from(v).where(eq(v.workstationDeviceRef, old.id))).toHaveLength(0);
    expect(await db.select().from(deviceCommands).where(eq(deviceCommands.deviceId, old.id))).toHaveLength(0);
  });

  // Telemetry clears: the aggregate follows.
  await recordWorkstationCapabilities(f.org.id, f.device.id, { callerVerify: false, usernames: [] });
  await withDbAccessContext(f.context, async () => {
    const methods = await service.methodsForContact(f.actor, f.org.id, f.contact.id, 'any');
    expect(methods.find((m) => m.method === 'workstation')).toMatchObject({ available: false, unavailableReason: 'helper_outdated' });
  });
});

it('suggestions never cross org or site reach', async () => {
  const a = await fixture();
  const other = await fixture({ partnerId: a.partnerId });
  await withDbAccessContext(a.context, async () => {
    await expect(deviceSuggestions(a.actor, other.org.id, other.contact.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(deviceSuggestions({ ...a.actor, allowedSiteIds: [a.otherSite.id] }, a.org.id, a.contact.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await deviceSuggestions(a.actor, a.org.id, a.contact.id)).toEqual([
      expect.objectContaining({ deviceId: a.device.id, available: true }),
    ]);
  });
});
