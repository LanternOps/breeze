/**
 * Contact resolution for contact-targeted admission (Recipe Library spec §8,
 * §5.2, D-R1-6; W06 R1a Task 9).
 *
 * TWO PHASES, so a provider round trip never runs while admission locks are
 * held:
 *  1. BEFORE the admission transaction (read-only): `identifyTaskPerson`
 *     resolves the person to an existing contact or a new address, and
 *     `resolveProviderAccounts` finds their M365 / Google accounts from
 *     `contact_external_links`, falling back to a provider read by address.
 *  2. INSIDE the admission transaction: `pinContact` re-reads an existing
 *     contact `FOR KEY SHARE` (so the target insert cannot hit a 23503 that
 *     would abort the transaction), `createContactForTask` creates a new one
 *     under the inbound-email per-address advisory lock, `lockContactForRecipe`
 *     serializes admissions per (recipe, contact), and `findLiveTaskForContact`
 *     answers "one live task per (contact, recipe)" as a refusal — never as a
 *     caught constraint error.
 *
 * A FREE-TEXT HINT NEVER CREATES A CONTACT. "Dana in accounting" resolves only
 * when exactly one contact's name matches; otherwise admission refuses as
 * ambiguous and the technician picks the contact (the draft route returns the
 * candidates). An email hint with no match becomes a new contact — but only
 * after provider accounts were found for it, and only inside the transaction.
 *
 * TENANCY. Everything runs in system scope (RLS bypassed). The explicit
 * `org_id` predicate on every read IS the isolation, and the unit test asserts
 * each one.
 */
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { contactExternalLinks, contacts } from '../../db/schema/contacts';
import { aiOperatorTasks } from '../../db/schema/aiOperatorTasks';
import { aiOperatorTaskTargets } from '../../db/schema/aiOperatorTaskGraph';
import { m365Connections } from '../../db/schema/m365';
import { googleWorkspaceConnections } from '../../db/schema/google';
import { createContact, matchContactByEmail, normalizeContactEmail } from '../contacts/crud';
import { INBOUND_CONTACT_LOCK_NAMESPACE } from '../inboundEmail/resolveOrg';
import { executeM365ReadActionByOrg } from '../m365ControlPlane/readActionService';
import { canonicalizeUserEmail, resolveContextByOrg } from '../aiToolsGoogle';
import { getDirectoryClient } from '../googleClient';
import { TERMINAL_TASK_STATES } from './taskTransitions';

export type PersonIdentification =
  | { ok: true; kind: 'existing'; contactId: string; label: string; email: string | null }
  | { ok: true; kind: 'new'; email: string; label: string }
  | { ok: false; reason: 'contact_not_in_org' | 'ambiguous'; detail: string };

export interface ResolvedProviderAccount {
  provider: 'm365' | 'google';
  /** Entra object id / Google user id — immutable, never the UPN. */
  externalId: string;
  principalLabel: string;
  connectionId: string | null;
  /** True when read from contact_external_links (nothing to upsert). */
  fromLink: boolean;
}

const MAX_LABEL = 255;

/**
 * Provider lookups resolve their connection row (forced RLS) in a context
 * scoped to exactly this org — never the caller's ambient context, which is
 * absent off the request path and broader than one org on it.
 */
function inOrgContext<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withDbAccessContext(
    { scope: 'organization', orgId, accessibleOrgIds: [orgId], label: 'aiOperator.contactResolution' },
    fn,
  ));
}

