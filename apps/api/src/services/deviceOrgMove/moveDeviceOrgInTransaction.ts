/**
 * The device org-move transaction, shared by `POST /devices/:id/move-org`
 * (routes/devices/moveOrg.ts) and parked-device assignment
 * (services/unassignedPool/assignParkedDevice.ts).
 *
 * Runs INSIDE the caller's transaction and never opens its own. Callers own
 * every pre-transaction check, the HTTP mapping, post-commit side effects and
 * audit; this function owns the lock order and every in-transaction write:
 *
 *   SET CONSTRAINTS (by name) → users(actor, when a step-up grant is passed)
 *   → organizations(source, target ascending, FOR SHARE) → device FOR UPDATE
 *   → org flip → children.
 *
 * The statement order below is load-bearing and pinned by
 * routes/devices/moveOrg.test.ts and moveOrg.coverage.test.ts; read the
 * comments before reordering anything.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import type { db } from '../../db';
import { deviceCommands, devices, tickets } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import {
  getDeviceOrgDenormalizedTables,
  getDeviceOrgMoveDeleteTables,
  DEVICE_ORG_FK_CASCADE_TABLES,
  DEVICE_SITE_DENORMALIZED_TABLES,
} from '../../routes/devices/core';
import { terminalPayloadErasureSet } from '../sensitiveCommandPayload';
import { propagateCancelledDeviceCommands } from '../commandCancelPropagation';
import { consumeStepUpGrant, type StepUpGrantBinding } from '../mfaStepUpGrant';
import { lockActorAssurance } from '../stepUpActorAssurance';
import { dissolveLinkGroupIfBelowMinimum } from '../deviceLinkGroups';
import { readOrgStampingDefaultsMany } from '../orgCurrencyCore';
import {
  assertTicketMoveCurrencyCompatible,
  type MoveCurrencyGuardDetails,
} from '../ticketMoveCurrencyGuard';
import { assertPamDeviceOrgMoveAllowed } from '../pamDeviceMoveGuard';
import { revokeWorkstationGrantsForMove } from '../callerVerification/deviceMove';
import { revokeDiagnosticGrantsForMove } from '../diagnosticAccess/deviceMove';
import {
  checkPoolMembershipTransition,
  type PoolMembershipRefusal,
  type PoolMembershipVia,
} from '../unassignedPool/orgType';
import { assertDeviceTicketsNotPinnedToDeliverable, revalidateTicketAssignee } from '../ticketService';

export type DeviceOrgMoveTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * An organization that passed the pre-transaction existence check was gone at
 * the in-transaction SHARE lock (#3778). Rolls the move back; callers map it
 * to the same responses their pre-transaction checks return — a 404 for the
 * target, a 500 for the source (a missing source org means device.org_id
 * broke its FK).
 */
export class OrgVanishedDuringMoveError extends Error {
  constructor(public which: 'source' | 'target') {
    super(`${which} organization not found at the in-transaction org lock`);
    this.name = 'OrgVanishedDuringMoveError';
  }
}

/** Thrown inside the move transaction when the actor lock or the grant
 *  consume fails: a racing consume, or a factor reset that committed between
 *  validation and the write. Rolls the move back with no state change. */
export class MoveOrgStepUpConsumedError extends Error {
  constructor() {
    super('step-up grant could not be consumed inside the move transaction');
    this.name = 'MoveOrgStepUpConsumedError';
  }
}

/** The one-way holding-area rule refused this move under lock. Rolls back. */
export class DevicePoolMembershipRefusedError extends Error {
  readonly code: PoolMembershipRefusal['code'];
  constructor(refusal: PoolMembershipRefusal) {
    super(refusal.message);
    this.name = 'DevicePoolMembershipRefusedError';
    this.code = refusal.code;
  }
}

/**
 * How much alert-axis derived state a device org-move carried over (#4867),
 * recorded on BOTH audit rows so the source and target feeds agree.
 *
 * The held counts are split by CAUSE, because the two have different operator
 * answers (#5005):
 *
 *  - `correlationGroupsHeldSpanning` — the group still has a member alert on a
 *    device in another org. It travels by itself once that last device moves;
 *    nothing to do.
 *  - `correlationGroupsHeldKeyCollision` — the target org already holds a group
 *    with this `group_key` (`alert_correlation_groups_org_key_uq`). This one
 *    never self-resolves: the two groups need a human decision, so the number
 *    being non-zero is the signal.
 *  - `correlationMembersHeld` — this device's own membership rows that stayed
 *    behind with a held group. Members always travel with their group, so this
 *    is the count of alerts that moved without their correlation membership.
 */
export interface AlertChildOrgRewriteCounts {
  correlationGroups: number;
  correlationGroupsHeldSpanning: number;
  correlationGroupsHeldKeyCollision: number;
  correlationMembers: number;
  correlationMembersHeld: number;
  alertVerdicts: number;
}

export interface MoveDeviceOrgInput {
  deviceId: string;
  sourceOrgId: string;
  targetOrgId: string;
  targetSiteId: string;
  /** Used only in the currency-guard refusal message. */
  targetOrgName: string;
  /** The device's link group as read before the transaction (dissolved if left below minimum). */
  deviceLinkGroupId: string | null;
  acceptCurrencyMismatch: boolean | undefined;
  actor: { userId: string; allowedSiteIds: AuthContext['allowedSiteIds'] };
  /**
   * A step-up grant to consume as the FIRST row lock of the transaction, or
   * null when the caller has already consumed one itself (or 2FA is off).
   */
  stepUp: { grantId: string; binding: StepUpGrantBinding; auth: AuthContext } | null;
  via: PoolMembershipVia;
}

export interface MoveDeviceOrgResult {
  updated: typeof devices.$inferSelect | undefined;
  /** #2138/#2308 — whether the move dissolved the device's old link group. */
  linkGroupDissolved: boolean;
  /** #3776 — non-null only when a cross-currency move was accepted. */
  currencyGuard: MoveCurrencyGuardDetails | null;
  /** #4867 — non-null only when the device had alert-axis derived state. */
  alertChildRewrite: AlertChildOrgRewriteCounts | null;
  /** #3257 W05 — custom-field values re-pointed / dropped. */
  customFieldRehome: { rehomed: number; dropped: number };
}

