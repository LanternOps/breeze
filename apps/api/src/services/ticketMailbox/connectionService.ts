import { randomUUID } from 'node:crypto';
import { and, eq, sql, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  ticketMailboxConnections,
  ticketMailboxTenantOwnerships,
} from '../../db/schema/ticketMailbox';
import { organizations } from '../../db/schema/orgs';
import { getMailboxToken } from './mailboxToken';
import { loadGoogleConnection, decryptConnectionKey } from '../googleHelpers';
import { probeMailboxForConnect, MailboxProbeError } from './googleMailboxClient';

export type MailboxConnectionStatus =
  | 'pending_consent' | 'connected' | 'error' | 'reauth_required' | 'disabled';

export interface MailboxConnection {
  id: string;
  partnerId: string;
  consentAttemptId: string;
  tenantId: string | null;
  mailboxAddress: string;
  displayName: string | null;
  status: MailboxConnectionStatus;
  deltaLink: string | null;
  strictSenderAuth: boolean;
  lastPolledAt: Date | null;
  lastMessageAt: Date | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MailboxConnectionListItem {
  id: string;
  /** Provider discriminator so a client can route management actions correctly:
   * the Microsoft card renders only 'm365' rows, and a gmail row must never be
   * reconnected/retested through the Microsoft consent path (which would convert
   * it to m365 and drop its Gmail binding). */
  provider: 'm365' | 'gmail';
  /** Owning org for a gmail row (org-scoped, DWD-provisioned); null for an m365 row
   * (partner-scoped). The Gmail management surface needs it to reconnect a row
   * against the same org's Google Workspace credential. */
  orgId: string | null;
  /** Name of the credential org, resolved under the caller's own RLS context, so
   * a ticket_mailbox:read user sees it without organizations:read. Null for an
   * m365 row or an org the caller cannot see. */
  orgName: string | null;
  mailboxAddress: string;
  displayName: string | null;
  status: MailboxConnectionStatus;
  lastPolledAt: Date | null;
  lastMessageAt: Date | null;
  /** Sanitized probe failure reason ("Mailbox verification failed: Graph 403 (…)"), else null. */
  verificationError: string | null;
}

export const MAILBOX_VERIFICATION_FAILED = 'Mailbox verification failed';

export type MailboxConnectionSnapshot = Pick<
  MailboxConnection,
  'id' | 'partnerId' | 'consentAttemptId'
> & { tenantId: string };

type ConnectedMailbox = MailboxConnectionSnapshot & Pick<
  MailboxConnection,
  'mailboxAddress' | 'deltaLink'
>;

type Row = typeof ticketMailboxConnections.$inferSelect;

function toConnection(r: Row): MailboxConnection {
  return { ...r, status: r.status as MailboxConnectionStatus };
}

export async function listMailboxConnections(partnerId: string): Promise<MailboxConnectionListItem[]> {
  const rows = await db.select({
    id: ticketMailboxConnections.id,
    provider: ticketMailboxConnections.provider,
    orgId: ticketMailboxConnections.orgId,
    orgName: organizations.name,
    mailboxAddress: ticketMailboxConnections.mailboxAddress,
    displayName: ticketMailboxConnections.displayName,
    status: ticketMailboxConnections.status,
    lastPolledAt: ticketMailboxConnections.lastPolledAt,
    lastMessageAt: ticketMailboxConnections.lastMessageAt,
    lastError: ticketMailboxConnections.lastError,
  }).from(ticketMailboxConnections)
    // Same partner only: a row's org always belongs to its partner, and the
    // extra predicate keeps a stale cross-partner org_id from naming another
    // partner's organization.
    .leftJoin(organizations, and(
      eq(organizations.id, ticketMailboxConnections.orgId),
      eq(organizations.partnerId, ticketMailboxConnections.partnerId),
    ))
    .where(eq(ticketMailboxConnections.partnerId, partnerId));
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider === 'gmail' ? 'gmail' : 'm365',
    orgId: row.orgId,
    orgName: row.orgName ?? null,
    mailboxAddress: row.mailboxAddress,
    displayName: row.displayName,
    status: row.status as MailboxConnectionStatus,
    lastPolledAt: row.lastPolledAt,
    lastMessageAt: row.lastMessageAt,
    // Only our own sanitized reason is exposed; the poll worker also writes
    // lastError with raw upstream error text that must not reach the client.
    verificationError: row.lastError?.startsWith(MAILBOX_VERIFICATION_FAILED) ? row.lastError : null,
  }));
}

/**
 * How many M365 mailboxes this partner actually receives mail through.
 * `connected` is the only status that polls (see listConnectedMailboxes) — a
 * pending/error/disabled row is NOT a working inbound path, so it must not
 * count as one. Runs in the caller's request DB context (like
 * listMailboxConnections) and leans on the table's breeze_has_partner_access
 * policy, so only a partner- or system-scoped caller sees rows. Its one caller,
 * getTicketConfig, is reachable only behind requireScope('partner','system') —
 * do NOT call it from an org-scoped path, where RLS returns 0 and would
 * silently understate a working inbound setup.
 */
