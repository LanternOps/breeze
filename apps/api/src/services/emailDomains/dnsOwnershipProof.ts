/**
 * DNS-TXT ownership proof for adopting a pre-existing sending-domain object
 * at the provider (spec: sending-domains adoption gate, see domainSync.ts's
 * `provision()`).
 *
 * A partner proves control of a domain by publishing the token this module
 * issued for their row as a TXT record at `_breeze-verify.<domain>`. This is
 * the self-service path; `EMAIL_DOMAINS_ADOPT_EXISTING_ALLOWLIST` remains the
 * operator override for domains where DNS cannot be arranged (spec: the
 * DNS-TXT proof is the primary path, the allowlist is belt-and-suspenders).
 */
import { randomBytes } from 'node:crypto';
import { promises as dns } from 'node:dns';

export interface DnsTxtResolver {
  /** Resolves a hostname's TXT records. Each record is an array of chunks —
   *  the shape Node's `dns.resolveTxt` returns for a single (possibly
   *  multi-string) TXT record. */
  resolveTxt(hostname: string): Promise<string[][]>;
}

const nodeDnsResolver: DnsTxtResolver = {
  resolveTxt: (hostname: string) => dns.resolveTxt(hostname),
};

let resolverOverride: DnsTxtResolver | null = null;

/** Test-only seam. Never called in production code. */
export function setDnsTxtResolverForTest(resolver: DnsTxtResolver | null): void {
  resolverOverride = resolver;
}

function getResolver(): DnsTxtResolver {
  return resolverOverride ?? nodeDnsResolver;
}

/** The well-known TXT host a partner must publish their token at. */
export function ownershipTxtRecordName(domain: string): string {
  return `_breeze-verify.${domain}`;
}

/** A random, unguessable per-(partner,domain) proof token. Hex so it drops
 *  cleanly into a TXT record with no quoting/escaping concerns. */
export function generateOwnershipToken(): string {
  return randomBytes(24).toString('hex');
}

/**
 * True iff a TXT record at `_breeze-verify.<domain>` equals `token` exactly.
 * Never throws: NXDOMAIN, no records, a resolver timeout, or any other DNS
 * failure all mean "proof not present", not an error to propagate — the
 * caller's fallback (the operator allowlist) still applies.
 */
export async function verifyDnsOwnershipToken(domain: string, token: string): Promise<boolean> {
  if (!token) return false;
  try {
    const records = await getResolver().resolveTxt(ownershipTxtRecordName(domain));
    return records.some((chunks) => chunks.join('') === token);
  } catch {
    return false;
  }
}
