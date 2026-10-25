import { fetchWithAuth } from '../../stores/auth';
import { runAction, type RunActionOptions } from '../../lib/runAction';

// How inbound mail from an unmatched ("unknown") sender is handled. Mirrors the
// API's PartnerInboundPolicy union (settings.ticketing.inbound.unknownSenderMode).
export type UnknownSenderMode = 'quarantine' | 'triage' | 'drop';

export interface InboundConfig {
  enabled: boolean;
  address: string;
  addressOverride: string | null;
  inboundLocalPart: string | null;
  defaultTriageOrgId: string | null;
  autoresponderEnabled: boolean;
  unknownSenderMode: UnknownSenderMode;
  dropUnverifiedSenders: boolean;
  // File a staff member's forward under the ORIGINAL sender's customer org.
  // Absent on an older API -> treated as off.
  staffForwardRouting?: boolean;
  // users.id every new inbound ticket falls back to when no routing rule
  // assigns it; null = unassigned. Absent on an older API -> treated as none.
  // Edited on the Routing tab (InboundFallbackAssigneeEditor), carried through
  // every save of this object by both surfaces.
  defaultAssigneeUserId?: string | null;
  autoresponseSubject: string | null;
  autoresponseBody: string | null;
  // Reply-content mode. Not edited by the card, but carried through so a save
  // preserves a value set via the API (the PATCH route replaces the inbound
  // sub-object wholesale — an omitted field is destroyed).
  fullMessageReply: boolean;
  slug: string;
  domainConfigured: boolean;
  // Connected M365 shared mailboxes (status 'connected'). Absent on an older
  // API -> 0.
  connectedMailboxCount?: number;
  // Mirrors the API's IS_HOSTED. Absent (older API) is treated as hosted.
  isHosted?: boolean;
}

// A row from GET /orgs/partners/me/default-assignee-candidates: exactly the
// users the API accepts as the default assignee.
export interface AssigneeOption {
  id: string;
  name: string | null;
  email: string;
}

/** GET /ticket-config -> the inbound block. Throws when the response is not OK. */
export async function fetchInboundConfig(): Promise<InboundConfig> {
  const res = await fetchWithAuth('/ticket-config');
  if (!res.ok) throw new Error(`ticket-config load failed: ${res.status}`);
  const body = (await res.json()) as { data: { inbound: InboundConfig } };
  return { ...body.data.inbound, inboundLocalPart: body.data.inbound.inboundLocalPart ?? null };
}

/** Candidates filtered server-side by the same rule the save enforces. Degrades to []. */
export async function fetchAssigneeCandidates(): Promise<AssigneeOption[]> {
  try {
    const res = await fetchWithAuth('/orgs/partners/me/default-assignee-candidates');
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: AssigneeOption[] };
    return Array.isArray(body.data) ? body.data.filter((u) => u.id) : [];
  } catch {
    return [];
  }
}

/**
 * The COMPLETE ticketing.inbound object. PATCH /orgs/partners/me deep-merges
 * `ticketing` one level but replaces the `inbound` sub-object wholesale, so any
 * omitted inbound field is destroyed (this also retires the legacy
 * `triageUnknownSenders` key, which we no longer send). `address` is included
 * ONLY for a real self-hosted override, never the derived value.
 *
 * The single serializer for BOTH InboundEmailCard and the Routing tab's fallback
 * assignee editor, so the two cannot fork what a save preserves.
 */
export function buildInboundPayload(next: InboundConfig): Record<string, unknown> {
  const inbound: Record<string, unknown> = {
    enabled: next.enabled,
    defaultTriageOrgId: next.defaultTriageOrgId,
    autoresponderEnabled: next.autoresponderEnabled,
    unknownSenderMode: next.unknownSenderMode,
    dropUnverifiedSenders: next.dropUnverifiedSenders,
    staffForwardRouting: next.staffForwardRouting === true,
    defaultAssigneeUserId: next.defaultAssigneeUserId ?? null,
    autoresponseSubject: next.autoresponseSubject,
    autoresponseBody: next.autoresponseBody,
    ...(next.fullMessageReply ? { fullMessageReply: true } : {}),
  };
  if (next.addressOverride) inbound.address = next.addressOverride;
  return inbound;
}

/** PATCH the complete inbound object through runAction (callers own the catch). */
export function saveInboundConfig(
  next: InboundConfig,
  opts: Pick<RunActionOptions<unknown>, 'errorFallback' | 'successMessage' | 'friendly' | 'onUnauthorized'>,
): Promise<unknown> {
  return runAction({
    ...opts,
    request: () =>
      fetchWithAuth('/orgs/partners/me', {
        method: 'PATCH',
        body: JSON.stringify({ settings: { ticketing: { inbound: buildInboundPayload(next) } } }),
      }),
  });
}
