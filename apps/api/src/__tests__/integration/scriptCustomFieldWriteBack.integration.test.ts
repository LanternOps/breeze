/**
 * #2698 — the properties that only a real database can prove:
 *
 *  1. A partner-wide field definition (org_id NULL) IS honoured, even though
 *     the caller runs in the agent's ORG-scoped context where the dual-axis
 *     RLS policy hides such rows. This is the CLAUDE.md Partner-Wide First §3
 *     trap and the reason the definitions read uses a system context.
 *  2. A device in another org is untouched — the write is pinned by org_id.
 *  3. The script_write gate actually blocks a non-opted-in field.
 *  4. An unchanged value writes no row (the per-org advisory-lock avoidance).
 *
 * The shared integration setup TRUNCATEs core tenant tables before EVERY test,
 * so the fixture is built in `beforeEach` (registered after the setup hook, so
 * it runs after the truncate) and each test is self-contained.
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { customFieldDefinitions, devices, organizations } from '../../db/schema';
import { applyScriptCustomFieldWrites } from '../../services/customFields/scriptWriteBack';
import { createOrganization, createPartner, createSite } from './db-utils';

const marker = (json: string) => `::breeze:custom-fields:: ${json}`;

/**
 * Mirrors `runWithAgentOrgDbAccess` (routes/agentWs.ts): org scope, NO partner
 * access. Partner-wide `custom_field_definitions` rows are invisible from here
 * — which is exactly what the first test exists to catch.
 */
function agentOrgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
    userId: null,
    label: 'test.agentOrg',
  };
}

const systemContext = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn, 'test.seed');

const AGENT_ID = '33333333-3333-4333-8333-333333333333';
const COMMAND_ID = '44444444-4444-4444-8444-444444444444';

let partnerId: string;
let orgAId: string;
let orgBId: string;
let deviceAId: string;
let deviceBId: string;

beforeEach(async () => {
  const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const partner = await createPartner({ name: `CFWB ${sfx}` });
  partnerId = partner!.id;
  const orgA = await createOrganization({ partnerId, name: `CFWB A ${sfx}` });
  const orgB = await createOrganization({ partnerId, name: `CFWB B ${sfx}` });
  orgAId = orgA!.id;
  orgBId = orgB!.id;

  // devices.site_id is NOT NULL.
  const siteA = await createSite({ orgId: orgAId, name: `CFWB A site ${sfx}` });
  const siteB = await createSite({ orgId: orgBId, name: `CFWB B site ${sfx}` });

  await systemContext(async () => {
    const rows = await db
      .insert(devices)
      .values([
        {
          orgId: orgAId,
          siteId: siteA!.id,
          agentId: `cfwb-a-${sfx}`,
          hostname: 'CFWB-A',
          status: 'online',
          osType: 'windows',
          osVersion: '11',
          architecture: 'x86_64',
          agentVersion: '1.0.0',
        },
        {
          orgId: orgBId,
          siteId: siteB!.id,
          agentId: `cfwb-b-${sfx}`,
          hostname: 'CFWB-B',
          status: 'online',
          osType: 'windows',
          osVersion: '11',
          architecture: 'x86_64',
          agentVersion: '1.0.0',
        },
      ])
      .returning({ id: devices.id, orgId: devices.orgId });
    deviceAId = rows.find((r) => r.orgId === orgAId)!.id;
    deviceBId = rows.find((r) => r.orgId === orgBId)!.id;

    // Partner-WIDE definition: org_id NULL. Invisible to the agent's org
    // context, which is the whole point.
    await db.insert(customFieldDefinitions).values({
      orgId: null,
      partnerId,
      name: 'RAM slot type',
      fieldKey: 'ram_slot_type',
      type: 'text',
      scriptWrite: true,
    });

    // Org-owned definition that has NOT opted in.
    await db.insert(customFieldDefinitions).values({
      orgId: orgAId,
      partnerId: null,
      name: 'Asset tag',
      fieldKey: 'asset_tag',
      type: 'text',
      scriptWrite: false,
    });
  });
});

const readDevice = (deviceId: string) =>
  systemContext(() =>
    db
      .select({ customFields: devices.customFields, updatedAt: devices.updatedAt })
      .from(devices)
      .where(eq(devices.id, deviceId)),
  );

const runAsAgent = (orgId: string, deviceId: string, stdout: string) =>
  withDbAccessContext(agentOrgContext(orgId), () =>
    applyScriptCustomFieldWrites({
      deviceId,
      agentId: AGENT_ID,
      commandId: COMMAND_ID,
      stdout,
      resultEnvelope: undefined,
    }),
  );

