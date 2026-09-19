import { inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { users } from '../../db/schema';
import { captureException } from '../../services/sentry';

/**
 * Alert columns that hold a user id. Each gets a `<field>Name` companion in the
 * API response so clients render the technician's name instead of a raw UUID
 * (#3966).
 *
 * `feedbackBy` (#4445) is not an alert column — it lives on the `ai_alert_verdicts`
 * row a verdict badge shows. The alerts route builds pseudo-rows (`{ id:
 * verdict.id, feedbackBy: verdict.feedbackBy }`) to run through this same
 * batched lookup rather than duplicating `resolveUserDisplayNames`, since the
 * safety argument below (ids only ever come from already access-checked rows)
 * holds just as well for verdict ids as alert ids.
 */
const ACTOR_NAME_KEY = {
  acknowledgedBy: 'acknowledgedByName',
  resolvedBy: 'resolvedByName',
  dismissedBy: 'dismissedByName',
  feedbackBy: 'feedbackByName',
} as const;

type ActorIdField = keyof typeof ACTOR_NAME_KEY;

const ACTOR_ID_FIELDS = Object.keys(ACTOR_NAME_KEY) as ActorIdField[];

export type AlertActorRow = Partial<Record<ActorIdField, string | null>>;

export type AlertActorNames = Partial<
  Record<(typeof ACTOR_NAME_KEY)[ActorIdField], string | null>
>;

/**
 * Look up display names for a set of user ids.
 *
 * Runs in a short system-context block. `users` RLS grants visibility via
 * `breeze_has_partner_access(partner_id)` OR org access to `users.org_id` OR
 * self-read, and MSP staff rows carry `org_id = NULL` — so an ORG-scoped caller
 * cannot see the technician who acknowledged the alert, and a plain join would
 * silently null the name out for exactly the common MSP case. Same shape (and
 * same justification) as the partner-wide notification-channel join in
 * `alerts.ts`.
 *
 * The exposure is bounded: ids only ever come off alert rows the caller was
 * already access-checked for, and only the display name is returned — no email,
 * no tenancy columns. The Audit Trail already shows those same callers the
 * acting user's name/email for the same actions.
 *
 * Deliberately NOT exported (#3983). This is an RLS-bypassing name oracle: it
 * accepts an arbitrary list of user ids and resolves them outside any request
 * tenancy scope. That's only safe because `withAlertActorNames` below is the
 * sole caller and every id it passes in already came off an access-checked
 * alert row. A general-purpose exported "give me names for these ids" helper
 * invites a future caller (an endpoint that echoes ids from a request body, a
 * batch/list route resolving ids it never itself authorized) to turn this into
 * cross-tenant user enumeration. Keep it module-private; route all name
 * resolution through `withAlertActorNames`.
 */
async function resolveUserDisplayNames(
  userIds: readonly (string | null | undefined)[]
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0)),
  ];
  if (ids.length === 0) {
    return new Map();
  }

  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, ids))
    )
  );

  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * Attach `<field>Name` to each alert row for every actor id field the row
 * actually carries. A field the caller did not select is left alone (no
 * fabricated `null` name); a present-but-unresolvable id (deleted user) yields
 * `null` so clients can fall back to a generic label rather than printing the
 * UUID.
 *
 * Never throws: a failed lookup degrades to unenriched rows (see below) so the
 * alerts payload itself always survives.
 */
export async function withAlertActorNames<T extends AlertActorRow>(
  rows: T[]
): Promise<(T & AlertActorNames)[]> {
  if (rows.length === 0) {
    return [];
  }

  let names: Map<string, string>;
  try {
    names = await resolveUserDisplayNames(
      rows.flatMap((row) => ACTOR_ID_FIELDS.map((field) => row[field]))
    );
  } catch (error) {
    // Names are cosmetic enrichment. By the time we get here the alerts
    // themselves are fetched, access-checked and joined — a `users` blip (pool
    // exhaustion, a transient PG error, a fault establishing the system context)
    // must not turn the whole Alerts page into a 500. Degrade to unenriched
    // rows, which clients already render as the generic "unknown user" label.
    //
    // Loud for engineers, graceful for the operator: without this report the
    // degradation WOULD be a silent failure, indistinguishable from "that user
    // was deleted".
    captureException(error, undefined, {
      route: 'alerts',
      stage: 'actor-name-resolution',
    });
    console.error('[alerts] actor display-name lookup failed; returning alerts without names', error);
    return rows as (T & AlertActorNames)[];
  }

  return rows.map((row) => {
    const enriched = { ...row } as T & AlertActorNames;
    for (const field of ACTOR_ID_FIELDS) {
      if (!(field in row)) continue;
      const id = row[field];
      (enriched as Record<string, unknown>)[ACTOR_NAME_KEY[field]] = id
        ? names.get(id) ?? null
        : null;
    }
    return enriched;
  });
}
