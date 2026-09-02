import { coreRequest } from './api';

/**
 * W10 (#4336). Per-USER ticket push preferences.
 *
 * These follow the technician across every phone they sign in on, unlike the
 * per-device alert settings behind `PATCH /devices/:id/settings`.
 *
 * The types are declared locally rather than imported from
 * `@breeze/shared/validators/ticketPushPreferences`: the mobile app has no
 * dependency on the shared package (Expo bundles from source, and pulling the
 * whole validator package in for two types would drag zod into the app
 * bundle). The wire contract is the `settings` object, and the API route tests
 * own it on the server side.
 */
export type TicketSlaPushScope = 'off' | 'owned' | 'any';

export interface TicketPushPreferences {
  assignedEnabled: boolean;
  slaScope: TicketSlaPushScope;
}

/**
 * At least one key, mirroring the server's `.refine()` on
 * `updateTicketPushPreferencesSchema`. A plain `Partial<>` would let
 * `updateTicketPushPrefs({})` typecheck and then 400 at runtime.
 */
export type UpdateTicketPushPreferences =
  | { assignedEnabled: boolean; slaScope?: TicketSlaPushScope }
  | { assignedEnabled?: boolean; slaScope: TicketSlaPushScope };

/** Mirrors TICKET_PUSH_PREFERENCE_DEFAULTS in packages/shared. */
export const TICKET_PUSH_PREFERENCE_DEFAULTS: TicketPushPreferences = {
  assignedEnabled: true,
  slaScope: 'owned',
};

const SLA_SCOPES: readonly TicketSlaPushScope[] = ['off', 'owned', 'any'];

/**
 * Normalise whatever came back onto the two settings the UI renders.
 *
 * The server normalises too (`resolveTicketPushPrefs`), so this is defence
 * against a truncated or older-shaped body — without it a missing field
 * renders as an unchecked switch, and the next tap PATCHes a change the
 * technician never intended to make.
 */
function normalize(raw: unknown): TicketPushPreferences {
  const settings = (raw ?? {}) as Partial<TicketPushPreferences>;
  return {
    assignedEnabled:
      typeof settings.assignedEnabled === 'boolean'
        ? settings.assignedEnabled
        : TICKET_PUSH_PREFERENCE_DEFAULTS.assignedEnabled,
    slaScope:
      typeof settings.slaScope === 'string' && SLA_SCOPES.includes(settings.slaScope)
        ? settings.slaScope
        : TICKET_PUSH_PREFERENCE_DEFAULTS.slaScope,
  };
}

/**
 * `coreRequest`, not `request`: this route lives on the core `/api/v1` surface
 * (`apps/api/src/routes/users.ts`). The default helper prefixes
 * `/api/v1/mobile`, where no such route exists — a 404 that would be
 * indistinguishable from "nothing saved yet".
 */
export async function getTicketPushPrefs(): Promise<TicketPushPreferences> {
  const res = await coreRequest<{ settings?: TicketPushPreferences }>(
    '/users/me/ticket-push-preferences'
  );
  return normalize(res?.settings);
}

/**
 * Send only the keys that changed. The API schema is `.strict()`, so an unknown
 * key (or a `userId` — the route is self-only by construction) is a 400.
 */
export async function updateTicketPushPrefs(
  patch: UpdateTicketPushPreferences
): Promise<TicketPushPreferences> {
  const res = await coreRequest<{ settings?: TicketPushPreferences }>(
    '/users/me/ticket-push-preferences',
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }
  );
  return normalize(res?.settings);
}