describe('script custom-field write-back (integration)', () => {
  it('honours a PARTNER-WIDE definition from the agent org context', async () => {
    const summary = await runAsAgent(orgAId, deviceAId, marker('{"ram_slot_type":"DDR5-5600"}'));

    // A failure here with rejected: [{reason: 'unknown_field'}] means the
    // definitions read ran in the ORG context instead of a system context.
    expect(summary).toEqual({ applied: ['ram_slot_type'], rejected: [] });

    const [row] = await readDevice(deviceAId);
    expect((row!.customFields as Record<string, unknown>).ram_slot_type).toBe('DDR5-5600');
  });

  it('leaves a same-key field on a device in ANOTHER org untouched', async () => {
    await runAsAgent(orgAId, deviceAId, marker('{"ram_slot_type":"DDR5-5600"}'));

    const [other] = await readDevice(deviceBId);
    expect((other!.customFields as Record<string, unknown> | null)?.ram_slot_type).toBeUndefined();
  });

  it('cannot write a device in another org even when named directly', async () => {
    // The transport never lets this happen — but if the deviceId and the org
    // context ever disagree, RLS must win rather than the write landing.
    const summary = await runAsAgent(orgAId, deviceBId, marker('{"ram_slot_type":"DDR5-5600"}'));
    // RLS blocks the SELECT in loadDeviceForWriteBack, so we never even reach
    // the org_id predicate on the UPDATE. Asserting the reason pins WHICH
    // layer refused, which is the diagnostic that matters if this regresses.
    expect(summary).toEqual({ applied: [], rejected: [{ key: '(device)', reason: 'device_not_found' }] });

    const [other] = await readDevice(deviceBId);
    expect((other!.customFields as Record<string, unknown> | null)?.ram_slot_type).toBeUndefined();
  });

  it('does not leak an ORG-scoped definition to a sibling org under the same partner', async () => {
    // `asset_tag` is owned by org A (org_id = A, partner_id = NULL). Org B
    // shares org A's partner, so the ONLY thing keeping it out of org B's
    // definition set is the `isNull(orgId)` guard on the partner-wide arm of
    // loadScriptWritableDefinitions. Flatten that OR into a bare partner match
    // and every org-scoped field on the partner becomes fleet-writable.
    await systemContext(() =>
      db.insert(customFieldDefinitions).values({
        orgId: orgAId,
        partnerId: null,
        name: 'Org A only',
        fieldKey: 'org_a_only',
        type: 'text',
        scriptWrite: true,
      }),
    );

    const summary = await runAsAgent(orgBId, deviceBId, marker('{"org_a_only":"leaked"}'));
    expect(summary).toEqual({ applied: [], rejected: [{ key: 'org_a_only', reason: 'unknown_field' }] });

    const [row] = await readDevice(deviceBId);
    expect((row!.customFields as Record<string, unknown> | null)?.org_a_only).toBeUndefined();
  });

  it('blocks a field that has not opted into script writes', async () => {
    const summary = await runAsAgent(orgAId, deviceAId, marker('{"asset_tag":"A-1"}'));
    expect(summary).toEqual({
      applied: [],
      rejected: [{ key: 'asset_tag', reason: 'not_script_writable' }],
    });

    const [row] = await readDevice(deviceAId);
    expect((row!.customFields as Record<string, unknown> | null)?.asset_tag).toBeUndefined();
  });

  it('does not bump updated_at when the value is unchanged', async () => {
    await runAsAgent(orgAId, deviceAId, marker('{"ram_slot_type":"DDR5-5600"}'));
    const [before] = await readDevice(deviceAId);

    const summary = await runAsAgent(orgAId, deviceAId, marker('{"ram_slot_type":"DDR5-5600"}'));
    expect(summary).toEqual({ applied: ['ram_slot_type'], rejected: [] });

    const [after] = await readDevice(deviceAId);
    expect(after!.updatedAt).toEqual(before!.updatedAt);
  });

  it('reads the org partner via organizations, not the agent context', async () => {
    const [org] = await systemContext(() =>
      db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, orgAId)),
    );
    expect(org!.partnerId).toBe(partnerId);
  });

  it('clears a partner-wide field when the marker sends null', async () => {
    await runAsAgent(orgAId, deviceAId, marker('{"ram_slot_type":"DDR5-5600"}'));

    const summary = await runAsAgent(orgAId, deviceAId, marker('{"ram_slot_type":null}'));
    expect(summary).toEqual({ applied: ['ram_slot_type'], rejected: [] });

    const [row] = await readDevice(deviceAId);
    expect((row!.customFields as Record<string, unknown>).ram_slot_type).toBeNull();
  });
});
