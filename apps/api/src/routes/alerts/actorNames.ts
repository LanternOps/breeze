import { inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { users } from '../../db/schema';

/**
 * Alert columns that hold a user id. Each gets a `<field>Name` companion in the
 * API response so clients render the technician's name instead of a raw UUID
 * (#3966).
 */
const ACTOR_NAME_KEY = {
  acknowledgedBy: 'acknowledgedByName',
  resolvedBy: 'resolvedByName',
  dismissedBy: 'dismissedByName',
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
 */
export async function resolveUserDisplayNames(
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
 */
export async function withAlertActorNames<T extends AlertActorRow>(
  rows: T[]
): Promise<(T & AlertActorNames)[]> {
  if (rows.length === 0) {
    return [];
  }

  const names = await resolveUserDisplayNames(
    rows.flatMap((row) => ACTOR_ID_FIELDS.map((field) => row[field]))
  );

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
