import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices, sites, organizations, tickets } from '../../db/schema';
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
} from '../../middleware/auth';
import { hasPermission, PERMISSIONS } from '../../services/permissions';
import {
  getDeviceWithOrgAndSiteCheck,
  SITE_ACCESS_DENIED,
  stripSensitiveDeviceFields,
} from './helpers';
import { moveOrgSchema } from './schemas';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  getDeviceOrgDenormalizedTables,
  getDeviceOrgMoveDeleteTables,
  DEVICE_ORG_FK_CASCADE_TABLES,
  DEVICE_SITE_DENORMALIZED_TABLES,
} from './core';
import { dissolveLinkGroupIfBelowMinimum } from '../../services/deviceLinkGroups';
import { readOrgStampingDefaultsMany } from '../../services/orgCurrencyCore';
import { disconnectAgent } from '../agentWs';
import { captureException } from '../../services/sentry';
import {
  assertTicketMoveCurrencyCompatible,
  TicketMoveCurrencyBlockedError,
  type MoveCurrencyGuardDetails,
} from '../../services/ticketMoveCurrencyGuard';
import { schedulePeripheralPolicyDevice } from '../../jobs/peripheralJobs';
import {
  assertPamDeviceOrgMoveAllowed,
  PamDeviceMoveBlockedError,
} from '../../services/pamDeviceMoveGuard';
import { pgErrorNode } from '../../utils/pgErrors';

/**
 * An organization that passed the pre-transaction existence check was gone at
 * the in-transaction SHARE lock (#3778). Rolls the move back and maps to the
 * same responses the pre-transaction checks return — a 404 for the target, a
 * 500 for the source (a missing source org means device.org_id broke its FK).
 */
class OrgVanishedDuringMoveError extends Error {
  constructor(public which: 'source' | 'target') {
    super(`${which} organization not found at the in-transaction org lock`);
    this.name = 'OrgVanishedDuringMoveError';
  }
}

export const moveOrgRoutes = new Hono();

moveOrgRoutes.use('*', authMiddleware);

/**
 * POST /devices/:id/move-org
 *
 * Move a device between organizations (and into a site within the target org)
 * without uninstalling/reinstalling the agent. The agent re-resolves its
 * `org_id` from `devices.org_id` on every heartbeat / WS handshake, so the
 * column flip is sufficient to relocate the agent at runtime.
 *
 * The route is gated on:
 *   - scope ∈ {partner, system} — cross-org capability requires at minimum
 *     partner reach. Single-org callers can't see two orgs at once and
 *     therefore can't legitimately move between them.
 *   - devices:write AND organizations:write — relocating a device is both
 *     a device mutation and an org-membership mutation.
 *   - MFA — destructive cross-tenant change.
 *
 * Cross-partner moves are rejected even for partner-scoped callers; only
 * system scope can move a device across partner boundaries.
 *
 * RLS hazard: 64 device-scoped tables denormalize `org_id` for RLS perf
 * (see getDeviceOrgDenormalizedTables()). All of them MUST be rewritten in
 * the same transaction or pre-existing rows for this device will be
 * visible only to the OLD org and invisible to the NEW one. Tables that
 * denormalize org_id but have no device_id column (CUSTOM_ORG_REWRITE_TABLES)
 * get dedicated rewrites in the same
 * transaction.
 *
 * Audit: writes ONE audit row per org (source + target) so the move shows
 * up in both audit feeds.
 */