export async function countConnectedMailboxes(partnerId: string): Promise<number> {
  const rows = await db.select({ id: ticketMailboxConnections.id })
    .from(ticketMailboxConnections)
    .where(and(
      eq(ticketMailboxConnections.partnerId, partnerId),
      eq(ticketMailboxConnections.status, 'connected'),
    ));
  return rows.length;
}

/** System-context read across all partners — used by the poll worker (Plan 2). */
export async function listConnectedMailboxes(): Promise<ConnectedMailbox[]> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.select({
      id: ticketMailboxConnections.id,
      partnerId: ticketMailboxConnections.partnerId,
      tenantId: ticketMailboxConnections.tenantId,
      mailboxAddress: ticketMailboxConnections.mailboxAddress,
      deltaLink: ticketMailboxConnections.deltaLink,
      consentAttemptId: ticketMailboxConnections.consentAttemptId,
    }).from(ticketMailboxConnections)
      .innerJoin(
        ticketMailboxTenantOwnerships,
        and(
          eq(ticketMailboxConnections.tenantId, ticketMailboxTenantOwnerships.tenantId),
          eq(ticketMailboxConnections.partnerId, ticketMailboxTenantOwnerships.partnerId),
        ),
      )
      .where(and(
        eq(ticketMailboxConnections.provider, 'm365'),
        eq(ticketMailboxConnections.status, 'connected'),
      ));
    return rows.flatMap((row) => row.tenantId ? [{ ...row, tenantId: row.tenantId }] : []);
  }));
}

export async function getMailboxConnection(id: string, partnerId: string): Promise<MailboxConnection | null> {
  const rows = await db.select().from(ticketMailboxConnections)
    .where(and(eq(ticketMailboxConnections.id, id), eq(ticketMailboxConnections.partnerId, partnerId)))
    .limit(1);
  return rows[0] ? toConnection(rows[0]) : null;
}

export async function createPendingConnection(input: {
  partnerId: string; mailboxAddress: string; displayName: string | null; createdBy: string | null;
}): Promise<MailboxConnection> {
  const consentAttemptId = randomUUID();
  const rows = await db.insert(ticketMailboxConnections).values({
    partnerId: input.partnerId,
    provider: 'm365',
    mailboxAddress: input.mailboxAddress.trim().toLowerCase(),
    displayName: input.displayName,
    status: 'pending_consent',
    createdBy: input.createdBy,
    consentAttemptId,
  }).onConflictDoUpdate({
    target: [ticketMailboxConnections.partnerId, ticketMailboxConnections.mailboxAddress],
    set: {
      // This is the Microsoft connect path. If the existing row for this
      // (partner, mailbox) is a Gmail connection, converting it to M365 must be
      // CLEAN: set provider and clear every Gmail-specific field, or we would
      // leave a mixed row (provider='gmail' + a Microsoft tenant) that the M365
      // selector picks up but the consumer's provider-equality check rejects.
      provider: 'm365',
      orgId: null,
      googleAccountSub: null,
      historyId: null,
      // Gmail-only cursor floor; leaving it set violates the provider CHECK
      // (an m365 row must not carry Gmail eligibility state) and is meaningless
      // for the Graph delta cursor.
      eligibleAfter: null,
      status: 'pending_consent',
      consentAttemptId,
      tenantId: null,
      deltaLink: null,
      lastError: null,
      lastPolledAt: null,
      lastMessageAt: null,
      displayName: input.displayName,
      updatedAt: new Date(),
    },
  }).returning();
  const row = rows[0];
  if (!row) throw new Error('Failed to create pending mailbox connection');
  return toConnection(row);
}

export type GmailConnectResult =
  | { ok: true; id: string }
  | { ok: false; code: 'org_not_in_partner' | 'no_google_connection' | 'mailbox_unreadable' | 'account_id_unavailable' | 'org_unavailable' | 'connection_changed'; error: string };

/**
 * Provision a Gmail inbound mailbox connection (#6593). Unlike Microsoft, Gmail
 * uses domain-wide delegation: the org already holds an active
 * google_workspace_connections credential, so there is no per-mailbox OAuth
 * redirect. We instead VERIFY the credential can actually read this mailbox and
 * read its immutable identity in ONE DWD session (probeMailboxForConnect — proves
 * impersonation + the gmail scope, and binds the cursor to the sub), then persist a
 * CONNECTED gmail row and seed its history cursor + eligibility floor at connect time.
 *
 * Identity: `google_account_sub` stores the mailbox's IMMUTABLE Google account
 * `sub` (from OpenID UserInfo via the same DWD credentials — getMailboxIdentity),
 * captured at connect. It is the per-mailbox dedup namespace (Gmail message ids
 * are unique only within a mailbox) AND the same-account proof on reconnect: an
 * org merge is a plain repoint (org_id -> survivor, status/cursor/generation
 * preserved; the per-sweep identity check is what guards a different underlying
 * account — see sweepOneGmail). A reconnect PRESERVES the history cursor only when
 * the freshly-read sub matches the stored sub (same underlying Google account); a
 * different sub RESETS, so neither a merge nor a reconnect can bind a cursor or
 * dedup namespace to an unrelated account. The sub is stable across email/alias
 * changes and never reused, so it also fixes the address-reassignment
 * dedup-collision risk.
 */