/** Phase 1. Who is being offboarded? Read-only, system scope, org-predicated. */
export async function identifyTaskPerson(
  orgId: string,
  args: { contactId: string | null; personHint: string | null },
): Promise<PersonIdentification> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    if (args.contactId) {
      const [row] = await db
        .select({ id: contacts.id, name: contacts.name, email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.orgId, orgId), eq(contacts.id, args.contactId)))
        .limit(1);
      // Non-enumerating: the same answer whether the id exists in another org or nowhere.
      if (!row) return { ok: false, reason: 'contact_not_in_org', detail: 'contact not found in this organization' };
      return { ok: true, kind: 'existing', contactId: row.id, label: (row.name ?? row.email ?? row.id).slice(0, MAX_LABEL), email: row.email };
    }

    const hint = (args.personHint ?? '').trim();
    const email = canonicalizeUserEmail(hint);
    if (email) {
      const rows = await db
        .select({ id: contacts.id, name: contacts.name, email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.orgId, orgId), sql`lower(${contacts.email}) = ${email}`))
        .limit(2);
      if (rows.length > 1) {
        return { ok: false, reason: 'ambiguous', detail: `more than one contact uses ${email}; choose the contact to offboard` };
      }
      const row = rows[0];
      if (row) return { ok: true, kind: 'existing', contactId: row.id, label: (row.name ?? row.email ?? email).slice(0, MAX_LABEL), email: row.email };
      return { ok: true, kind: 'new', email, label: email };
    }

    if (hint.length < 2) return { ok: false, reason: 'ambiguous', detail: 'name the person by contact or email address' };
    // EXACT (case-insensitive, trimmed) full-name match only. A substring
    // match would let "Dan" resolve to the one "Dana Smith" in the org and
    // freeze HER accounts — the wrong-person risk spec §11 puts first. Anything
    // short of an exact, unique match is the technician's choice to make.
    const rows = await db
      .select({ id: contacts.id, name: contacts.name, email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.orgId, orgId), sql`lower(btrim(${contacts.name})) = ${hint.toLowerCase()}`))
      .limit(2);
    if (rows.length === 1) {
      const row = rows[0]!;
      return { ok: true, kind: 'existing', contactId: row.id, label: (row.name ?? row.email ?? row.id).slice(0, MAX_LABEL), email: row.email ?? null };
    }
    return {
      ok: false,
      reason: 'ambiguous',
      detail: rows.length === 0
        ? 'no contact in this organization matches that name; choose the contact or give an email address'
        : 'several contacts match that name; choose the contact to offboard',
    };
  }));
}

/**
 * Phase 1. The person's provider accounts. Links first (org-predicated), then
 * a provider read BY ADDRESS for any provider with no link. Provider errors
 * are collected, never thrown: "no account" is decided by the caller.
 */