export async function moveDeviceOrgInTransaction(
  tx: DeviceOrgMoveTx,
  input: MoveDeviceOrgInput,
): Promise<MoveDeviceOrgResult> {
  const { deviceId, sourceOrgId, targetOrgId, targetSiteId, acceptCurrencyMismatch } = input;
  let updated: typeof devices.$inferSelect | undefined;
  let linkGroupDissolved = false;
  let currencyGuard: MoveCurrencyGuardDetails | null = null;
  let alertChildRewrite: AlertChildOrgRewriteCounts | null = null;
  let customFieldRehome: { rehomed: number; dropped: number } = { rehomed: 0, dropped: 0 };

  // #4596 W2. `time_entries_ticket_org_fk` and `ticket_parts_ticket_org_fk`
  // are composite (ticket_id, org_id) -> tickets(id, org_id) and DEFERRABLE
  // INITIALLY IMMEDIATE, so they are checked at the end of EACH statement
  // unless deferred here. This path moves the device's tickets to the
  // target org and only then rewrites time_entries / ticket_parts through
  // the tickets join (~180 lines below), so with a merely IMMEDIATE check
  // the tickets UPDATE 23503s the instant it completes. Deferring to
  // COMMIT is exactly right: by then every (ticket_id, org_id) pair
  // resolves again. See moveTicketOrg in services/ticketService.ts for
  // the full rationale — this is the same invariant on the device path.
  //
  // BY NAME, never `ALL`: the requester-contact / ticket_drafts /
  // action_intents composites must stay IMMEDIATE so a newly added
  // referencing row type fails fast instead of silently at COMMIT.
  //
  // #5783 W01 adds ticket_checklist_items_ticket_org_fk — the third
  // composite (ticket_id, org_id) child FK, same shape and same reason —
  // and the Partner API tickets surface adds the fourth and fifth,
  // ticket_external_refs_ticket_org_fk and
  // partner_api_idempotency_keys_ticket_org_fk.
  //
  // The device-org cascade trigger restamps tickets.org_id before the
  // loop below can align partner_id; defer their composite FK too.
  //
  // Safe to precede the org lock below: SET CONSTRAINTS takes no table
  // locks, so it does not participate in this transaction's lock order.
  await tx.execute(
    sql`SET CONSTRAINTS time_entries_ticket_org_fk, ticket_parts_ticket_org_fk, ticket_checklist_items_ticket_org_fk, ticket_external_refs_ticket_org_fk, partner_api_idempotency_keys_ticket_org_fk, tickets_org_partner_fk DEFERRED`,
  );
  // Step-up admission (spec 2026-09-18 D3). FIRST row lock of this
  // transaction, deliberately BEFORE the organisation FOR SHARE reads
  // below: the actor's auth state is held stable until commit, and a
  // grant burned by a racing request aborts this one with no row change.
  // Lock order for this transaction is therefore
  //   users(actor) → organizations(source,target asc) → device/children.
  // `users` appears in no other mover's lock list
  // (services/ticketOrgMoveLockOrder.ts covers ticket children only), so
  // this introduces no new deadlock pair. Matches the maintenance entry
  // path (routes/devices/commands.ts), which takes the same actor lock
  // first.
  //
  // Consuming here means a later in-transaction refusal (currency,
  // PAM, deliverable-pin 409s; a vanished org) burns the grant with the
  // move rolled back. Accepted: the currency retry needs a NEW grant
  // anyway (acceptCurrencyMismatch is part of the digest), the PAM and
  // pin blocks do not clear on retry, and a vanished org is a race.
  if (input.stepUp && (!(await lockActorAssurance(tx, input.stepUp.auth, input.stepUp.binding))
    || !(await consumeStepUpGrant(input.stepUp.grantId, input.stepUp.binding)))) {
    throw new MoveOrgStepUpConsumedError();
  }
  // Creation barrier / cross-org move lock order (#3778): BOTH organizations
  // FOR SHARE, ascending UUID, as the first statement after the step-up
  // admission above —
  // before any device/ticket row is touched. Held to commit, so the
  // source/target currency pair the guard below compares cannot be
  // restamped by a concurrent changeOrgCurrency mid-move.
  const lockedOrgs = await readOrgStampingDefaultsMany(tx, [sourceOrgId, targetOrgId]);
  // `readOrgStampingDefaultsMany` deliberately OMITS ids it cannot read,
  // and the existence check above now runs OUTSIDE this transaction (that
  // pre-tx SELECT no longer reads currency). An org deleted or made
  // invisible between the two reads would turn a `!` assertion into a
  // TypeError → generic 500 + a Sentry report; re-assert here so the
  // route keeps its own 404/500 contract.
  const lockedSource = lockedOrgs.get(sourceOrgId);
  const lockedTarget = lockedOrgs.get(targetOrgId);
  if (!lockedTarget) throw new OrgVanishedDuringMoveError('target');
  if (!lockedSource) throw new OrgVanishedDuringMoveError('source');
  await assertPamDeviceOrgMoveAllowed(tx, { deviceId, sourceOrgId });
  // #5573 W02 — a ticket on this device that is a service deliverable's
  // work item pins it to the deliverable's org. `tickets` is in
  // getDeviceOrgDenormalizedTables(), so the loop below would re-stamp
  // its org_id and trip sd_occ_ticket_org_fk (deliberately NOT deferred
  // by name above) as an opaque 23503. Cheap precondition, same 409 the
  // ticket-level move answers with.
  await assertDeviceTicketsNotPinnedToDeliverable(tx, deviceId, sourceOrgId);
  const lockedSourceCurrency = lockedSource.currencyCode;
  const lockedTargetCurrency = lockedTarget.currencyCode;

  // #3257 W05 — custom-field values must be re-homed BEFORE the org flip.
  //
  // A device carries its values, but an ORG-OWNED definition does not
  // travel with it. The instant devices.org_id flips,
  // breeze_cascade_device_org_id's generic loop restamps
  // device_custom_field_values.org_id, and that table's coherence trigger
  // then correctly refuses the row because it still names the SOURCE org's
  // definition — a raw P0001 aborting the whole move. So: re-point each
  // value onto the TARGET org's identically-keyed VISIBLE definition, and
  // drop the ones with no counterpart, reporting both counts into the move
  // audit rather than losing data silently.
  //
  // The work is a DB function, not inline SQL, for two reasons it cannot
  // do from here: it reads custom_field_definitions for BOTH the source
  // and target orgs across the org/partner axis — and a request context
  // sees only its own org's rows plus, since #4944
  // (custom_field_definitions_partner_wide_select), its own partner's
  // partner-wide ones, never the other org's — and it must pre-acquire
  // BOTH orgs' partner-export locks in ascending UUID order before the
  // projection trigger requests one — the same reason
  // breeze_cascade_device_org_id pre-acquires them.
  // Values under PARTNER-WIDE definitions need no re-home while the move
  // stays inside one partner; a cross-partner move (system scope only)
  // loses that visibility too and drops them by the same rule.
  const [customFieldMove] = await tx.execute<{ rehomed: number; dropped: number }>(
    sql`SELECT rehomed, dropped
          FROM public.breeze_rehome_device_custom_field_values(
            ${deviceId}::uuid, ${targetOrgId}::uuid)`,
  );
  customFieldRehome = {
    rehomed: Number(customFieldMove?.rehomed ?? 0),
    dropped: Number(customFieldMove?.dropped ?? 0),
  };

  // #4622 — a manual asset is org-scoped hand-entered inventory bound to
  // this device by the composite FK (linked_device_id, org_id) ->
  // devices(id, org_id). Once the device leaves the org that link is not
  // merely stale but unrepresentable, so null it. The ROW survives: it
  // carries serial, asset tag, assigned contact and notes that belong to
  // the SOURCE org and must outlive the link.
  //
  // Placement is load-bearing and stricter than the
  // device_group_memberships detach further down:
  // manual_assets_linked_device_org_fk is DEFERRABLE INITIALLY IMMEDIATE
  // (the CLAUDE.md default for a composite FK referencing an org_id
  // column), so its referential check fires at the end of the `UPDATE
  // devices SET org_id` statement immediately below. A detach placed
  // after that flip — or left to breeze_cascade_device_org_id(), which
  // shares the same after-row queue as the RI check and is ordered
  // against it only by trigger name — would arrive too late and abort the
  // move with 23503.
  //
  // manual_assets has no device_id column, so the generic re-stamp loop
  // cannot reach it, and it is deliberately absent from
  // getDeviceOrgDenormalizedTables(): a link-only table is not
  // device-managed and moveOrg.coverage.test.ts reports a listed one as
  // an orphan.
  //
  // An org MERGE never reaches this route and must not detach: it runs
  // SET CONSTRAINTS ALL DEFERRED and re-points manual_assets wholesale
  // (services/orgMergeRegistry.ts REPOINT_TABLES), keeping the link valid
  // inside the survivor org.
  await tx.execute(
    sql`UPDATE manual_assets SET linked_device_id = NULL
        WHERE linked_device_id = ${deviceId}::uuid`,
  );

  // #5329 (M365 tenant sync, spec §3.4) — m365_intune_devices links a
  // Breeze device to its Intune record via the composite FK
  // (breeze_device_id, org_id) -> devices(id, org_id). Once the device
  // leaves the org that link is not merely stale but unrepresentable, so
  // null it. The ROW survives: it is the SOURCE org's Intune snapshot and
  // must outlive the link. The next Intune run in the NEW org re-links the
  // device if it is managed there.
  //
  // Placement is load-bearing, exactly as for manual_assets above: the FK
  // is DEFERRABLE INITIALLY IMMEDIATE, so its check fires at the end of
  // the `UPDATE devices SET org_id` statement immediately below.
  //
  // Unlike the manual_assets case there is no trigger-side mirror at all:
  // breeze_device_child_orgid_tables() requires a column literally named
  // `device_id`, and this one is `breeze_device_id`, so
  // breeze_cascade_device_org_id() never sees the table. This statement is
  // the only detach on any path.
  //
  // Scoped to the SOURCE org as well as the device. An org MERGE never
  // reaches this route: it deletes the loser org's m365_intune_devices
  // rows outright in the resolve phase (services/orgMergeCustomExecutors.ts).
  await tx.execute(
    sql`UPDATE m365_intune_devices SET breeze_device_id = NULL
        WHERE breeze_device_id = ${deviceId}::uuid
          AND org_id = ${sourceOrgId}::uuid`,
  );

  // #6008 W01 (Backup Provider Integration, spec "Data model" D11) —
  // backup_provider_devices links a Breeze device to its external backup
  // vendor record via the composite FK (breeze_device_id, org_id) ->
  // devices(id, org_id). Once the device leaves the org that link is not
  // merely stale but unrepresentable, so null it. The ROW survives: it is
  // the SOURCE org's provider inventory, its org_id comes from the
  // CUSTOMER MAPPING (not from this device), and the 28-day health ledger
  // hanging off it is evidence nobody should lose because a device moved.
  // The next provider sync re-links the device in the NEW org if that
  // org's customer mapping covers it.
  //
  // device_match_source is cleared WITH the link: a row carrying
  // 'auto_hostname' with no breeze_device_id would read as an unmatched
  // auto link, but leaving 'manual' behind would make W02's matcher skip
  // the row forever (manual links are never re-matched).
  //
  // Placement is load-bearing, exactly as for manual_assets and
  // m365_intune_devices above: the FK is DEFERRABLE INITIALLY IMMEDIATE,
  // so its check fires at the end of the `UPDATE devices SET org_id`
  // statement immediately below, and there is no trigger-side mirror —
  // breeze_device_child_orgid_tables() requires a column literally named
  // `device_id` and this one is `breeze_device_id`. This statement is the
  // only detach on any path.
  //
  // Scoped to the SOURCE org as well as the device. An org MERGE never
  // reaches this route: it re-points backup_provider_devices wholesale
  // (services/orgMergeRegistry.ts REPOINT_TABLES) under SET CONSTRAINTS
  // ALL DEFERRED, keeping the link valid inside the survivor org.
  await tx.execute(
    sql`UPDATE backup_provider_devices
        SET breeze_device_id = NULL, device_match_source = NULL
        WHERE breeze_device_id = ${deviceId}::uuid
          AND org_id = ${sourceOrgId}::uuid`,
  );

  // #8165 (EDR provider framework W01, spec D4/D14) — same contract as the
  // backup_provider_devices detach above, for the three EDR link tables:
  // each carries (breeze_device_id, org_id) -> devices(id, org_id)
  // DEFERRABLE INITIALLY IMMEDIATE, nothing trigger-side mirrors a
  // breeze_device_id column, so these statements are the only detach and must
  // precede the org flip below. The ROWS stay in the source org — their org_id
  // comes from the vendor tenant mapping, not from this device — and the next
  // EDR sync re-links the device in the new org if that org's mapping covers
  // it. device_match_source is cleared with the endpoint link for the reason
  // given above.
  //
  // Detections additionally snapshot the device's CURRENT site (this runs
  // before the devices UPDATE below, so site_id is still the source site):
  // a finding that turned into a null-device row would otherwise be visible
  // to every site-restricted technician in the org (spec §4.7, D14 — never
  // widen visibility as a side effect).
  //
  // An org MERGE never reaches this route: it re-points all four EDR org
  // tables wholesale (orgMergeRegistry.ts REPOINT_TABLES).
  await tx.execute(
    sql`UPDATE edr_endpoints
        SET breeze_device_id = NULL, device_match_source = NULL
        WHERE breeze_device_id = ${deviceId}::uuid
          AND org_id = ${sourceOrgId}::uuid`,
  );
  await tx.execute(
    sql`UPDATE edr_detections
        SET breeze_device_id = NULL, device_detached_at = now(),
            last_site_id = (SELECT site_id FROM devices WHERE id = ${deviceId}::uuid)
        WHERE breeze_device_id = ${deviceId}::uuid
          AND org_id = ${sourceOrgId}::uuid`,
  );
  await tx.execute(
    sql`UPDATE edr_actions
        SET breeze_device_id = NULL
        WHERE breeze_device_id = ${deviceId}::uuid
          AND org_id = ${sourceOrgId}::uuid`,
  );

  // Caller verification (#6354 W01): lock the device row and revoke the
  // source org's workstation authorization BEFORE the org flip. The
  // FOR UPDATE here is load-bearing — nothing above locks the device
  // row, and a concurrent `start` holds a FOR SHARE on it until its
  // grant INSERT commits, so the hook's snapshot cannot miss an
  // in-flight grant. Lock order stays orgs → device → subject bindings.
  const [callerMoveDevice] = await tx
    .select({ orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1)
    .for('update');
  if (callerMoveDevice?.orgId !== sourceOrgId) {
    throw new Error('Device organization changed during move');
  }
  // Holding-area membership is one-way, re-checked here under the org SHARE
  // locks taken above (held to commit) and the device row lock just taken, so
  // no caller of this engine can move a device into a holding org, or out of
  // one other than by assignment, whatever its own pre-checks did.
  const poolRefusal = checkPoolMembershipTransition({
    sourceOrgType: lockedSource.type,
    targetOrgType: lockedTarget.type,
    via: input.via,
  });
  if (poolRefusal) throw new DevicePoolMembershipRefusedError(poolRefusal);
  await revokeWorkstationGrantsForMove(tx, sourceOrgId, deviceId);
  await revokeDiagnosticGrantsForMove(tx, sourceOrgId, deviceId, input.actor.userId);

  // Flip the device row first so any concurrent agent heartbeat
  // after this point resolves the new org_id.
  const [row] = await tx
    .update(devices)
    .set({
      orgId: targetOrgId,
      siteId: targetSiteId,
      // #2138 — a device leaving its org can no longer be a boot profile
      // of a machine in the OLD org. Unlink it here; the composite FK
      // (link_group_id, org_id) -> device_link_groups(id, org_id) would
      // otherwise fail the org flip. The source group is dissolved below
      // if it drops below the two-profile minimum (or, for vm_host
      // groups, if this device WAS the host — #2308). Role travels with
      // membership, so it clears too.
      linkGroupId: null,
      linkGroupRole: null,
      updatedAt: new Date(),
    })
    .where(eq(devices.id, deviceId))
    .returning();
  updated = row;

  // #5128 — cancel this device's queued work in the SAME transaction as
  // the org flip. Claim-time eligibility already refuses to deliver a row
  // whose `submitted_org_id` no longer matches, so this is cleanup rather
  // than the safety property: it stops the rows sitting `pending` until
  // their deadline and shows the operator the truth immediately. Rows are
  // erased of payload like any other terminal transition.
  // Read id/type/payload BEFORE the erasing UPDATE: the propagation below
  // keys on `payload.executionId`, and `terminalPayloadErasureSet()`
  // strips it (`returning()` reflects post-update values).
  // `self_uninstall` is EXCLUDED, matching the decommission path in
  // core.ts: the uninstall drain must still deliver. A device moved out
  // of an org while its removal is queued still has to lose its agent —
  // cancelling that row leaves the customer's machine managed by an MSP
  // that no longer owns it.
  const cancelledForMove = await tx
    .select({
      id: deviceCommands.id,
      type: deviceCommands.type,
      payload: deviceCommands.payload,
    })
    .from(deviceCommands)
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.status, 'pending'),
        ne(deviceCommands.type, 'self_uninstall'),
      ),
    );

  const moveCancelledAt = new Date();
  await tx
    .update(deviceCommands)
    .set({
      status: 'cancelled',
      completedAt: moveCancelledAt,
      result: { status: 'cancelled', reason: 'device_moved_org', cancelledBy: 'device_move_org' },
      ...terminalPayloadErasureSet(),
    })
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.status, 'pending'),
        ne(deviceCommands.type, 'self_uninstall'),
      ),
    );

  // Terminalise the OWNING records too, in this same transaction. Without
  // this a cancelled command leaves its script_executions /
  // deployment_results row `pending` forever: the command reaper only
  // scans `pending`/`sent` commands, so nothing would ever revisit it.
  await propagateCancelledDeviceCommands(
    cancelledForMove.map((row) => ({
      id: row.id,
      type: row.type,
      payload: row.payload as Record<string, unknown> | null,
    })),
    moveCancelledAt,
    tx,
  );

  // #2138 — if the moved device left a link group with a single lone
  // profile behind — or it was a vm_host group's HOST (#2308), leaving
  // the group headless — that group is no longer meaningful: dissolve it.
  if (input.deviceLinkGroupId) {
    linkGroupDissolved = await dissolveLinkGroupIfBelowMinimum(
      tx,
      input.deviceLinkGroupId,
      input.actor.allowedSiteIds,
    );
  }

  // Agent-run history stays with the SOURCE org (ruled 2026-08-23):
  // runs are not re-stamped (org_id is trigger-immutable, and re-stamping
  // would 23503 against the action_intents composite tenant FK the moment an
  // agent proposal exists). Sever ALL device-lineage links, not just
  // device_id: alerts, ai_sessions, and metric_anomaly_incidents ARE
  // re-stamped to the target org by the loop below, so a retained
  // source-org run keeping alert_id/session_id/anomaly_incident_id would
  // point across tenants (and /ai-agents/:id/runs would serve those
  // foreign ids to the source org). ticket_id is the fifth such FK but
  // needs a different WHERE — see the statement below. All five FKs are
  // ON DELETE SET NULL — nullable by design.
  await tx.execute(
    sql`UPDATE ai_agent_runs SET device_id = NULL, alert_id = NULL, session_id = NULL, anomaly_incident_id = NULL
        WHERE device_id = ${deviceId}::uuid`,
  );

  // #5022 W01: script_executions IS re-stamped to the target org (it is
  // in CORE_DEVICE_ORG_DENORMALIZED_TABLES, core.ts), but ai_agent_runs
  // deliberately is NOT (the statement directly above), and ai_sessions
  // is re-stamped only when it is device-bound — a device-less chat
  // session stays behind. Either way a moved execution can end up
  // pointing at a session or run in a DIFFERENT tenant, and
  // /devices/:id/scripts would then serve a foreign id to the target
  // org. Sever both pointers; RETAIN ai_initiator_kind, so the fact that
  // an AI did the work survives the move while the cross-tenant pointer
  // does not.
  //
  // Like the ai_agent_runs statement above, this normally matches
  // NOTHING: the devices row was already flipped earlier in this same
  // transaction, firing breeze_cascade_device_org_id(), whose body
  // carries an identical statement (2026-10-16-182100-ai-origin-
  // attribution.sql). Kept as a route-local mirror so the detach is
  // visible where the move is read, and so the route still detaches if
  // the trigger is dropped. Both copies are convergent — whichever runs
  // first wins and the other matches nothing.
  await tx.execute(
    sql`UPDATE script_executions
           SET ai_session_id = NULL, ai_agent_run_id = NULL
         WHERE device_id = ${deviceId}::uuid
           AND (ai_session_id IS NOT NULL OR ai_agent_run_id IS NOT NULL)`,
  );

  // AI Operator task history stays with the SOURCE org too (#5205 W03,
  // #5208), for the same reason agent runs do — and with one addition
  // the runs statement above does not need: a task is LIVE work, not a
  // finished record. A task still queued/running/waiting/paused holds a
  // lease and a next_wake_at, so leaving it alone would let the
  // coordinator keep acting on a device that now belongs to a different
  // tenant. Sever the pointer, record WHY (the frozen target_label is
  // retained, so the evidence still says what it was pointed at), and
  // fence the task to `stopping` — spec §6.1's "cancel, expiry, handoff,
  // authority loss" edge. `stopping` is deliberately NOT terminal: an
  // in-flight device command may still return, and its result must land
  // on the operation row before the reconciler settles the task (§6.3).
  //
  // This normally matches NOTHING, exactly like the ai_agent_runs
  // statement above and UNLIKE the load-bearing invoice_line_devices one
  // below: the devices row was already flipped earlier in this same
  // transaction, which fired breeze_cascade_device_org_id(), and that
  // trigger carries an identical statement (the migration's section 8).
  // It is kept as a route-local mirror so the detach is visible where
  // the move is read, and so the route still detaches if the trigger is
  // ever dropped. The trigger copy is the one that also covers a DIRECT
  // devices.org_id UPDATE that never reaches this engine — which is
  // why the integration coverage drives that path.
  //
  // Both copies are convergent (COALESCE on the detach stamp, CASE on
  // the state), so whichever runs first wins and the other is a no-op.
  await tx.execute(
    sql`UPDATE ai_operator_tasks
           SET device_id = NULL,
               target_detached_at = COALESCE(target_detached_at, now()),
               target_detached_reason = COALESCE(target_detached_reason, 'device_moved'),
               state = CASE WHEN state IN ('queued', 'running', 'waiting', 'paused') THEN 'stopping' ELSE state END,
               updated_at = now()
         WHERE device_id = ${deviceId}::uuid`,
  );

  // Recipe library E2 (#6167): the same detach one level down, on BOTH
  // pointer axes a device move reaches. Normally matches NOTHING —
  // breeze_cascade_device_org_id() already ran when the devices row
  // flipped earlier in this transaction and carries identical statements
  // (migration 2026-10-26-160000 section 9). Kept as a route-local
  // mirror for the same two reasons the task statement above is: the
  // detach is visible where the move is read, and the route still
  // detaches if the trigger is ever dropped. Both copies are convergent
  // (COALESCE on the stamp), so whichever runs first wins.
  //
  // A target's org_id IS its task's immutable org_id, so it never
  // re-stamps; the pointer is severed and the frozen target_label kept.
  await tx.execute(
    sql`UPDATE ai_operator_task_targets
           SET device_id = NULL,
               detached_at = COALESCE(detached_at, now()),
               detached_reason = COALESCE(detached_reason, 'device_moved'),
               state = 'detached',
               updated_at = now()
         WHERE device_id = ${deviceId}::uuid`,
  );
  // Ticket-axis twin: a ticket bound to this device follows it to the
  // destination org (the trigger's generic loop), while a target naming
  // that ticket stays with its source-org task. target.ticket_id is a
  // PLAIN FK, so a stale pointer would otherwise survive in silence.
  await tx.execute(
    sql`UPDATE ai_operator_task_targets
           SET ticket_id = NULL,
               detached_at = COALESCE(detached_at, now()),
               detached_reason = COALESCE(detached_reason, 'scope_invalidated'),
               state = 'detached',
               updated_at = now()
         WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
  );

  // #3205 W07: billing evidence stays in the INVOICE's org — the invoice
  // and its lines do not move. UNLIKE the ai_agent_runs statement above,
  // which normally matches nothing because breeze_cascade_device_org_id()
  // has already run, this one is LOAD-BEARING: invoice_line_devices is
  // excluded from breeze_device_child_orgid_tables()
  // (2026-10-08-101300-device-move-exclude-billing-evidence.sql), so the trigger leaves the row entirely alone
  // and nothing else severs the now-cross-tenant device pointer. The row
  // keeps its hostname and device_role, so the past invoice stays legible.
  await tx.execute(
    sql`UPDATE invoice_line_devices SET device_id = NULL WHERE device_id = ${deviceId}::uuid`,
  );

  // ticket_id is the fifth device-lineage FK and needs its OWN statement
  // (#4215): `tickets` is in getDeviceOrgDenormalizedTables(), so a
  // ticket bound to this device is re-stamped to the target org by the
  // loop below — but ticket-triggered runs are device-less
  // (trigger_kind 'ticket' stamps ticket_id and leaves device_id NULL),
  // so the device-keyed detach above cannot reach them and the retained
  // source-org run would keep pointing at a now-foreign ticket. Keying
  // off the ticket's own device_id catches BOTH the device-less ticket
  // runs and device runs on the same ticket, and touches nothing whose
  // ticket stays behind in the source org. Same tickets-join shape as
  // the ticket_attachments/time_entries/ticket_parts rewrites further
  // down.
  //
  // Ordering: breeze_cascade_device_org_id() is an AFTER ... FOR EACH ROW
  // trigger on the devices UPDATE above, so it has ALREADY run this same
  // detach (and restamped tickets.org_id) by the time this statement is
  // sent — the route's copy normally matches nothing, exactly as
  // 2026-09-06-a notes for the device-keyed detach beside it. It is kept
  // so the route path stays correct on its own if the trigger is ever
  // absent, and placed here to mirror the trigger's internal order. The
  // subselect still resolves post-restamp: the devices UPDATE that got us
  // here already required source USING + target WITH CHECK, so the
  // request context spans both orgs.
  await tx.execute(
    sql`UPDATE ai_agent_runs SET ticket_id = NULL
        WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
  );

  // Reverse pointer: metric_anomaly_incidents.agent_run_id (no FK) must
  // not keep naming a source-org run once the incident row itself is
  // re-stamped to the target org by the denormalized-table loop below —
  // same cross-tenant-pointer class as the ai_agent_runs detach above,
  // just the other direction of the link. Must run BEFORE that loop so
  // it targets the incident by its still-source device_id.
  await tx.execute(
    sql`UPDATE metric_anomaly_incidents SET agent_run_id = NULL WHERE device_id = ${deviceId}::uuid`,
  );

  // Reverse pointer: ticket_comments.agent_run_id (#4644). ticket_comments
  // has no org_id (child-via-parent tenancy through tickets), so a comment
  // on a ticket bound to this device travels to the target org via the
  // denormalized-table loop below while the run it names stays with the
  // SOURCE org — same reverse-pointer class as metric_anomaly_incidents
  // above, and the mirror image of moveTicketOrg's own ticket_comments
  // detach (ticketService.ts) on the ticket axis. Same
  // `ticket_id IN (SELECT id FROM tickets WHERE device_id = ...)` join the
  // ai_agent_runs.ticket_id detach above uses, so it reaches comments on
  // both device-less and device-bound ticket runs alike.
  await tx.execute(
    sql`UPDATE ticket_comments SET agent_run_id = NULL
        WHERE agent_run_id IS NOT NULL
          AND ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
  );

  // action_intents.scope_device_id (P2-2, #4189): same cross-tenant-
  // pointer class as the two detaches above — an intent whose target
  // device just moved to a different org must not keep pointing at it.
  // The immutability trigger (action_intents_block_content_update())
  // permits exactly this transition (non-null -> NULL is the ONE
  // allowed change to scope_device_id; see actionIntents.ts's column
  // comment), so this UPDATE is the tombstone path the trigger allows.
  //
  // Scoped to LIVE statuses only (pending_approval/approved/executing):
  // a terminal-status intent (completed/failed/rejected/expired/
  // cancelled) is a historical record of an action already decided —
  // its target device at decision time is a fact, not something a
  // future release path re-validates, so leaving it alone matches how
  // ai_agent_runs' org_id is left un-restamped for the same reason
  // above. Only a LIVE intent can still reach the release path
  // (intentTargetScope.ts, Task A3), which fails closed on a NULL
  // scope_device_id (tombstone) or an org mismatch — this UPDATE is
  // what produces that tombstone instead of leaving a dangling
  // cross-tenant device id for release to silently act on.
  await tx.execute(
    sql`UPDATE action_intents SET scope_device_id = NULL
        WHERE scope_device_id = ${deviceId}::uuid
          AND status IN ('pending_approval', 'approved', 'executing')`,
  );

  // tickets.requester_contact_id (#3258 W03): the requester CONTACT is
  // org-pinned (`tickets_requester_contact_org_fk` is the composite
  // (requester_contact_id, org_id) -> contacts(id, org_id), DEFERRABLE
  // INITIALLY IMMEDIATE) and does NOT travel with the device, so the
  // org_id re-stamp below would 23503 on any contact-linked ticket. The
  // ticket keeps its submitter name/email snapshot — only the live link
  // is dropped, which is the same ruling moveTicketOrg applies.
  //
  // Ordering: breeze_cascade_device_org_id() is an AFTER ... FOR EACH ROW
  // trigger on the devices UPDATE above, so it has ALREADY run this same
  // detach AND the org re-stamp — this statement normally matches
  // nothing, exactly like the ai_agent_runs detaches beside it. Kept so
  // the route path stays correct on its own if the trigger is ever
  // absent, and placed immediately before the generic loop to mirror the
  // trigger's internal order (the detach cannot follow the re-stamp: the
  // re-stamp is the statement that trips the constraint).
  //
  // No merge fence check here, unlike the trigger: org merge never calls
  // this route (the loser org is fenced into 'merging', which the device
  // routes refuse), so the only caller is a genuine cross-org move.
  await tx.execute(
    sql`UPDATE tickets SET requester_contact_id = NULL
        WHERE device_id = ${deviceId}::uuid
          AND requester_contact_id IS NOT NULL
          AND org_id IS DISTINCT FROM ${targetOrgId}::uuid`,
  );

  // action_intents.scope_ticket_id (#4792): composite FK (scope_ticket_id,
  // org_id) -> tickets(id, org_id) (action_intents_scope_ticket_org_fk,
  // migrations/2026-09-25-ai-agents-ticket-triage.sql), DEFERRABLE
  // INITIALLY IMMEDIATE and deliberately NOT named in the SET CONSTRAINTS
  // above (by-name, never ALL — see that comment): a newly added
  // referencing row type must still fail fast, not silently at COMMIT.
  // `tickets` IS in getDeviceOrgDenormalizedTables(), so the loop below
  // re-stamps tickets.org_id for every ticket bound to this device — the
  // instant that statement completes, ANY remaining scope_ticket_id
  // pointer (regardless of status; unlike scope_device_id above, this FK
  // does not care about status) names a (ticketId, OLD org_id) pair that
  // no longer exists in `tickets`, and the tickets UPDATE itself 23503s
  // and aborts the whole move. Same invariant, same fix, as
  // moveTicketOrg's identical detach for the ticket-level move
  // (services/ticketService.ts) — ALL statuses, unconditionally, and run
  // BEFORE the re-stamp that would otherwise trip the constraint. The
  // immutability trigger (action_intents_block_content_update()) permits
  // exactly this non-null -> NULL transition regardless of scope_ticket_id
  // vs scope_device_id, so this is the tombstone path the trigger allows.
  await tx.execute(
    sql`UPDATE action_intents SET scope_ticket_id = NULL
        WHERE scope_ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
  );

  // #3182 — a device that has LEFT org A cannot remain a member of org
  // A's device group, and device_group_memberships_group_org_fk
  // ((group_id, org_id) -> device_groups(id, org_id)) now says so
  // structurally. Delete, never re-point: device_groups.org_id is NOT
  // NULL with no partner axis, groups nest and can be site-bound, and
  // there is no deterministic source-group -> target-group mapping.
  // Dynamic groups in the TARGET org re-materialize on their own next
  // evaluation.
  //
  // Placement is load-bearing, same class as the scope_ticket_id
  // tombstone above: `device_group_memberships` IS returned by
  // breeze_device_child_orgid_tables(), so the loop immediately below
  // would otherwise re-stamp these rows' org_id to the target org while
  // their group_id still names a SOURCE-org group — 23503, aborting the
  // whole move.
  //
  // Ordering: breeze_cascade_device_org_id() is an AFTER ... FOR EACH ROW
  // trigger on the devices UPDATE above, so it has ALREADY performed this
  // same delete by the time this statement is sent — the route's copy
  // normally matches nothing, exactly as for the tombstones beside it. It
  // is kept so the route stays correct on its own if the trigger is ever
  // absent, and placed here to mirror the trigger's internal order.
  //
  // Unfenced, unlike the trigger's merging-org check: an org merge never
  // reaches this route, and repoints devices, device_groups and
  // device_group_memberships together instead
  // (services/orgMergeRegistry.ts).
  //
  // device_group_memberships deliberately STAYS in
  // getDeviceOrgDenormalizedTables(): the loop's UPDATE below now matches
  // nothing, and is retained as the backstop for any devices.org_id
  // writer that somehow reaches the loop without this delete.
  await tx.execute(
    sql`DELETE FROM device_group_memberships WHERE device_id = ${deviceId}::uuid`,
  );

  // device_function_assessments.run_id anchors
  // device_function_assessments_run_org_fk ((run_id, org_id) ->
  // ai_agent_runs(id, org_id)), DEFERRABLE INITIALLY IMMEDIATE.
  // ai_agent_runs stays with the SOURCE org on a device move (owner
  // decision 2026-08-23, same rule as the ai_agent_runs statement
  // below), so once the loop just below re-stamps
  // device_function_assessments.org_id to the target org (it IS in
  // getDeviceOrgDenormalizedTables()), the composite pair no longer
  // resolves and that loop's own UPDATE 23503s before it can complete,
  // aborting the whole move. Sever the pointer first — normally a no-op
  // by the time this runs, since the devices UPDATE above already fired
  // breeze_cascade_device_org_id(), which carries the identical
  // statement; kept so the route stays correct on its own if the
  // trigger is ever absent, same convergent-copy shape as the
  // ai_agent_runs statement below.
  await tx.execute(
    sql`UPDATE device_function_assessments SET run_id = NULL
        WHERE device_id = ${deviceId}::uuid AND run_id IS NOT NULL`,
  );

  // Rewrite the denormalized org_id on every device-scoped table.
  // Skipping any of these strands pre-existing rows under RLS.
  for (const table of getDeviceOrgDenormalizedTables()) {
    // Immutable evidence revokes app-role UPDATE. Its composite FK uses
    // ON UPDATE CASCADE, so the devices row flip above already performed
    // the trusted org-only restamp inside this transaction.
    if (DEVICE_ORG_FK_CASCADE_TABLES.includes(table)) continue;
    if (table === 'tickets') {
      // Deliberately NOT filtered on `org_id IS DISTINCT FROM` like the
      // generic branch below: breeze_cascade_device_org_id() has already
      // re-stamped tickets.org_id but not partner_id, and the RETURNING ids
      // drive assignee revalidation. A filter would skip every ticket the
      // trigger moved. Tickets per device are few, so the rewrite is cheap.
      // Read the target partner live under the org SHARE lock above.
      const movedTickets = await tx.execute<{ id: string }>(
        sql`UPDATE ${sql.identifier(table)} SET org_id = ${targetOrgId}::uuid,
            partner_id = (SELECT partner_id FROM organizations WHERE id = ${targetOrgId}::uuid)
            WHERE device_id = ${deviceId}::uuid RETURNING id`,
      );
      for (const ticket of movedTickets) {
        await revalidateTicketAssignee(ticket.id, { kind: 'user', userId: input.actor.userId }, tx);
      }
    } else {
      // The devices UPDATE above already fired breeze_cascade_device_org_id(),
      // which re-stamps every breeze_device_child_orgid_tables() row with the
      // same IS DISTINCT FROM filter. Without it here, every child row
      // (including high-volume telemetry such as device_metrics, agent_logs
      // and device_event_logs) was rewritten a second time, which is what
      // pushed online-device moves past the web client's timeout (#7988).
      // The loop still re-stamps any row the trigger did not reach.
      await tx.execute(
        sql`UPDATE ${sql.identifier(table)} SET org_id = ${targetOrgId}::uuid
            WHERE device_id = ${deviceId}::uuid AND org_id IS DISTINCT FROM ${targetOrgId}::uuid`,
      );
    }
  }

  // device_vulnerabilities.ticket_id (#4645): `device_vulnerabilities` IS
  // in getDeviceOrgDenormalizedTables(), so the loop just above already
  // re-stamped org_id to the TARGET org for every finding on this device
  // — the finding row itself always travels with the device. Its
  // remediation ticket does NOT: vulnerability-remediation tickets are
  // created org-scoped only (`POST /vulnerabilities/tickets` never sets
  // `tickets.device_id`), so `tickets` denormalized-table loop above
  // never reaches them and they stay put in whatever org they were
  // created in. Once the finding's org_id is the target org, a ticket_id
  // still naming a SOURCE-org ticket resolves to nothing under RLS for
  // any caller in the target org — the reverse of moveTicketOrg's own
  // device_vulnerabilities detach (services/ticketService.ts) on the
  // ticket axis.
  //
  // Placement — AFTER the loop above, not before: comparing against
  // `t.org_id` (rather than the finding's own, already-rewritten
  // org_id) means a ticket that DOES happen to be bound to this device
  // (`tickets.device_id = deviceId`, and therefore re-stamped to the
  // target org by that same loop, since `tickets` is also a member) is
  // correctly left alone — its org now matches the finding's, so the
  // link is still valid. Checking before the loop would see the ticket's
  // stale SOURCE org and wrongly null a link that is about to become
  // valid. Same `org_id IS DISTINCT FROM` precision as moveTicketOrg's
  // mirror statement and the tickets.requester_contact_id detach above.
  //
  // Plain single-column `ON DELETE SET NULL` FK (not composite
  // tenant-FK'd), so this can never 23503 either way.
  await tx.execute(
    sql`UPDATE device_vulnerabilities dv SET ticket_id = NULL
        FROM tickets t
        WHERE dv.device_id = ${deviceId}::uuid
          AND dv.ticket_id = t.id
          AND t.org_id IS DISTINCT FROM ${targetOrgId}::uuid`,
  );

  // Extension tables that must be DELETED (not re-stamped) on org-move: their rows
  // FK a source/config row that stays in the old org, so rewriting org_id would
  // corrupt cross-row consistency. See the extension tenancy docs.
  for (const table of getDeviceOrgMoveDeleteTables()) {
    await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE device_id = ${deviceId}`);
  }

  // Ticket-linked billing rows denormalize org_id from their ticket (Phase 3 spec §2);
  // tickets bound to this device move org with it, so these must follow —
  // same stranded-org_id class as ticket_alert_links (#1261).
  //
  // Wave 4 (#3776): org_id only — currency_code is a snapshot and is NOT
  // rewritten. Lock order is global (tickets → time_entries → ticket_parts):
  // the tickets row lock was taken by the denormalized-table loop above, the
  // guard locks the two source tables in that order, and only then are they
  // rewritten — the same order moveTicketOrg uses, so a concurrent ticket move
  // or issueInvoice serializes instead of deadlocking. Accepted mismatches stay
  // invoiceable only through an old-currency draft (assembleDraftFromOrg
  // currencyCode override).
  const ticketIds = (
    await tx.select({ id: tickets.id }).from(tickets).where(eq(tickets.deviceId, deviceId))
  ).map((r) => r.id);
  currencyGuard = await assertTicketMoveCurrencyCompatible(tx, {
    ticketIds,
    sourceCurrency: lockedSourceCurrency,
    targetCurrency: lockedTargetCurrency,
    targetOrgName: input.targetOrgName,
    acceptCurrencyMismatch: acceptCurrencyMismatch === true,
  });
  await tx.execute(
    sql`UPDATE ${sql.identifier('time_entries')} SET org_id = ${targetOrgId}::uuid WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
  );
  await tx.execute(
    sql`UPDATE ${sql.identifier('ticket_parts')} SET org_id = ${targetOrgId}::uuid WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
  );

  // ticket_alert_links denormalizes org_id for RLS but has no device_id
  // column, so the generic loop above can't reach it — rewrite via the
  // alert join instead. Excluded from getDeviceOrgDenormalizedTables();
  // tracked in CUSTOM_ORG_REWRITE_TABLES (core.ts).
  //
  // Placed AFTER ticket_parts, not before the guard where it used to sit
  // (#4657). moveTicketOrg — the twin path in services/ticketService.ts —
  // re-stamps this same table from its TICKET_ORG_DENORMALIZED_TABLES loop,
  // i.e. after its own time_entries/ticket_parts writes, and the two
  // movers' rows genuinely overlap: a link row joining ticket X to an alert
  // raised on device D is selected both by this statement's alert join and
  // by a concurrent moveTicketOrg(X)'s `ticket_id = X`. Taking it on
  // opposite sides of time_entries/ticket_parts was a live AB-BA that
  // Postgres resolves by killing one transaction with 40P01 — a 500 on an
  // admin action. The canonical order both paths now follow, and why it
  // resolves this way round rather than the other, is documented once in
  // services/ticketOrgMoveLockOrder.ts.
  //
  // The move past the currency guard is safe: the guard only touches
  // time_entries/ticket_parts, and a guard throw rolls the whole
  // transaction back, so nothing is left half-restamped. The alert
  // subselect still resolves after the generic loop re-stamped `alerts` —
  // alerts.device_id is not what the loop changes, and the request context
  // spans both orgs (same argument as the ai_agent_runs subselect above).
  //
  // A SITE-OWNED topology policy alert (M3-D6, topology_site_id set) does
  // not move: its ownership guard keeps it in its site's org while the
  // origin device (provenance only) leaves, so its link stays with it.
  await tx.execute(
    sql`UPDATE ${sql.identifier('ticket_alert_links')} SET org_id = ${targetOrgId}::uuid WHERE alert_id IN (SELECT id FROM alerts WHERE device_id = ${deviceId}::uuid AND topology_site_id IS NULL)`,
  );

  // ticket_outbox (#4743) denormalizes org_id from its ticket and has no
  // device_id; tickets bound to this device move org, so any unpublished
  // outbox row for one of those tickets must follow via the tickets
  // join, or it keeps routing to the source org's helpdesk agents after
  // the move (same class as ticket_alert_links, #3828 wave-6-3). Placed
  // AFTER ticket_alert_links and BEFORE ticket_attachments to match this
  // table's position in TICKET_ORG_DENORMALIZED_TABLES
  // (ticketService.ts) — [..., 'ticket_alert_links', 'ticket_outbox',
  // 'ticket_attachments'] — so this path and moveTicketOrg's loop touch
  // the ticket-linked child tables in the same relative order; see the
  // lock-order comment at moveOrg.ts:~311.
  await tx.execute(
    sql`UPDATE ${sql.identifier('ticket_outbox')} SET org_id = ${targetOrgId}::uuid WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
  );

  // ticket_attachments (W08 #3902) denormalizes org_id from its ticket and
  // has no device_id; tickets bound to this device move org, so their
  // attachment rows follow via the tickets join. Placed LAST to extend —
  // not reorder — the documented global lock order (tickets ->
  // time_entries -> ticket_parts -> ticket_alert_links -> ticket_outbox ->
  // ticket_attachments); the moveTicketOrg loop appends it last for the
  // same reason. S3 objects are keyed by attachment id only (spec D8) and
  // are not touched.
  await tx.execute(
    sql`UPDATE ${sql.identifier('ticket_attachments')} SET org_id = ${targetOrgId}::uuid WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
  );

  // ticket_email_links (#4643) denormalizes org_id from its ticket and
  // has no device_id; tickets bound to this device move org, so their
  // email-link rows must follow via the same tickets join, or the
  // source org keeps read access to this device's ticket-thread
  // metadata after the move (and the target org loses it). Placed
  // AFTER ticket_attachments to extend — not reorder — the documented
  // global lock order (tickets -> time_entries -> ticket_parts ->
  // ticket_alert_links -> ticket_outbox -> ticket_attachments ->
  // ticket_email_links); moveTicketOrg's loop appends it last for the
  // same reason. Inbound-email threading
  // (threadMatcher.ts) resolves by (partner_id, message_id) under a
  // system context off the live tickets.org_id, never off this row's
  // org_id, so re-stamping it here does not touch that contract.
  await tx.execute(
    sql`UPDATE ${sql.identifier('ticket_email_links')} SET org_id = ${targetOrgId}::uuid WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
  );

  // ticket_checklist_items (#5783 W01) denormalizes org_id from its
  // ticket and has no device_id, so neither the generic loop nor
  // breeze_cascade_device_org_id() (which discovers its tables BY the
  // device_id column) reaches it. Tickets bound to this device move org,
  // so their checklist rows must follow via the same tickets join, or the
  // source org keeps read access to this device's checklist steps after
  // the move and the target org loses them. Placed AFTER
  // ticket_email_links to extend — not reorder — the documented global
  // lock order; moveTicketOrg's loop appends it last for the same reason.
  //
  // Unlike the statements above, this table's FK is composite and
  // DEFERRABLE INITIALLY IMMEDIATE, which is why
  // ticket_checklist_items_ticket_org_fk is named in this transaction's
  // SET CONSTRAINTS … DEFERRED at the top.
  await tx.execute(
    sql`UPDATE ${sql.identifier('ticket_checklist_items')} SET org_id = ${targetOrgId}::uuid WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
  );

  // ticket_external_refs (Partner API tickets) denormalizes org_id from its
  // ticket and has no device_id, so it follows via the same tickets join.
  // Placed AFTER ticket_checklist_items to extend — not reorder — the
  // documented global lock order; moveTicketOrg's loop and the org-merge
  // walk (TICKET_CHILD_ORG_REWRITE_LOCK_ORDER) append it last for the same
  // reason. Its composite (ticket_id, org_id) FK is DEFERRABLE INITIALLY
  // IMMEDIATE, which is why ticket_external_refs_ticket_org_fk is named in
  // this transaction's SET CONSTRAINTS … DEFERRED at the top.
  //
  // A ref is pinned to ONE partner — its principal's — by the composite
  // (org_id, partner_id) FK. On a cross-partner move (system scope only) it
  // cannot follow: the integration that owns it can never read the ticket
  // again, and the row would otherwise pin its external id forever, so it is
  // deleted first. Inside one partner this deletes nothing. (Table name
  // spelled literally: the identifier form is reserved for the one re-stamp
  // per CUSTOM_ORG_REWRITE_TABLES entry that the lock-order tests pin.)
  await tx.execute(
    sql`DELETE FROM ticket_external_refs WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid) AND partner_id IS DISTINCT FROM (SELECT partner_id FROM organizations WHERE id = ${targetOrgId}::uuid)`,
  );
  await tx.execute(
    sql`UPDATE ${sql.identifier('ticket_external_refs')} SET org_id = ${targetOrgId}::uuid WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
  );

  // partner_api_idempotency_keys (Partner API tickets): an X-Idempotency-Key
  // claim bound to its ticket (ticket_id) with a denormalized org_id and no
  // device_id — same tickets join, appended AFTER ticket_external_refs to
  // extend the shared lock order. A claim whose ticket_id is still null (a
  // create that has not linked yet) is invisible to other transactions, so
  // nothing is left behind. Like a ref, a claim's org follows its ticket's
  // (partner_api_idempotency_keys_ticket_org_fk, deferred at the top) and it
  // is pinned to its principal's partner by a composite (org_id, partner_id)
  // FK, so on a cross-partner move it is deleted rather than re-stamped.
  await tx.execute(
    sql`DELETE FROM partner_api_idempotency_keys WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid) AND partner_id IS DISTINCT FROM (SELECT partner_id FROM organizations WHERE id = ${targetOrgId}::uuid)`,
  );
  await tx.execute(
    sql`UPDATE ${sql.identifier('partner_api_idempotency_keys')} SET org_id = ${targetOrgId}::uuid WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
  );

  // #4867 — the ALERT-axis children (ALERT_CHILD_ORG_REWRITE_TABLES in
  // core.ts): alert_correlation_groups, alert_correlation_members and
  // ai_alert_verdicts all denormalize org_id but have NO device_id
  // column, so neither the generic loop above nor the DB-side
  // breeze_cascade_device_org_id() trigger (which discovers its tables BY
  // that device_id column) can reach them. Every alert-facing reader pins
  // these rows to the ALERT's org — hideAiNoiseCondition /
  // correlationMetadataCondition (routes/alerts/alerts.ts) and
  // latestVerdictsForAlerts / latestVerdictForGroup
  // (services/aiAgents/alertVerdicts.ts) — so a row left behind is
  // invisible to the org that now owns the alert: the moved alert
  // silently loses its AI-noise suppression and its correlation badge,
  // and nothing regenerates either (the verdict scheduler is event-driven
  // off `alert.triggered` and never re-scans).
  //
  // ORDER — group -> member -> verdict. Two reasons, and the FIRST is a
  // lock order, not a data dependency:
  //
  //  1. LOCK ORDER (#5005 review). The other writer of this pair is the
  //     correlation job (services/alertCorrelationGroups.ts), which
  //     upserts the GROUP and then its MEMBERS, in that order, on every
  //     pass. Taking them the other way round here is a textbook AB-BA:
  //     a correlation pass running concurrently over the same group
  //     deadlocks with this move and Postgres kills one with 40P01,
  //     surfacing as a 500 on an admin action. Same class of bug and same
  //     fix as the ticket-child order in
  //     services/ticketOrgMoveLockOrder.ts (#4657) — read that module for
  //     the precedent. This pair is not listed there because its
  //     counterpart is the correlation job rather than a second org-mover,
  //     but the rule is identical: state the order once, and align with
  //     the existing writer instead of reasoning locally.
  //  2. DATA DEPENDENCY, and it runs the same way. The member statement
  //     reads `alert_correlation_groups.org_id` as re-stamped by the group
  //     statement, and the verdict's group leg reads that same column.
  //     NOTHING reads `alert_correlation_members.org_id`: the group's
  //     "does this group still span two orgs?" guard reads `alerts.org_id`
  //     (re-stamped by the generic loop above), never the member row's own
  //     org. An earlier revision of this comment asserted the opposite —
  //     that member -> group -> verdict was load-bearing — and the order
  //     it justified was the deadlock in 1.
  //
  // Placement of the whole block is load-bearing too: AFTER the generic
  // loop, because the group guard reads alerts.org_id as re-stamped by it;
  // and AFTER the ticket chain above, so this extends — never reorders —
  // ticketOrgMoveLockOrder.ts's documented order. None of the three
  // carries a composite tenant FK, so there is no 23503 hazard of the kind
  // the ticket chain is ordered for.
  //
  // A GROUP travels only once EVERY member alert shares the target org —
  // handing a group to an org that owns part of it would make its
  // member_count / noise_reduction_percent claims wrong for both orgs. A
  // group still spanning two orgs is left behind and counted below.
  //
  // The third guard is `alert_correlation_groups_org_key_uq (org_id,
  // group_key)`: the correlation job mints group_key as
  // `root:<rootAlertId>` PER ORG (services/alertCorrelationGroups.ts), so
  // the target org can already hold the same key — reachable precisely
  // because this gap let a previously-moved alert grow a second group
  // there. Skipping is deliberate: derived correlation state must not be
  // able to fail an admin's device move with a 23505, and merging two
  // groups (which one's status/score/metadata wins?) is not this route's
  // call to make silently.
  const movedCorrelationGroups = (await tx.execute(
    sql`UPDATE ${sql.identifier('alert_correlation_groups')} g SET org_id = ${targetOrgId}::uuid
        WHERE g.org_id IS DISTINCT FROM ${targetOrgId}::uuid
          AND EXISTS (
            SELECT 1 FROM alert_correlation_members m
            JOIN alerts a ON a.id = m.alert_id
            WHERE m.group_id = g.id AND a.device_id = ${deviceId}::uuid)
          AND NOT EXISTS (
            SELECT 1 FROM alert_correlation_members m2
            JOIN alerts a2 ON a2.id = m2.alert_id
            WHERE m2.group_id = g.id AND a2.org_id IS DISTINCT FROM ${targetOrgId}::uuid)
          AND NOT EXISTS (
            SELECT 1 FROM alert_correlation_groups existing
            WHERE existing.org_id = ${targetOrgId}::uuid AND existing.group_key = g.group_key)
        RETURNING g.id`,
  )) as unknown as Array<{ id: string }>;

  // Members travel WITH their group — never apart from it. The gate is the
  // GROUP's org_id as this transaction just left it, not the member's own
  // alert: `correlationMetadataCondition` (routes/alerts/alerts.ts) joins a
  // member to its group and pins BOTH org_ids, so a member re-stamped to
  // the target while its group stayed behind is visible to NEITHER org.
  // That is strictly worse than leaving both in the source org, where the
  // source org still renders the group intact and the target org merely
  // sees an uncorrelated alert (#5005 post-merge review).
  //
  // Scoped to groups this device's alerts belong to, so an unrelated
  // target-org group is never touched. Within such a group EVERY member
  // moves, including one whose own alert lives on a DIFFERENT device —
  // that device's alerts already sit in the target org, which is exactly
  // what let the group past the guards above. Matching on
  // `g.org_id = <target>` rather than on the ids RETURNed above also heals
  // a member stranded by the pre-fix code, whose group is already there.
  const movedCorrelationMembers = (await tx.execute(
    sql`UPDATE ${sql.identifier('alert_correlation_members')} m SET org_id = ${targetOrgId}::uuid
        WHERE m.org_id IS DISTINCT FROM ${targetOrgId}::uuid
          AND EXISTS (
            SELECT 1 FROM alert_correlation_groups g
            WHERE g.id = m.group_id
              AND g.org_id = ${targetOrgId}::uuid
              AND EXISTS (
                SELECT 1 FROM alert_correlation_members m2
                JOIN alerts a ON a.id = m2.alert_id
                WHERE m2.group_id = g.id AND a.device_id = ${deviceId}::uuid))
        RETURNING m.id`,
  )) as unknown as Array<{ id: string }>;

  // A verdict follows the row it judges. The OR is the point: a
  // `duplicate_of_group` classification is persisted with alert_id NULL
  // and correlation_group_id set, so the alert leg alone never reaches it
  // and every member alert of a moved group would keep its noise verdict
  // stranded. The group leg is narrowed to groups this device's alerts
  // belong to, so it cannot re-stamp a verdict on an unrelated group that
  // merely happens to sit in the target org. Runs after the group
  // statement because "g.org_id = target" is what "this move just took
  // the group with it" means here.
  //
  // The alert leg excludes SITE-OWNED topology alerts (M3-D6): they stay
  // in their site's org when the origin device moves, and so does their
  // verdict (same rule as ticket_alert_links above).
  //
  // Provenance note: verdict.run_id is NOT NULL and `ai_agent_runs`
  // deliberately stays in the SOURCE org (ruled 2026-08-23), so
  // after this re-stamp a verdict's org_id and its run's org_id differ.
  // Nothing dereferences that pair except recordVerdictFeedback's
  // op-evidence write, whose composite FK (run_id, org_id) ->
  // ai_agent_runs(id, org_id) forces the EVIDENCE row to carry the RUN's
  // org — see the fix in services/aiAgents/alertVerdicts.ts.
  const movedAlertVerdicts = (await tx.execute(
    sql`UPDATE ${sql.identifier('ai_alert_verdicts')} SET org_id = ${targetOrgId}::uuid
        WHERE alert_id IN (SELECT id FROM alerts WHERE device_id = ${deviceId}::uuid AND topology_site_id IS NULL)
           OR correlation_group_id IN (
             SELECT g.id FROM alert_correlation_groups g
             WHERE g.org_id = ${targetOrgId}::uuid
               AND EXISTS (
                 SELECT 1 FROM alert_correlation_members m
                 JOIN alerts a ON a.id = m.alert_id
                 WHERE m.group_id = g.id AND a.device_id = ${deviceId}::uuid))
        RETURNING id`,
  )) as unknown as Array<{ id: string }>;

  // Groups this move touched but deliberately left behind, split by CAUSE
  // so an operator asking "why didn't the correlation badge follow this
  // device?" reads the answer off the audit row instead of reconstructing
  // it from SQL. The group UPDATE has already run, so a group still
  // outside the target org failed exactly one of its two skippable
  // guards: it spans two orgs, or its (org_id, group_key) slot is taken
  // there. `spans` is evaluated first and wins when both are true, so the
  // two counts always sum to the number of held groups.
  const [heldCorrelationGroups] = (await tx.execute(
    sql`SELECT
          count(*) FILTER (WHERE t.spans)::int AS held_spanning,
          count(*) FILTER (WHERE NOT t.spans)::int AS held_key_collision
        FROM (
          SELECT EXISTS (
              SELECT 1 FROM alert_correlation_members m2
              JOIN alerts a2 ON a2.id = m2.alert_id
              WHERE m2.group_id = g.id
                AND a2.org_id IS DISTINCT FROM ${targetOrgId}::uuid) AS spans
          FROM alert_correlation_groups g
          WHERE g.org_id IS DISTINCT FROM ${targetOrgId}::uuid
            AND EXISTS (
              SELECT 1 FROM alert_correlation_members m
              JOIN alerts a ON a.id = m.alert_id
              WHERE m.group_id = g.id AND a.device_id = ${deviceId}::uuid)
        ) t`,
  )) as unknown as Array<{ held_spanning: number; held_key_collision: number }>;

  // This device's OWN memberships that stayed behind with a held group:
  // the alert moved, its correlation membership deliberately did not.
  // Counted separately from the moved members so the two numbers never
  // have to be read as "everything else".
  const [heldCorrelationMembers] = (await tx.execute(
    sql`SELECT count(*)::int AS held_members
        FROM alert_correlation_members m
        JOIN alerts a ON a.id = m.alert_id
        JOIN alert_correlation_groups g ON g.id = m.group_id
        WHERE a.device_id = ${deviceId}::uuid
          AND g.org_id IS DISTINCT FROM ${targetOrgId}::uuid`,
  )) as unknown as Array<{ held_members: number }>;

  const alertChildCounts = {
    correlationGroups: movedCorrelationGroups.length,
    correlationGroupsHeldSpanning: Number(heldCorrelationGroups?.held_spanning ?? 0),
    correlationGroupsHeldKeyCollision: Number(heldCorrelationGroups?.held_key_collision ?? 0),
    correlationMembers: movedCorrelationMembers.length,
    correlationMembersHeld: Number(heldCorrelationMembers?.held_members ?? 0),
    alertVerdicts: movedAlertVerdicts.length,
  };
  // Only audit the block when the device actually had alert-axis rows, so
  // a move of a quiet device adds no noise to either org's audit feed.
  alertChildRewrite = Object.values(alertChildCounts).some((n) => n > 0)
    ? alertChildCounts
    : null;

  // Rewrite denormalized site_id on every device-scoped table that has
  // one (currently elevation_requests — see DEVICE_SITE_DENORMALIZED_TABLES
  // in core.ts). Skipping any of these strands rows under the OLD
  // site_id. PATCH /devices/:id (core.ts) performs the same propagation
  // for same-org site changes; keep both loops in lockstep.
  for (const table of DEVICE_SITE_DENORMALIZED_TABLES) {
    await tx.execute(
      sql`UPDATE ${sql.identifier(table)} SET site_id = ${targetSiteId}::uuid WHERE device_id = ${deviceId}::uuid`,
    );
  }

  return { updated, linkGroupDissolved, currencyGuard, alertChildRewrite, customFieldRehome };
}