export async function createGmailConnection(input: {
  partnerId: string;
  orgId: string;
  mailboxAddress: string;
  displayName?: string | null;
  createdBy: string | null;
}): Promise<GmailConnectResult> {
  const mailbox = input.mailboxAddress.trim().toLowerCase();

  // The org must belong to this partner. The composite (org_id, partner_id) FK
  // would reject a mismatch with a raw 23503; check first for a clean error.
  const orgRow = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.select({ partnerId: organizations.partnerId }).from(organizations)
        .where(eq(organizations.id, input.orgId)).limit(1),
    ),
  );
  if (!orgRow[0] || orgRow[0].partnerId !== input.partnerId) {
    return { ok: false, code: 'org_not_in_partner', error: 'Organization not found for this partner.' };
  }

  const gw = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => loadGoogleConnection(input.orgId)),
  );
  if (!gw || gw.status !== 'active') {
    return { ok: false, code: 'no_google_connection', error: 'This organization has no active Google Workspace connection to read the mailbox with.' };
  }

  // Capture the eligibility floor BEFORE probing the baseline cursor. The floor is
  // an at/after bound used by expiry recovery; the baseline historyId is the
  // incremental cursor. If the floor were stamped AFTER the baseline, a message
  // arriving in between would sort before the floor yet after the baseline, so an
  // expired-cursor recovery (which enumerates `after:<floor>`) would omit it while
  // the cursor advanced past it. Stamping the floor first makes recovery inclusive
  // of that window.
  const now = new Date();

  // ONE DWD session reads BOTH the baseline history cursor and the immutable
  // account sub, so they are bound to the same token (a mailbox read failure vs a
  // missing identity grant map to distinct error codes). The sub is the dedup
  // namespace and the same-account proof on reconnect, so we refuse to persist a
  // "connected" row without it rather than fall back to the address.
  // Capture the row's generation BEFORE the slow Google probe. The upsert below is a
  // compare-and-swap on it: if a concurrent DISCONNECT (which rotates the generation
  // and disables the row) commits while we probe, our now-stale reconnect matches 0
  // rows and is refused — so an older in-flight reconnect cannot resurrect a mailbox
  // the user disconnected in the meantime. null = no existing row (a first connect).
  const preGen = ((await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.select({ g: ticketMailboxConnections.consentAttemptId })
        .from(ticketMailboxConnections)
        .where(and(
          eq(ticketMailboxConnections.partnerId, input.partnerId),
          eq(ticketMailboxConnections.mailboxAddress, mailbox),
        )).limit(1),
    ),
  )) as Array<{ g: string }>)[0]?.g ?? null;

  const saKey = decryptConnectionKey(gw);
  let historyId: string;
  let accountSub: string;
  try {
    const probe = await probeMailboxForConnect(saKey, mailbox);
    historyId = probe.historyId;
    accountSub = probe.sub;
  } catch (err) {
    if (err instanceof MailboxProbeError && err.kind === 'identity') {
      return { ok: false, code: 'account_id_unavailable', error: "Could not read the mailbox's Google account identity. Grant the service account the 'openid' and 'userinfo.email' scopes in domain-wide delegation, then retry." };
    }
    return { ok: false, code: 'mailbox_unreadable', error: 'Could not read the mailbox via domain-wide delegation. Check the delegation grant and the gmail.readonly scope for this service account.' };
  }

  // "Same binding" = the existing row is already a Gmail row for the SAME org, so
  // "Same binding" = the existing row is a Gmail row for the SAME immutable Google
  // account (its stored sub equals the sub we just read live from the mailbox).
  // That is the ONLY sound proof that a preserved history cursor / dedup namespace
  // still belongs to the same underlying mailbox — org identity does not prove it
  // (an org merge repoints org_id, and a re-home points the address at another
  // credential). Cursor, floor, and generation are preserved only in that case.
  const sameGmailBinding = sql`${ticketMailboxConnections.provider} = 'gmail' AND ${ticketMailboxConnections.googleAccountSub} IS NOT DISTINCT FROM excluded.google_account_sub`;

  const outcome = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      // Close the connect-vs-merge race. The org/partner validation and the
      // credential probe above ran in earlier, separate transactions, so an org
      // merge can commit in between and leave us about to INSERT a 'connected' row
      // under the merged-away (loser) org — an orphan the merge cascade has already
      // walked past, whose Google credential is gone (keep-survivor), so no sweep
      // can ever poll it. The merge fences the loser to status='merging' (then
      // stamps deleted_at). Re-check the org under a row lock in the SAME
      // transaction as the upsert: FOR UPDATE serializes against that fence, so we
      // either commit before it (the merge then repoints our row to the survivor
      // via the cascade) or observe merging/deleted and refuse cleanly.
      const orgLock = await db.select({ status: organizations.status, deletedAt: organizations.deletedAt })
        .from(organizations)
        .where(and(eq(organizations.id, input.orgId), eq(organizations.partnerId, input.partnerId)))
        .for('update')
        .limit(1);
      const org = orgLock[0];
      if (!org || org.deletedAt !== null || org.status === 'merging') {
        return { unavailable: true as const };
      }
      const rows = await db.insert(ticketMailboxConnections).values({
        partnerId: input.partnerId,
        provider: 'gmail',
        orgId: input.orgId,
        googleAccountSub: accountSub,
        mailboxAddress: mailbox,
        displayName: input.displayName ?? null,
        status: 'connected',
        historyId,
        eligibleAfter: now,
        createdBy: input.createdBy,
      }).onConflictDoUpdate({
        target: [ticketMailboxConnections.partnerId, ticketMailboxConnections.mailboxAddress],
        set: {
          // SEMANTICS: connect is idempotent "ensure this mailbox is connected" and is
          // last-writer-wins — it re-enables a disabled row, which is exactly what a
          // deliberate reconnect-after-disconnect needs. A stale reconnect whose Google
          // probe started before a concurrent disconnect could therefore resurrect the
          // row; the server cannot tell that apart from an intentional reconnect without
          // a client-supplied generation token. The single-operator window is closed in
          // the UI (the card holds one shared busy flag across connect/reconnect AND
          // disconnect, so they cannot overlap); a cross-session overlap remains
          // last-writer-wins by design.
          // Converting an existing (possibly Microsoft) row to a clean Gmail row:
          // set the Gmail identity/cursor and clear every Microsoft-only field so
          // the provider-fields-consistent CHECK holds.
          provider: 'gmail',
          orgId: input.orgId,
          googleAccountSub: accountSub,
          // Cursor/floor preservation is SOUND ONLY when the live sub matches the
          // stored sub (same underlying Google account). Then keep the durable
          // cursor + floor so a reconnect after an outage — or after an org merge —
          // resumes without skipping mail that accrued while it was down.
          //
          // If the sub DIFFERS (was Microsoft, address re-homed to another account,
          // or the address was reassigned to a new Google account), the old cursor,
          // floor, and dedup namespace belong to an UNRELATED mailbox. Preserving
          // them could import a foreign inbox's history and cross-tenant-contaminate
          // tickets, so SEED the freshly probed cursor and set the floor to now,
          // exactly like a first connect. This proves same-account from LIVE
          // credential evidence, not from org identity.
          historyId: sql`CASE WHEN ${sameGmailBinding}
            THEN COALESCE(${ticketMailboxConnections.historyId}, excluded.history_id)
            ELSE excluded.history_id END`,
          eligibleAfter: sql`CASE WHEN ${sameGmailBinding}
            THEN COALESCE(${ticketMailboxConnections.eligibleAfter}, excluded.eligible_after)
            ELSE excluded.eligible_after END`,
          status: 'connected',
          tenantId: null,
          deltaLink: null,
          lastError: null,
          displayName: input.displayName ?? null,
          // Generation (consent_attempt_id) rotation is CONDITIONAL, keyed on the
          // SAME sub test as the cursor above:
          //   - Same account: KEEP the generation. Already-queued, still-valid jobs
          //     (and the cursor that advanced past them) belong to this same mailbox.
          //   - Different account: ROTATE. Any queued work produced under the prior
          //     binding must stop being authorized (lockActiveMailboxGeneration /
          //     connectedGmailPredicate); the cursor is reseeded above.
          consentAttemptId: sql`CASE WHEN ${sameGmailBinding}
            THEN ${ticketMailboxConnections.consentAttemptId}
            ELSE ${randomUUID()}::uuid END`,
          updatedAt: now,
        },
        // Compare-and-swap on the generation read BEFORE the probe. This guards
        // BOTH races: a reconnect whose row was disconnected/rotated mid-probe, AND a
        // first-connect that raced another session — when preGen is null the predicate
        // `col = NULL` is never true, so ANY conflict (a row appeared during our probe)
        // yields 0 rows and is refused below, while a genuine first connect has no
        // conflict and INSERTs. The stale writer never resurrects/clobbers the row.
        setWhere: sql`${ticketMailboxConnections.consentAttemptId} = ${preGen}::uuid`,
      }).returning({ id: ticketMailboxConnections.id });
      return { rows };
    }),
  );
  if ('unavailable' in outcome) {
    return {
      ok: false,
      code: 'org_unavailable',
      error: 'This organization is being merged or has been removed; reconnect the mailbox under the surviving organization.',
    };
  }
  // Nothing written => the CAS failed: a concurrent connect or disconnect changed the
  // row (or created one) during our probe. Refuse rather than resurrect/clobber it, so
  // the other session's action stands.
  if (outcome.rows.length === 0) {
    return {
      ok: false,
      code: 'connection_changed',
      error: 'This mailbox connection changed during connect (it may have just been disconnected). Refresh and try again.',
    };
  }
  const id = outcome.rows[0]?.id;
  if (!id) throw new Error('Failed to persist Gmail mailbox connection');
  return { ok: true, id };
}