export async function resolveProviderAccounts(
  orgId: string,
  person: { contactId: string | null; email: string | null; label: string },
): Promise<{ accounts: ResolvedProviderAccount[]; problems: string[] }> {
  const problems: string[] = [];
  const accounts: ResolvedProviderAccount[] = [];
  const email = person.email ? canonicalizeUserEmail(person.email) : null;

  const { links, m365ConnectionId, m365Connected, m365Unusable, googleConnected } = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const linkRows = person.contactId
      ? await db
        .select({ system: contactExternalLinks.system, externalId: contactExternalLinks.externalId })
        .from(contactExternalLinks)
        .where(and(
          eq(contactExternalLinks.orgId, orgId),
          eq(contactExternalLinks.contactId, person.contactId),
          inArray(contactExternalLinks.system, ['m365', 'google']),
        ))
        .limit(10)
      : [];
    // Any profile counts as "this org uses Microsoft 365" (the lookup itself
    // reads through the read profile); the actions row is the one frozen onto
    // the account, since that is the connection the effects write through.
    const m365Rows = await db
      .select({ id: m365Connections.id, profile: m365Connections.profile, status: m365Connections.status })
      .from(m365Connections)
      .where(eq(m365Connections.orgId, orgId))
      .limit(10);
    const conn = m365Rows.find((r) => r.profile === 'customer-graph-actions');
    const [google] = await db
      .select({ id: googleWorkspaceConnections.id })
      .from(googleWorkspaceConnections)
      .where(eq(googleWorkspaceConnections.orgId, orgId))
      .limit(1);
    // Fail closed: ANY row means this org has used Microsoft 365, so the person
    // may have an account there. A revoked or consent-pending row (a failed
    // re-consent also lands there) cannot be looked through; it is reported as
    // its own problem rather than read as "does not use Microsoft 365".
    const m365Connected = m365Rows.length > 0;
    const m365Unusable = m365Connected && m365Rows.every((r) => r.status === 'revoked' || r.status === 'pending-consent')
      ? m365Rows[0]!.status : null;
    return { links: linkRows, m365ConnectionId: conn?.id ?? null, m365Connected, m365Unusable, googleConnected: Boolean(google) };
  }));

  const linked = (system: 'm365' | 'google') => links.find((l) => l.system === system)?.externalId ?? null;
  const labelFor = (externalId: string) => (email ?? person.label ?? externalId).slice(0, MAX_LABEL);

  // Microsoft 365
  const m365Linked = linked('m365');
  if (m365Linked) {
    accounts.push({ provider: 'm365', externalId: m365Linked, principalLabel: labelFor(m365Linked), connectionId: m365ConnectionId, fromLink: true });
  } else if (email && m365Unusable) {
    problems.push(`m365 connection is ${m365Unusable}, so Breeze could not look this person up in Microsoft 365`);
  } else if (email && m365Connected) {
    // No connection row at all means "this org does not use Microsoft 365",
    // not a failed lookup. A row in ANY state is looked through, so a broken
    // connection surfaces as a problem instead of a provider silently skipped.
    try {
      const r = await inOrgContext(orgId, () => executeM365ReadActionByOrg(orgId, { type: 'm365.user.get', userIdOrUpn: email }));
      if (r.ok && r.kind === 'resource' && typeof r.resource.id === 'string') {
        // Accept the account only when its OWN address is the one asked for:
        // a lookup that resolved through an alias or a proxy address may be a
        // different person's mailbox, and freezing it would offboard them.
        const upn = typeof r.resource.userPrincipalName === 'string' ? canonicalizeUserEmail(r.resource.userPrincipalName) : null;
        const mail = typeof r.resource.mail === 'string' ? canonicalizeUserEmail(r.resource.mail) : null;
        if (upn === email || mail === email) {
          accounts.push({ provider: 'm365', externalId: r.resource.id, principalLabel: (upn ?? email).slice(0, MAX_LABEL), connectionId: m365ConnectionId, fromLink: false });
        } else {
          problems.push(`m365: ${email} resolves to a different primary account (${upn ?? 'unknown'}); link the contact to the right account`);
        }
      } else if (!r.ok && r.code !== 'graph_not_found') {
        problems.push(`m365 lookup failed (${r.code})`);
      }
    } catch (err) {
      problems.push(`m365 lookup failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // Google Workspace
  const googleLinked = linked('google');
  let googleConnectionId: string | null = null;
  if (googleLinked || email) {
    try {
      const ctx = await inOrgContext(orgId, () => resolveContextByOrg(orgId));
      if ('error' in ctx) {
        // Connected (a row exists) but not usable: the person may well have an
        // account there that this task would otherwise never look at.
        if (googleLinked || googleConnected) problems.push('google connection unavailable');
      } else {
        googleConnectionId = (ctx.conn as { id?: string }).id ?? null;
        if (googleLinked) {
          accounts.push({ provider: 'google', externalId: googleLinked, principalLabel: labelFor(googleLinked), connectionId: googleConnectionId, fromLink: true });
        } else if (email) {
          const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
          const res = await dir.users.get({ userKey: email });
          const id = typeof res.data.id === 'string' ? res.data.id : null;
          const primary = typeof res.data.primaryEmail === 'string' ? canonicalizeUserEmail(res.data.primaryEmail) : null;
          // Same rule as M365: an alias lookup that lands on a different
          // primary account is refused, never frozen.
          if (id && primary === email) {
            accounts.push({ provider: 'google', externalId: id, principalLabel: primary.slice(0, MAX_LABEL), connectionId: googleConnectionId, fromLink: false });
          } else if (id) {
            problems.push(`google: ${email} resolves to a different primary account (${primary ?? 'unknown'}); link the contact to the right account`);
          }
        }
      }
    } catch (err) {
      const status = (err as { code?: unknown })?.code;
      if (status !== 404) problems.push(`google lookup failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  return { accounts, problems };
}

/**
 * Phase 2. Re-read an existing contact `FOR KEY SHARE`, org-predicated, so a
 * concurrent delete cannot turn the target insert into a 23503 that aborts the
 * admission transaction (the same acquisition `matchContactByEmail` uses).
 */
export async function pinContact(orgId: string, contactId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId)))
    .for('key share')
    .limit(1);
  return row !== undefined;
}

