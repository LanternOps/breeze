import type { networkMonitors } from '../../db/schema/monitors';

type Identity = Pick<typeof networkMonitors.$inferSelect, 'monitorType' | 'target' | 'config'>;

/** Compare the endpoint the legacy command actually executes, allowing equivalent adoption. */
function networkIdentity(row: Identity): string {
  const config = (row.config ?? {}) as Record<string, unknown>;
  // HTTP/DNS command defaults use the column, even when config.target is set.
  const target = row.monitorType === 'http_check' ? config.url || row.target
    : row.monitorType === 'dns_check' ? config.hostname || row.target
      : config.target ?? row.target;
  return JSON.stringify([row.monitorType, target, config.host ?? null, config.port ?? null]);
}

/** A rename or schedule edit preserves evidence; an endpoint change clears it. */
export function networkIdentityTlsReset(before: Identity, after: Identity) {
  return networkIdentity(before) === networkIdentity(after) ? {} : {
    tlsState: null, tlsNotAfter: null, tlsIssuer: null, tlsObservedHost: null, tlsObservedAt: null,
  };
}