export async function bindVerifiedTenant(
  connectionId: string,
  partnerId: string,
  consentAttemptId: string,
  tenantId: string,
  evidence: { microsoftOid: string; breezeUserId: string | null },
): Promise<void> {
  const normalizedTenantId = tenantId.toLowerCase();
  const normalizedMicrosoftOid = evidence.microsoftOid.toLowerCase();

  await db.transaction(async (tx) => {
    await tx.insert(ticketMailboxTenantOwnerships).values({
      tenantId: normalizedTenantId,
      partnerId,
      verifiedBy: evidence.breezeUserId,
      verifiedMicrosoftOid: normalizedMicrosoftOid,
    }).onConflictDoNothing({
      target: ticketMailboxTenantOwnerships.tenantId,
    }).returning({ partnerId: ticketMailboxTenantOwnerships.partnerId });

    const ownershipRows = await tx.select({ partnerId: ticketMailboxTenantOwnerships.partnerId })
      .from(ticketMailboxTenantOwnerships)
      .where(eq(ticketMailboxTenantOwnerships.tenantId, normalizedTenantId))
      .limit(1);
    const ownership = ownershipRows[0];
    if (!ownership) throw new Error('Failed to verify mailbox tenant ownership');
    if (ownership.partnerId !== partnerId) {
      throw new Error('Mailbox tenant is already owned by another partner');
    }

    const updated = await tx.update(ticketMailboxConnections)
      .set({
        tenantId: normalizedTenantId,
        status: 'connected',
        lastError: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(ticketMailboxConnections.id, connectionId),
        eq(ticketMailboxConnections.partnerId, partnerId),
        eq(ticketMailboxConnections.consentAttemptId, consentAttemptId),
        eq(ticketMailboxConnections.status, 'pending_consent'),
      ))
      .returning({ id: ticketMailboxConnections.id });
    if (updated.length !== 1) throw new Error('Pending mailbox connection not found');
  });
}