/**
 * Phase 2. Create the contact for a new address, under the inbound-email
 * per-address advisory lock (`resolveOrg.ts`), so an inbound email and an
 * admission for the same new address cannot both create it. Re-matches under
 * the lock: a contact that appeared since phase 1 is used, not duplicated.
 */
export async function createContactForTask(
  orgId: string,
  email: string,
  requesterUserId: string | null,
): Promise<{ ok: true; contactId: string; created: boolean } | { ok: false; reason: 'ambiguous'; detail: string }> {
  const normalized = normalizeContactEmail(email);
  if (!normalized) return { ok: false, reason: 'ambiguous', detail: 'the address cannot identify a contact' };
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${INBOUND_CONTACT_LOCK_NAMESPACE}), hashtext(${`${orgId}:${normalized}`}))`,
  );
  const found = await matchContactByEmail(db, orgId, normalized);
  if (found.kind === 'contact') return { ok: true, contactId: found.contactId, created: false };
  if (found.kind === 'none') {
    return { ok: false, reason: 'ambiguous', detail: `the address ${normalized} matches more than one contact or cannot be pinned (${found.reason})` };
  }
  const created = await createContact(
    db,
    { orgId, email: normalized, name: null, roles: [] },
    { userId: requesterUserId, destinationSource: 'ai_tool' },
  );
  return { ok: true, contactId: created.id, created: true };
}

/**
 * Phase 2, transaction-scoped (D-R1-6): `pg_advisory_xact_lock` over
 * `'ai_operator:' + recipeKey + ':' + contactId`. Auto-released on commit or
 * rollback. A different recipe on the same contact is a different key, so an
 * offboarding and a future onboarding never block each other. Touches no user
 * table and blocks nothing else.
 */
export async function lockContactForRecipe(_orgId: string, recipeKey: string, contactId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ai_operator:${recipeKey}:${contactId}`}, 0))`);
}

/** Phase 2, under the lock above: a non-terminal task of this recipe that targets this contact. */
export async function findLiveTaskForContact(
  orgId: string,
  recipeKey: string,
  contactId: string,
): Promise<{ taskId: string } | null> {
  const [row] = await db
    .select({ id: aiOperatorTasks.id })
    .from(aiOperatorTasks)
    .innerJoin(aiOperatorTaskTargets, and(
      eq(aiOperatorTaskTargets.taskId, aiOperatorTasks.id),
      eq(aiOperatorTaskTargets.orgId, aiOperatorTasks.orgId),
    ))
    .where(and(
      eq(aiOperatorTasks.orgId, orgId),
      eq(aiOperatorTaskTargets.orgId, orgId),
      eq(aiOperatorTasks.workflowKey, recipeKey),
      eq(aiOperatorTaskTargets.targetKind, 'contact'),
      eq(aiOperatorTaskTargets.contactId, contactId),
      notInArray(aiOperatorTasks.state, [...TERMINAL_TASK_STATES]),
    ))
    .limit(1);
  return row ? { taskId: row.id } : null;
}
