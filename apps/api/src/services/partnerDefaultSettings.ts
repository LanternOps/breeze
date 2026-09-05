/**
 * Settings defaults applied to every newly-created partner, on EVERY creation
 * path.
 *
 * Deliberately dependency-free (no db, no schema, no config imports) so any
 * creation path — service, route handler, or seed — can call it without
 * dragging a module graph along, and so suites that mock `../db/schema` with a
 * non-partial factory can import it safely.
 *
 * Issue #3608 (decision: Option B, 2026-08-16): new partners opt IN to inbound
 * email-to-ticket rather than inheriting the readers' "absent flag reads as
 * true" fallback. That fallback (`loadPartnerInboundPolicy` in
 * `inboundEmail/resolveOrg.ts` and `getTicketConfig` in `ticketConfigService.ts`,
 * both `enabled !== false`) stays as-is — it exists solely as the pre-#3606
 * upgrade path for partners created before this default existed. Do NOT "fix"
 * the readers to match this new-partner default; the two are deliberately
 * different concerns. Do NOT backfill existing partners' settings.
 *
 * Issue #4520: the default originally lived inline in `createPartner()`, so the
 * platform-admin `POST /orgs/partners` handler — which inserts partners
 * directly — silently missed it and minted `{}`-settings partners that read as
 * inbound-enabled. Extracted here so all creation paths share one definition;
 * add the call to any NEW partner-insert site rather than re-inlining the shape.
 */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Merge the new-partner defaults into caller-supplied settings.
 *
 * Caller intent wins: an explicit `ticketing.inbound.enabled` (true or false)
 * is preserved, and every unrelated key is carried through untouched. The
 * default is only filled in where the caller left the flag absent.
 *
 * Values that cannot hold the flag are normalized rather than preserved. The
 * readers traverse `settings.ticketing.inbound.enabled` and treat anything
 * untraversable as absent — i.e. enabled — so preserving a non-object at any
 * level along that path would fail OPEN, which is exactly what #3608 set out to
 * stop. Nothing usable is lost: no reader can interpret those shapes anyway,
 * and the admin route echoes the persisted `settings` back in its 201 response,
 * so a caller who sent a malformed value sees what actually landed.
 *
 * Returns a fresh object; the caller's input is never mutated.
 */
export function applyNewPartnerDefaultSettings(settings?: unknown): Record<string, unknown> {
  const base = isPlainObject(settings) ? { ...settings } : {};
  const ticketing = isPlainObject(base.ticketing) ? { ...base.ticketing } : {};
  const inbound = isPlainObject(ticketing.inbound) ? { ...ticketing.inbound } : {};

  if (inbound.enabled === undefined) {
    inbound.enabled = false;
  }

  ticketing.inbound = inbound;
  base.ticketing = ticketing;
  return base;
}
