/**
 * Directory chain keys (portal registration W8 #11385, plan D5).
 *
 * A chain is one incarnation of one directory as seen by one org. Any change
 * to a part starts a new chain, which resets every identity's observation:
 *  - Entra: `entra:<tenantId>:<connectionId>:<consentGeneration>:<orgId>` —
 *    re-consent bumps the generation (disconnect keeps the connection row).
 *  - Google: `google:<customerId>:<connectionId>:<binding>:<orgId>` — the
 *    binding is W5's `googleConnectionBinding` (admin + service account), the
 *    customer id the admin anchor's (D11).
 * The org id is the LAST part, so an org merge leaves the absorbed org's
 * chain naming the old org: D8d refuses to apply such a run.
 */
import type { DirectorySource } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PART_RE = /^[^:\s]+$/;

export type ParsedDirectoryChain =
  | { source: 'entra'; tenantId: string; connectionId: string; consentGeneration: number; orgId: string }
  | { source: 'google'; customerId: string; connectionId: string; binding: string; orgId: string };

function part(name: string, value: string): string {
  if (!PART_RE.test(value)) throw new Error(`directory chain: invalid ${name}`);
  return value;
}

export function entraChainKey(p: { tenantId: string; connectionId: string; consentGeneration: number; orgId: string }): string {
  if (!Number.isInteger(p.consentGeneration) || p.consentGeneration < 0) {
    throw new Error('directory chain: invalid consent generation');
  }
  return [
    'entra',
    part('tenant id', p.tenantId.toLowerCase()),
    part('connection id', p.connectionId),
    String(p.consentGeneration),
    part('org id', p.orgId),
  ].join(':');
}

export function googleChainKey(p: { customerId: string; connectionId: string; binding: string; orgId: string }): string {
  return [
    'google',
    part('customer id', p.customerId),
    part('connection id', p.connectionId),
    part('binding', p.binding),
    part('org id', p.orgId),
  ].join(':');
}

/** The parts of a chain key, or null for anything this module did not build. */
export function parseChainKey(key: string): ParsedDirectoryChain | null {
  const parts = key.split(':');
  if (parts.length !== 5 || parts.some((p) => !PART_RE.test(p))) return null;
  const [source, a, connectionId, c, orgId] = parts as [string, string, string, string, string];
  if (!UUID_RE.test(orgId)) return null;
  if (source === 'entra') {
    if (!/^\d+$/.test(c)) return null;
    return { source, tenantId: a, connectionId, consentGeneration: Number(c), orgId };
  }
  if (source === 'google') return { source, customerId: a, connectionId, binding: c, orgId };
  return null;
}

export function chainSource(key: string): DirectorySource | null {
  return parseChainKey(key)?.source ?? null;
}