export async function markPendingConsentFailed(
  id: string,
  partnerId: string,
  consentAttemptId: string,
  lastError: string,
): Promise<boolean> {
  const rows = await db.update(ticketMailboxConnections)
    .set({ status: 'reauth_required', lastError, updatedAt: new Date() })
    .where(and(
      eq(ticketMailboxConnections.id, id),
      eq(ticketMailboxConnections.partnerId, partnerId),
      eq(ticketMailboxConnections.consentAttemptId, consentAttemptId),
      eq(ticketMailboxConnections.status, 'pending_consent'),
    ))
    .returning({ id: ticketMailboxConnections.id });
  return rows.length === 1;
}

/** Restore a connection after a transient probe failure. The tenant/partner
 * composite foreign key is the ownership proof; the status predicate prevents
 * pending, disabled, and reauth-required rows from being activated here. */
export async function restoreVerifiedConnection(
  snapshot: MailboxConnectionSnapshot,
): Promise<boolean> {
  const rows = await db.update(ticketMailboxConnections)
    .set({ status: 'connected', lastError: null, updatedAt: new Date() })
    .where(and(
      eq(ticketMailboxConnections.id, snapshot.id),
      eq(ticketMailboxConnections.partnerId, snapshot.partnerId),
      eq(ticketMailboxConnections.tenantId, snapshot.tenantId),
      eq(ticketMailboxConnections.consentAttemptId, snapshot.consentAttemptId),
      eq(ticketMailboxConnections.status, 'error'),
    ))
    .returning({ id: ticketMailboxConnections.id });
  return rows.length === 1;
}

function connectedSnapshotPredicate(snapshot: MailboxConnectionSnapshot) {
  return and(
    eq(ticketMailboxConnections.id, snapshot.id),
    eq(ticketMailboxConnections.partnerId, snapshot.partnerId),
    eq(ticketMailboxConnections.tenantId, snapshot.tenantId),
    eq(ticketMailboxConnections.consentAttemptId, snapshot.consentAttemptId),
    eq(ticketMailboxConnections.status, 'connected'),
  );
}

export async function isConnectedMailboxSnapshotCurrent(
  snapshot: MailboxConnectionSnapshot,
): Promise<boolean> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.select({ id: ticketMailboxConnections.id })
      .from(ticketMailboxConnections)
      .where(connectedSnapshotPredicate(snapshot))
      .limit(1);
    return rows.length === 1;
  }));
}

/** Request-context lifecycle recheck for retest paths that intentionally make
 * no status transition. It still compares the original generation and tenant,
 * so a concurrent disable/re-consent cannot be reported as the probe result. */
