/**
 * The one resolver for "does this PSA connection auto-ticket alerts, and with
 * what config" (#10499 W2-A, settings rule 5). Admission, the worker and the
 * Alert tickets card all call it, so the activation rule lives in one place.
 *
 * Pure: callers load the connection row and the owning partner's
 * service-management binding, and compute the instance key from the decrypted
 * credentials (`psaInstanceKey`). Nothing here touches the database or the
 * network.
 */

import { createHash } from 'node:crypto';
import {
  alertTicketingStoredSchemaFor,
  psaProviderIdSchema,
  type AlertTicketingInactiveReason,
  type ConnectwiseAlertTicketingStored,
} from '@breeze/shared';

export interface AlertTicketingConnectionRow {
  id: string;
  partnerId: string | null;
  provider: string;
  alertTicketing: unknown;
  alertTicketingRev: number;
  alertTicketingPausedReason: string | null;
}

export interface AlertTicketingPartnerBinding {
  serviceManagementMode: 'native' | 'external' | 'off';
  serviceManagementPsaConnectionId: string | null;
}

export type ResolvedAlertTicketing =
  | { active: true; config: ConnectwiseAlertTicketingStored; rev: number }
  | {
    active: false;
    reason: AlertTicketingInactiveReason;
    /** The parsed stored config, when there is one, for the card preview. */
    config: ConnectwiseAlertTicketingStored | null;
    rev: number;
  };

/**
 * Fingerprint of the PSA *instance* a connection points at: provider + base-URL
 * host + company id. Company links key on provider only
 * (`psa/companyImport.ts`), so a connection re-pointed at a different instance
 * keeps links that may name the wrong companies; enabling records this key and
 * the resolver goes inactive (`company_links_unverified`) until an admin
 * re-confirms after it changes.
 *
 * Hashed because `psa_connections` is readable by org sessions through its
 * partner-wide SELECT branch: the stored value must not reveal the MSP's PSA
 * host or login company.
 */
export function psaInstanceKey(provider: string, credentials: Record<string, unknown> | null | undefined): string | null {
  if (!credentials) return null;
  const baseUrl = credentials.baseUrl;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return null;
  let host: string;
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;
  const companyId = typeof credentials.companyId === 'string' ? credentials.companyId.trim().toLowerCase() : '';
  const digest = createHash('sha256').update(`${provider}\n${host}\n${companyId}`).digest('hex');
  return `sha256:${digest}`;
}

export function resolveAlertTicketingConfig(
  connection: AlertTicketingConnectionRow,
  partner: AlertTicketingPartnerBinding,
  instanceKey: string | null,
): ResolvedAlertTicketing {
  const rev = connection.alertTicketingRev;
  const provider = psaProviderIdSchema.safeParse(connection.provider);
  const storedSchema = provider.success ? alertTicketingStoredSchemaFor(provider.data) : null;

  let config: ConnectwiseAlertTicketingStored | null = null;
  let configInvalid = false;
  if (storedSchema && connection.alertTicketing !== null && connection.alertTicketing !== undefined) {
    const parsed = storedSchema.safeParse(connection.alertTicketing);
    if (parsed.success) config = parsed.data;
    else configInvalid = true;
  }

  const inactive = (reason: AlertTicketingInactiveReason): ResolvedAlertTicketing =>
    ({ active: false, reason, config, rev });

  if (!storedSchema) return inactive('unsupported_provider');
  if (partner.serviceManagementMode !== 'external') return inactive('not_external');
  // Only a partner-owned connection can be bound (partners/me PATCH enforces it);
  // re-check here so an org-owned row can never auto-ticket.
  if (connection.partnerId === null || partner.serviceManagementPsaConnectionId !== connection.id) {
    return inactive('not_bound');
  }
  if (configInvalid) return inactive('invalid_config');
  if (!config || !config.enabled) return inactive('disabled');
  if (connection.alertTicketingPausedReason !== null) return inactive('paused');
  if (instanceKey === null || config.companyLinksConfirmedFor !== instanceKey) {
    return inactive('company_links_unverified');
  }
  return { active: true, config, rev };
}
