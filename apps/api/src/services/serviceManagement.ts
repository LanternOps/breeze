import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partners } from '../db/schema/orgs';

/**
 * Which service-desk/billing module a partner runs (#5075 W04).
 *
 * Spec: docs/superpowers/specs/web-ui/2026-09-06-organization-record-page-design.md, Part 2.
 *
 * - `native`   — Breeze's own service desk & billing. The default, and what
 *                every partner ran before the column existed.
 * - `external` — the partner's PSA is the system of record. Breeze still holds
 *                shadow rows, so Breeze-side creation stays allowed.
 * - `off`      — RMM only. The Service Desk and Billing surfaces are withdrawn
 *                and NEW ticket creation is refused.
 *
 * **This is a product module switch, not authorization.** Existing tickets stay
 * readable, every route keeps its own permission checks, and there is exactly
 * ONE behavioural gate in the API: `assertTicketCreationAllowed`, called from
 * `ticketService.createTicket`. Do not add per-route mode checks — every native
 * creation surface (alert dialog, the `manage_tickets` AI tool, portal, Office
 * add-in, email-to-ticket) inherits the refusal through that one call site.
 */
export type ServiceManagementMode = 'native' | 'external' | 'off';

/** Mirrors `partners_service_management_mode_chk`. Order is the CHECK's order. */
export const SERVICE_MANAGEMENT_MODES: readonly ServiceManagementMode[] = ['native', 'external', 'off'];

const MODE_SET = new Set<string>(SERVICE_MANAGEMENT_MODES);

function isServiceManagementMode(value: unknown): value is ServiceManagementMode {
  return typeof value === 'string' && MODE_SET.has(value);
}

/**
 * Thrown by `assertTicketCreationAllowed`. `ticketService.createTicket`
 * translates it into a `TicketServiceError(…, 409, 'service_management_off')`
 * so every existing `instanceof TicketServiceError` handler surfaces it
 * unchanged; nothing outside that translation should need to catch this type.
 */
export class ServiceManagementOffError extends Error {
  readonly code = 'service_management_off' as const;
  readonly status = 409 as const;

  constructor(message = 'Service Management is turned off for this partner') {
    super(message);
    this.name = 'ServiceManagementOffError';
  }
}

/**
 * The partner's stored mode, defaulting to `native`.
 *
 * Fails OPEN in every uncertain case — a missing partner id, a missing row, a
 * NULL, or a value the API does not recognise (a newer deploy's mode read by an
 * older one) all answer `native`. Failing closed would withdraw a module the
 * partner is paying for; failing open only means the UI shows a surface whose
 * routes still enforce their own permissions.
 */
export async function getServiceManagementMode(
  partnerId: string | null | undefined,
): Promise<ServiceManagementMode> {
  if (!partnerId) return 'native';

  const rows = await db
    .select({ serviceManagementMode: partners.serviceManagementMode })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1);

  const stored = rows[0]?.serviceManagementMode;
  return isServiceManagementMode(stored) ? stored : 'native';
}

/**
 * Refuse NEW ticket creation when the partner has the module switched off.
 *
 * The only mode-derived behavioural gate in the API. `external` is allowed
 * through: it still writes the Breeze-side shadow row the follow-on external
 * service-desk feature links to the PSA.
 */
export async function assertTicketCreationAllowed(partnerId: string | null | undefined): Promise<void> {
  const mode = await getServiceManagementMode(partnerId);
  if (mode === 'off') throw new ServiceManagementOffError();
}