moveOrgRoutes.post(
  '/:id/move-org',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', moveOrgSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const { orgId: targetOrgId, siteId: targetSiteId, acceptCurrencyMismatch } = c.req.valid('json');

    // Multi-currency (#3776): tickets bound to this device move with it, and
    // accepting that their unbilled monetary rows stay in the OLD currency is a
    // billing decision — invoices:write on top of the move's own gates.
    // `permissions` is populated by the requirePermission middleware above.
    if (
      acceptCurrencyMismatch === true &&
      !hasPermission(c.get('permissions'), PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action)
    ) {
      return c.json({ error: 'Accepting a currency mismatch requires invoices:write' }, 403);
    }

    // Source-side access check via the standard chokepoint.
    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const sourceOrgId = device.orgId;

    if (targetOrgId === sourceOrgId) {
      return c.json(
        { error: 'Target organization is the same as the source. Use PATCH /devices/:id to change site.' },
        400,
      );
    }

    // Target-side access check.
    if (!auth.canAccessOrg(targetOrgId)) {
      return c.json({ error: 'Access to target organization denied' }, 403);
    }

    // Look up both orgs to enforce cross-partner policy.
    const orgRows = await db
      .select({
        id: organizations.id,
        partnerId: organizations.partnerId,
        name: organizations.name,
        // NOTE (#3778): currency is NOT read here any more — the guard uses the
        // values read under the in-transaction org SHARE lock below, so a
        // concurrent changeOrgCurrency cannot slip between this check and the move.
      })
      .from(organizations)
      .where(sql`${organizations.id} IN (${sourceOrgId}::uuid, ${targetOrgId}::uuid)`);

    const sourceOrg = orgRows.find((r) => r.id === sourceOrgId);
    const targetOrg = orgRows.find((r) => r.id === targetOrgId);

    if (!targetOrg) {
      return c.json({ error: 'Target organization not found' }, 404);
    }
    if (!sourceOrg) {
      // Defensive — device.orgId failed FK invariants. Treat as 500-class.
      return c.json({ error: 'Source organization not found' }, 500);
    }
    if (sourceOrg.partnerId !== targetOrg.partnerId && auth.scope !== 'system') {
      return c.json(
        { error: 'Cross-partner moves require system scope' },
        403,
      );
    }

    // Target site must belong to the target org.
    const [targetSite] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, targetSiteId), eq(sites.orgId, targetOrgId)))
      .limit(1);

    if (!targetSite) {
      return c.json(
        { error: 'Target site not found or does not belong to the target organization' },
        400,
      );
    }

    // ----------- the actual move -----------
    let updated: typeof devices.$inferSelect | undefined;
    // #2138/#2308 — whether the move dissolved the device's old link group
    // (lone multiboot survivor unlinked, or a vm_host group left headless
    // when its HOST moved, unlinking every guest). Recorded in the audit
    // details so an un-grouped fleet is traceable to this move.
    let linkGroupDissolved = false;
    // #3776 — non-null only when the caller accepted a cross-currency move
    // that stranded unbilled monetary ticket rows in the source currency.
    let currencyGuard: MoveCurrencyGuardDetails | null = null;
    try {
      await db.transaction(async (tx) => {
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
        // Safe to precede the org lock below: SET CONSTRAINTS takes no table
        // locks, so it does not participate in this transaction's lock order.
        await tx.execute(
          sql`SET CONSTRAINTS time_entries_ticket_org_fk, ticket_parts_ticket_org_fk DEFERRED`,
        );
        // Creation barrier / cross-org move lock order (#3778): BOTH organizations
        // FOR SHARE, ascending UUID, as the FIRST statement of this transaction —
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
        const lockedSourceCurrency = lockedSource.currencyCode;
        const lockedTargetCurrency = lockedTarget.currencyCode;

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

        // #2138 — if the moved device left a link group with a single lone
        // profile behind — or it was a vm_host group's HOST (#2308), leaving
        // the group headless — that group is no longer meaningful: dissolve it.
        if (device.linkGroupId) {
          linkGroupDissolved = await dissolveLinkGroupIfBelowMinimum(tx, device.linkGroupId);
        }

        // Agent-run history stays with the SOURCE org (owner decision 2026-08-23):
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

        // action_intents.scope_device_id (P2-2, #4189): same cross-tenant-
        // pointer class as the two detaches above — an intent whose target
        // device just moved to a different org must not keep pointing at it.
        // The immutability trigger (action_intents_block_content_update())
        // permits exactly this transition (non-null -> NULL is the ONE
        // allowed change to scope_device_id; see actionIntents.ts's column
        // comment), so this UPDATE is the tombstone path, not a bypass.
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

        // Rewrite the denormalized org_id on every device-scoped table.
        // Skipping any of these strands pre-existing rows under RLS.
        for (const table of getDeviceOrgDenormalizedTables()) {
          // Immutable evidence revokes app-role UPDATE. Its composite FK uses
          // ON UPDATE CASCADE, so the devices row flip above already performed
          // the trusted org-only restamp inside this transaction.
          if (DEVICE_ORG_FK_CASCADE_TABLES.includes(table)) continue;
          await tx.execute(
            sql`UPDATE ${sql.identifier(table)} SET org_id = ${targetOrgId}::uuid WHERE device_id = ${deviceId}::uuid`,
          );
        }

        // Extension tables that must be DELETED (not re-stamped) on org-move: their rows
        // FK a source/config row that stays in the old org, so rewriting org_id would
        // corrupt cross-row consistency. See the extension tenancy docs.
        for (const table of getDeviceOrgMoveDeleteTables()) {
          await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE device_id = ${deviceId}`);
        }

        // ticket_alert_links denormalizes org_id for RLS but has no
        // device_id column, so the generic loop above can't reach it —
        // rewrite via the alert join instead. Excluded from
        // getDeviceOrgDenormalizedTables(); tracked in
        // CUSTOM_ORG_REWRITE_TABLES (core.ts).
        await tx.execute(
          sql`UPDATE ${sql.identifier('ticket_alert_links')} SET org_id = ${targetOrgId}::uuid WHERE alert_id IN (SELECT id FROM alerts WHERE device_id = ${deviceId}::uuid)`,
        );

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
          targetOrgName: targetOrg.name,
          acceptCurrencyMismatch: acceptCurrencyMismatch === true,
        });
        await tx.execute(
          sql`UPDATE ${sql.identifier('time_entries')} SET org_id = ${targetOrgId}::uuid WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
        );
        await tx.execute(
          sql`UPDATE ${sql.identifier('ticket_parts')} SET org_id = ${targetOrgId}::uuid WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
        );

        // ticket_attachments (W08 #3902) denormalizes org_id from its ticket and
        // has no device_id; tickets bound to this device move org, so their
        // attachment rows follow via the tickets join. Placed AFTER ticket_parts
        // to extend — not reorder — the documented global lock order
        // (tickets -> time_entries -> ticket_parts -> ticket_attachments); the
        // moveTicketOrg loop appends it last for the same reason. S3 objects are
        // keyed by attachment id only (spec D8) and are not touched.
        await tx.execute(
          sql`UPDATE ${sql.identifier('ticket_attachments')} SET org_id = ${targetOrgId}::uuid WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${deviceId}::uuid)`,
        );

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
      });
    } catch (err) {
      const pgNode = pgErrorNode(err);
      if (
        err instanceof PamDeviceMoveBlockedError
        || (
          pgNode?.code === '23514'
          && pgNode.constraint_name === 'devices_pam_history_move_guard'
        )
      ) {
        writeRouteAudit(c, {
          orgId: sourceOrgId,
          action: 'device.move_org.failed',
          resourceType: 'device',
          resourceId: deviceId,
          resourceName: device.hostname,
          details: { code: 'PAM_DEVICE_MOVE_BLOCKED' },
        });
        return c.json({
          error: 'Device organization move is blocked because durable PAM lifecycle evidence exists',
          code: 'PAM_DEVICE_MOVE_BLOCKED',
        }, 409);
      }
      // A currency-policy block is not a failure: the transaction rolled back
      // (device + tickets untouched), so report it and skip Sentry / the
      // failed-move audit.
      if (err instanceof TicketMoveCurrencyBlockedError) {
        return c.json({ error: err.message, code: err.code, details: err.details }, 409);
      }
      // A row deleted under us is a lost race, not an exception: the
      // transaction rolled back, so answer exactly as the pre-transaction
      // existence checks would have — no Sentry, no failed-move audit.
      if (err instanceof OrgVanishedDuringMoveError) {
        return err.which === 'target'
          ? c.json({ error: 'Target organization not found' }, 404)
          : c.json({ error: 'Source organization not found' }, 500);
      }
      console.error(`[devices.moveOrg] failed for ${deviceId}:`, err);
      captureException(err, c);
      // Best-effort audit on the failed cross-tenant move — a rolled-back
      // attempt is security-relevant. Source-org row only since target
      // never committed.
      writeRouteAudit(c, {
        orgId: sourceOrgId,
        action: 'device.move_org.failed',
        resourceType: 'device',
        resourceId: deviceId,
        resourceName: device.hostname,
        details: { sourceOrgId, targetOrgId, sourceSiteId: device.siteId, targetSiteId, error: String(err) },
      });
      return c.json({ error: 'Failed to move device between organizations' }, 500);
    }

    await schedulePeripheralPolicyDevice(deviceId, 'device_org_changed').catch((error) => {
      console.error(`[devices.moveOrg] failed to schedule peripheral reconciliation for ${deviceId}:`, error);
    });

    // Force-close any active WS so the agent reconnects with a fresh
    // handshake on the new org_id. Without this, createAgentWsHandlers
    // (agentWs.ts:1411) closes over the SOURCE-org preValidatedAgent for
    // the lifetime of the connection — every subsequent runWithAgentDbAccess
    // (status, IP history, event publish, command result) writes telemetry
    // under the OLD org's RLS context until the agent eventually reconnects.
    if (updated?.agentId) {
      disconnectAgent(updated.agentId, 4040, 'device moved to a different organization, reconnecting');
    }

    // Audit on BOTH orgs so the move shows up in source and target feeds.
    // (Cast: TS narrows the closure-assigned `let` to its initial null.)
    const acceptedGuard = currencyGuard as MoveCurrencyGuardDetails | null;
    const auditDetails = {
      deviceId,
      sourceOrgId,
      targetOrgId,
      sourceSiteId: device.siteId,
      targetSiteId,
      // #2138/#2308 — a move can dissolve the device's old link group and
      // unlink every remaining member (all guests, when a vm_host group's
      // host moves). Without this the audit trail shows only "device moved"
      // while sibling devices silently lost their grouping.
      ...(device.linkGroupId
        ? { linkGroupId: device.linkGroupId, linkGroupDissolved }
        : {}),
      // #3776 — the caller knowingly left unbilled ticket money in the source
      // currency; record the counts so the stranded snapshots are traceable.
      ...(acceptedGuard?.accepted ? { currencyMismatchAccepted: acceptedGuard } : {}),
    } as const;

    writeRouteAudit(c, {
      orgId: sourceOrgId,
      action: 'device.move_org.source',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: updated?.hostname ?? device.hostname,
      details: auditDetails,
    });
    writeRouteAudit(c, {
      orgId: targetOrgId,
      action: 'device.move_org.target',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: updated?.hostname ?? device.hostname,
      details: auditDetails,
    });

    return c.json({
      success: true,
      device: updated ? stripSensitiveDeviceFields(updated) : null,
    });
  },
);
