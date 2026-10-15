import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  migrationWindowOrgs,
  migrationWindows,
  partnerServicePrincipalKeys,
  partnerServicePrincipals,
  users,
} from '../../db/schema';
import { MigrationWindowError } from '../migrationWindows';
import type { OpenWindow } from '../ticketWriteMode';

/**
 * The write-time window check of import mode (#8313; spec
 * docs/superpowers/specs/api-platform/2026-10-10-ticket-migration-windows-design.md
 * §4.4). The import writer (importWriter.ts) is its only caller.
 */

const TICKETS_WRITE_SCOPE = 'tickets:write';

/** What the import writer needs before it opens a write transaction. */
export type WindowDescriptor = {
  id: string;
  partnerId: string;
  principalId: string;
  writesPerHour: number;
  orgIds: string[];
};

function notOpen(reason: string): MigrationWindowError {
  return new MigrationWindowError('MIGRATION_WINDOW_NOT_OPEN', 'The migration window is not open', 409, { reason });
}

/**
 * The window's partner, principal, throughput and orgs, read by id. A
 * one-row, id-keyed read in system scope: the writer needs the partner and
 * the org list to build the narrowed context every import write runs in
 * (`windowWriteContext`), and has no other way to learn them. It decides
 * nothing; the locked re-read inside each write transaction does.
 */
export async function readWindowDescriptor(windowId: string): Promise<WindowDescriptor> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({
        id: migrationWindows.id,
        partnerId: migrationWindows.partnerId,
        principalId: migrationWindows.partnerServicePrincipalId,
        writesPerHour: migrationWindows.writesPerHour,
        status: migrationWindows.status,
      })
      .from(migrationWindows)
      .where(eq(migrationWindows.id, windowId))
      .limit(1);
    if (!row || row.status !== 'open') throw notOpen(row ? 'closed' : 'not_found');
    const orgRows = await db
      .select({ orgId: migrationWindowOrgs.orgId })
      .from(migrationWindowOrgs)
      .where(eq(migrationWindowOrgs.windowId, windowId));
    return {
      id: row.id,
      partnerId: row.partnerId,
      principalId: row.principalId,
      writesPerHour: row.writesPerHour,
      orgIds: orgRows.map((r) => r.orgId).sort(),
    };
  }, 'ticketImport.readWindow');
}

/**
 * The context every import transaction runs in (§4.4): partner scope with
 * `accessibleOrgIds` = the window's orgs, so RLS — not only the app — bounds
 * what an import can write. No user: the actor is the window's principal.
 */
export function windowWriteContext(window: WindowDescriptor): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [...window.orgIds],
    accessiblePartnerIds: [window.partnerId],
    currentPartnerId: window.partnerId,
    userId: null,
    label: 'ticketImport.write',
  };
}

/**
 * Locks the window FOR SHARE for the rest of the current transaction and
 * checks that it may still be written through (§4.4):
 *   - it is open and `now() < ends_at`;
 *   - `orgId` is one of its orgs (else 403 MIGRATION_WINDOW_ORG_NOT_ALLOWED);
 *   - its principal is active, unexpired, holds tickets:write and has no
 *     active key;
 *   - its opener is active and their credential and MFA epochs still match
 *     the snapshot taken at open.
 * Anything else is 409 MIGRATION_WINDOW_NOT_OPEN. The opener's role is
 * re-checked by the sweep, not per write.
 *
 * FOR SHARE makes close (FOR UPDATE) and write mutually exclusive without
 * serializing writes against each other: a write either commits before a
 * close or sees the window closed. Under the partner context the lock depends
 * on the window's UPDATE policy (migrationWindowsRls.integration.test.ts).
 *
 * The only producer of an `OpenWindow`.
 */
export async function lockOpenWindowForWrite(windowId: string, orgId: string): Promise<OpenWindow> {
  if (!getCurrentDbAccessContext()) {
    throw new Error('lockOpenWindowForWrite must run inside the import write transaction');
  }
  const [row] = await db
    .select({
      id: migrationWindows.id,
      partnerId: migrationWindows.partnerId,
      principalId: migrationWindows.partnerServicePrincipalId,
      status: migrationWindows.status,
      live: sql<boolean>`${migrationWindows.endsAt} > now()`,
      openedBy: migrationWindows.openedBy,
      openerCredentialEpoch: migrationWindows.openerCredentialEpoch,
      openerMfaEpoch: migrationWindows.openerMfaEpoch,
    })
    .from(migrationWindows)
    .where(eq(migrationWindows.id, windowId))
    .limit(1)
    .for('share');
  if (!row) throw notOpen('not_found');
  if (row.status !== 'open') throw notOpen('closed');
  if (!row.live) throw notOpen('expired');

  const orgRows = await db
    .select({ orgId: migrationWindowOrgs.orgId })
    .from(migrationWindowOrgs)
    .where(and(eq(migrationWindowOrgs.windowId, row.id), eq(migrationWindowOrgs.partnerId, row.partnerId)));
  const orgIds = new Set(orgRows.map((r) => r.orgId));
  if (!orgIds.has(orgId)) {
    throw new MigrationWindowError(
      'MIGRATION_WINDOW_ORG_NOT_ALLOWED',
      'The organization is not part of this migration window',
      403,
      { orgIds: [orgId] },
    );
  }

  const [principal] = await db
    .select({
      name: partnerServicePrincipals.name,
      status: partnerServicePrincipals.status,
      scopes: partnerServicePrincipals.scopes,
      unexpired: sql<boolean>`(${partnerServicePrincipals.expiresAt} IS NULL OR ${partnerServicePrincipals.expiresAt} > now())`,
    })
    .from(partnerServicePrincipals)
    .where(and(eq(partnerServicePrincipals.id, row.principalId), eq(partnerServicePrincipals.partnerId, row.partnerId)))
    .limit(1);
  if (!principal || principal.status !== 'active' || !principal.unexpired || !principal.scopes.includes(TICKETS_WRITE_SCOPE)) {
    throw notOpen('principal_inactive');
  }
  const [activeKey] = await db
    .select({ id: partnerServicePrincipalKeys.id })
    .from(partnerServicePrincipalKeys)
    .where(and(
      eq(partnerServicePrincipalKeys.partnerServicePrincipalId, row.principalId),
      eq(partnerServicePrincipalKeys.partnerId, row.partnerId),
      eq(partnerServicePrincipalKeys.status, 'active'),
      or(isNull(partnerServicePrincipalKeys.expiresAt), gt(partnerServicePrincipalKeys.expiresAt, sql`now()`)),
    ))
    .limit(1);
  if (activeKey) throw notOpen('principal_has_key');

  if (!row.openedBy) throw notOpen('opener_inactive');
  const [opener] = await db
    .select({ status: users.status, credentialEpoch: users.credentialEpoch, mfaEpoch: users.mfaEpoch })
    .from(users)
    .where(eq(users.id, row.openedBy))
    .limit(1);
  if (
    !opener
    || opener.status !== 'active'
    || opener.credentialEpoch !== row.openerCredentialEpoch
    || opener.mfaEpoch !== row.openerMfaEpoch
  ) {
    throw notOpen('opener_inactive');
  }

  // The one place an OpenWindow is minted (spec §4.1).
  return {
    id: row.id,
    partnerId: row.partnerId,
    principalId: row.principalId,
    principalName: principal.name,
    orgIds,
  } as unknown as OpenWindow;
}