export async function isMailboxConnectionSnapshotCurrent(
  snapshot: MailboxConnectionSnapshot,
  status: Extract<MailboxConnectionStatus, 'connected' | 'error'>,
): Promise<boolean> {
  const rows = await db.select({ id: ticketMailboxConnections.id })
    .from(ticketMailboxConnections)
    .where(and(
      eq(ticketMailboxConnections.id, snapshot.id),
      eq(ticketMailboxConnections.partnerId, snapshot.partnerId),
      eq(ticketMailboxConnections.tenantId, snapshot.tenantId),
      eq(ticketMailboxConnections.consentAttemptId, snapshot.consentAttemptId),
      eq(ticketMailboxConnections.status, status),
    ))
    .for('update')
    .limit(1);
  return rows.length === 1;
}

/** Request-context update for a retest that fails again while the connection
 * is already `error`: no status transition, but the stored reason must track
 * the latest probe result so `verificationError` doesn't go stale on refresh
 * (#6192). Same snapshot+status guard as isMailboxConnectionSnapshotCurrent. */
export async function refreshErrorReason(
  snapshot: MailboxConnectionSnapshot,
  lastError: string,
): Promise<boolean> {
  const rows = await db.update(ticketMailboxConnections)
    .set({ lastError, updatedAt: new Date() })
    .where(and(
      eq(ticketMailboxConnections.id, snapshot.id),
      eq(ticketMailboxConnections.partnerId, snapshot.partnerId),
      eq(ticketMailboxConnections.tenantId, snapshot.tenantId),
      eq(ticketMailboxConnections.consentAttemptId, snapshot.consentAttemptId),
      eq(ticketMailboxConnections.status, 'error'),
    ))
    .returning({ id: ticketMailboxConnections.id });
  return rows.length === 1;
}

export async function setConnectedMailboxStatus(
  snapshot: MailboxConnectionSnapshot,
  status: Exclude<MailboxConnectionStatus, 'connected' | 'pending_consent' | 'disabled'>,
  lastError: string,
): Promise<boolean> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.update(ticketMailboxConnections)
      .set({ status, lastError, updatedAt: new Date() })
      .where(connectedSnapshotPredicate(snapshot))
      .returning({ id: ticketMailboxConnections.id });
    return rows.length === 1;
  }));
}

/** Worker-only. Self-wraps in system context: ticket_mailbox_connections is
 *  FORCE RLS (partner-axis), and the poll worker runs with no request DB context,
 *  so a bare write would match zero rows silently and the cursor would never
 *  advance. */
export async function updateDeltaCursor(
  snapshot: MailboxConnectionSnapshot,
  deltaLink: string,
  polledAt: Date,
  lastMessageAt: Date | null,
): Promise<boolean> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.update(ticketMailboxConnections)
      .set({ deltaLink, lastPolledAt: polledAt, ...(lastMessageAt ? { lastMessageAt } : {}), updatedAt: new Date() })
      .where(connectedSnapshotPredicate(snapshot))
      .returning({ id: ticketMailboxConnections.id });
    return rows.length === 1;
  }));
}

export async function disableConnection(id: string, partnerId: string): Promise<boolean> {
  const rows = await db.update(ticketMailboxConnections)
    .set({
      status: 'disabled',
      deltaLink: null,
      consentAttemptId: randomUUID(),
      updatedAt: new Date(),
    })
    .where(and(eq(ticketMailboxConnections.id, id), eq(ticketMailboxConnections.partnerId, partnerId)))
    .returning({ id: ticketMailboxConnections.id });
  return rows.length === 1;
}

/** 410 Gone: Graph invalidated the delta token. Clear it so the next sweep restarts
 *  the delta from "now" (no history backfill). Stays 'connected'. Worker-only;
 *  self-wraps in system context (FORCE RLS — see updateDeltaCursor). */
export async function resetDeltaCursor(snapshot: MailboxConnectionSnapshot): Promise<boolean> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.update(ticketMailboxConnections)
      .set({ deltaLink: null, updatedAt: new Date() })
      .where(connectedSnapshotPredicate(snapshot))
      .returning({ id: ticketMailboxConnections.id });
    return rows.length === 1;
  }));
}

export interface MailboxProbeResult {
  ok: boolean;
  error?: string;
  /** Operator-safe diagnostic: HTTP status + Graph `error.code` only, never message bodies. */
  reason?: string;
}

const GRAPH_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

/** Lightweight Graph probe: can the app read this mailbox under the tenant's consent? */
export async function probeMailbox(tenantId: string, mailboxAddress: string): Promise<MailboxProbeResult> {
  let token: string;
  try {
    token = await getMailboxToken(tenantId);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'token acquisition failed',
      reason: 'token acquisition failed',
    };
  }
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailboxAddress)}/messages?${encodeURIComponent('$top')}=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
  if (res.ok) return { ok: true };
  let code: string | undefined;
  try {
    const body = await res.json() as { error?: { code?: unknown } };
    if (typeof body?.error?.code === 'string' && GRAPH_ERROR_CODE.test(body.error.code)) code = body.error.code;
  } catch {
    // Non-JSON / empty body (Graph's normal shape for many errors) and a
    // genuine body-stream failure both land here; either way we still report
    // the status alone. Deliberately not logging the parse error's message,
    // which can echo a fragment of the response body.
    console.warn('[ticketMailbox] failed to parse Graph error body', { status: res.status });
  }
  return {
    ok: false,
    error: `Graph returned ${res.status}`,
    reason: code ? `Graph ${res.status} (${code})` : `Graph ${res.status}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gmail (Google Workspace) connections — provider='gmail'. Kept as parallel
// functions so the Microsoft path above is untouched. A Gmail connection has no
// Microsoft tenant; it resolves its DWD service-account credential via the owning
// org (google_workspace_connections, keyed by orgId). google_account_sub holds the
// mailbox's IMMUTABLE Google account sub (from OpenID UserInfo at connect) — the
// dedup namespace and the same-account proof on reconnect (see
// createGmailConnection). Its incremental cursor is historyId (a STRING), not a
// delta URL.
// ─────────────────────────────────────────────────────────────────────────────

/** Generation identity for a connected Gmail mailbox. Mirrors
 * MailboxConnectionSnapshot but keyed on the Gmail identity rather than a tenant. */
export interface GmailMailboxSnapshot {
  id: string;
  partnerId: string;
  consentAttemptId: string;
  /** The credential org the sweep loaded. When set, every generation check also
   * requires the row to still belong to it, so an org merge that repoints the row
   * mid-sweep (keeping consentAttemptId) stops the sweep before any enqueue,
   * status change or cursor move made through the old org's credential. */
  orgId?: string;
}

/** A connected Gmail mailbox the poll worker sweeps. */
export interface ConnectedGmailMailbox extends GmailMailboxSnapshot {
  orgId: string;
  mailboxAddress: string;
  googleAccountSub: string;
  historyId: string | null;
  /** Connect-time floor; recovery ingests only mail at/after this instant. */
  eligibleAfter: Date | null;
}

function connectedGmailPredicate(snapshot: GmailMailboxSnapshot) {
  return and(
    eq(ticketMailboxConnections.id, snapshot.id),
    eq(ticketMailboxConnections.partnerId, snapshot.partnerId),
    eq(ticketMailboxConnections.consentAttemptId, snapshot.consentAttemptId),
    eq(ticketMailboxConnections.provider, 'gmail'),
    eq(ticketMailboxConnections.status, 'connected'),
    ...(snapshot.orgId ? [eq(ticketMailboxConnections.orgId, snapshot.orgId)] : []),
  );
}

/** Connected Gmail mailboxes. No tenant-ownership join (that is Microsoft-only);
 * a connected gmail row is guaranteed by the DB CHECK to carry google_account_sub
 * and org_id, so the flatMap drops any partial row defensively. */
export async function listConnectedGmailMailboxes(): Promise<ConnectedGmailMailbox[]> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.select({
      id: ticketMailboxConnections.id,
      partnerId: ticketMailboxConnections.partnerId,
      consentAttemptId: ticketMailboxConnections.consentAttemptId,
      orgId: ticketMailboxConnections.orgId,
      mailboxAddress: ticketMailboxConnections.mailboxAddress,
      googleAccountSub: ticketMailboxConnections.googleAccountSub,
      historyId: ticketMailboxConnections.historyId,
      eligibleAfter: ticketMailboxConnections.eligibleAfter,
    }).from(ticketMailboxConnections)
      // Tenant-isolation invariant: the org that owns the DWD credential MUST
      // belong to the same partner as the mailbox connection. The inner join on
      // (org_id, partnerId) drops any row where they diverge, so the sweep can
      // never load one partner's credential for another partner's connection.
      .innerJoin(
        organizations,
        and(
          eq(ticketMailboxConnections.orgId, organizations.id),
          eq(organizations.partnerId, ticketMailboxConnections.partnerId),
        ),
      )
      .where(and(
        eq(ticketMailboxConnections.provider, 'gmail'),
        eq(ticketMailboxConnections.status, 'connected'),
      ));
    return rows.flatMap((r) =>
      r.orgId && r.googleAccountSub
        ? [{ ...r, orgId: r.orgId, googleAccountSub: r.googleAccountSub }]
        : [],
    );
  }));
}

/** Current org_id of the still-connected gmail row for this snapshot, or null if
 * the row is no longer a connected gmail row under this generation. Lets the sweep
 * distinguish a genuinely missing credential (org unchanged) from a concurrent org
 * merge that repointed the row (org changed) between enumeration and credential
 * load — see sweepOneGmail. */
export async function getConnectedGmailMailboxOrgId(
  snapshot: GmailMailboxSnapshot,
): Promise<string | null> {
  // Deliberately org-agnostic: this reads the row's CURRENT org, so it must not
  // be filtered by the org the caller loaded.
  const { id, partnerId, consentAttemptId } = snapshot;
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.select({ orgId: ticketMailboxConnections.orgId })
      .from(ticketMailboxConnections)
      .where(connectedGmailPredicate({ id, partnerId, consentAttemptId }))
      .limit(1);
    return rows[0]?.orgId ?? null;
  }));
}

/** Lifecycle recheck before any external side effect (mirrors
 * isConnectedMailboxSnapshotCurrent for the Gmail identity). */
export async function isConnectedGmailMailboxCurrent(
  snapshot: GmailMailboxSnapshot,
): Promise<boolean> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.select({ id: ticketMailboxConnections.id })
      .from(ticketMailboxConnections)
      .where(connectedGmailPredicate(snapshot))
      .limit(1);
    return rows.length === 1;
  }));
}

/** First-sweep seed: establish the eligibility floor (connect time) AND the
 * baseline history cursor together, only while the generation is current. The
 * floor is set once and never moved, so recovery always references connect time. */
export async function seedGmailCursor(
  snapshot: GmailMailboxSnapshot,
  historyId: string,
  eligibleAfter: Date,
): Promise<boolean> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.update(ticketMailboxConnections)
      // Always set the cursor; set the floor via COALESCE so it is established
      // ONCE at first seed and never moved forward afterwards (moving it would
      // skip mail). SQL-side COALESCE avoids a read-modify-write race.
      .set({
        historyId,
        // Bind the Date as an ISO string + explicit cast: a raw JS Date
        // interpolated into a sql`` template is not column-type-aware and
        // postgres.js rejects it (ERR_INVALID_ARG_TYPE), which would make the seed
        // silently throw and never persist the cursor.
        eligibleAfter: sql`COALESCE(${ticketMailboxConnections.eligibleAfter}, ${eligibleAfter.toISOString()}::timestamptz)`,
        lastPolledAt: new Date(),
        updatedAt: new Date(),
      })
      // Require the cursor to still be NULL: worker concurrency:1 is per-worker,
      // not global, so two sweeps could both read an unseeded row and capture
      // different baselines. Only the first seed wins; the loser (0 rows) simply
      // re-reads the now-seeded cursor next tick and goes incremental — no gap.
      .where(and(connectedGmailPredicate(snapshot), isNull(ticketMailboxConnections.historyId)))
      .returning({ id: ticketMailboxConnections.id });
    return rows.length === 1;
  }));
}

/** Advance the Gmail history cursor, but only if the generation is still current
 * (guards against a disable/re-consent that raced the sweep) AND the cursor is
 * still at the value this sweep started from (compare-and-swap). Two sweeps can
 * overlap: both read the same starting cursor, list changes, and race to write.
 * Without the CAS a slow sweep could commit its (older) newHistoryId after a fast
 * one already advanced past it, moving the cursor BACKWARD and forcing the next
 * sweep to re-list — or, if the older window had rolled off, silently skip mail.
 * Predicating on the starting cursor makes the loser's update match 0 rows; it
 * simply re-reads the advanced cursor next tick. */
export async function updateHistoryCursor(
  snapshot: GmailMailboxSnapshot,
  expectedFromHistoryId: string,
  historyId: string,
  polledAt: Date,
  lastMessageAt: Date | null,
): Promise<boolean> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.update(ticketMailboxConnections)
      .set({
        historyId,
        lastPolledAt: polledAt,
        // Never move last_message_at BACKWARD across sweeps: a later sweep can
        // surface an older message (e.g. a labelAdded(INBOX) on old mail), whose
        // per-batch max is older than what a prior sweep already stored. GREATEST
        // keeps the newest ever seen (and ignores a NULL existing value).
        ...(lastMessageAt
          ? { lastMessageAt: sql`GREATEST(${ticketMailboxConnections.lastMessageAt}, ${lastMessageAt.toISOString()}::timestamptz)` }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(
        connectedGmailPredicate(snapshot),
        eq(ticketMailboxConnections.historyId, expectedFromHistoryId),
      ))
      .returning({ id: ticketMailboxConnections.id });
    return rows.length === 1;
  }));
}

/** Expired historyId (Gmail 404): clear the cursor so the next sweep re-seeds
 * from the current profile historyId. Stays 'connected'. Note: a re-seed does
 * not backfill mail that arrived and was removed from the inbox during the gap
 * — recovery is best-effort and the eligibility floor still applies. */
export async function resetHistoryCursor(snapshot: GmailMailboxSnapshot): Promise<boolean> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.update(ticketMailboxConnections)
      .set({ historyId: null, updatedAt: new Date() })
      .where(connectedGmailPredicate(snapshot))
      .returning({ id: ticketMailboxConnections.id });
    return rows.length === 1;
  }));
}

/** Move a Gmail connection off 'connected' on a poll failure (reauth vs error),
 * only while the generation is current. */
export async function setGmailMailboxStatus(
  snapshot: GmailMailboxSnapshot,
  status: Extract<MailboxConnectionStatus, 'reauth_required' | 'error'>,
  lastError: string,
): Promise<boolean> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.update(ticketMailboxConnections)
      .set({ status, lastError, updatedAt: new Date() })
      .where(connectedGmailPredicate(snapshot))
      .returning({ id: ticketMailboxConnections.id });
    return rows.length === 1;
  }));
}
