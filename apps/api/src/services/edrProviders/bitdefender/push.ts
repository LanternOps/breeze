import { createHash, timingSafeEqual } from 'node:crypto';
import type { EdrWebhookHint, EdrWebhookVerdict, RawWebhookRequest } from '../types';

/**
 * GravityZone push-event verification (EDR W03 PR-B, spec §4.8). PURE: no I/O.
 *
 * A push is a HINT, never data. The only things that leave this function are
 * vendor tenant ids and (for `new-incident`) a vendor incident id, each a short
 * opaque token. Nothing else from the body (names, IPs, paths, malware names)
 * is copied, so a forged-but-authenticated push can at worst cause one extra
 * read sync.
 *
 * Authentication is the shared secret Breeze generated and registered as the
 * push service's `authorization` value; GravityZone echoes it verbatim in the
 * `Authorization` header. `Event-Push-Service-Md5` is IGNORED: it is an
 * unkeyed body digest anyone can compute.
 */

export const GZ_MAX_HINTS = 100;

/** Vendor ids become Redis set members (`t:<tenant>` / `d:<tenant>:<det>`), so no separators. */
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

function headerValue(headers: RawWebhookRequest['headers'], name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

/**
 * Constant-time over equal-length SHA-256 digests of both strings, so neither
 * a length mismatch nor a shared prefix changes the comparison work.
 */
function secretMatches(presented: string | undefined, secret: string): boolean {
  if (!secret) return false;
  const ok = timingSafeEqual(sha256(presented ?? ''), sha256(secret));
  return ok && typeof presented === 'string' && presented.length > 0;
}

const asId = (v: unknown): string | null => (typeof v === 'string' && ID_RE.test(v) ? v : null);

function extractHints(body: string): EdrWebhookHint[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const env = parsed as { method?: unknown; params?: { events?: unknown } | null };
  if (env.method !== 'addEvents' || !env.params || !Array.isArray(env.params.events)) return [];

  const out: EdrWebhookHint[] = [];
  const seen = new Set<string>();
  for (const ev of env.params.events) {
    if (out.length >= GZ_MAX_HINTS) break;
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;
    const e = ev as Record<string, unknown>;
    const tenant = asId(e.companyId);
    if (!tenant) continue;
    // [U] `incidentId` is the documented-looking name; confirmed only by the lab run.
    const det = e.module === 'new-incident' ? asId(e.incidentId) : null;
    const key = det ? `d:${tenant}:${det}` : `t:${tenant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(det ? { vendorTenantId: tenant, vendorDetectionId: det } : { vendorTenantId: tenant });
  }
  return out;
}

export function verifyGravityZoneWebhook(req: RawWebhookRequest, secret: string): EdrWebhookVerdict {
  if (!secretMatches(headerValue(req.headers, 'authorization'), secret)) {
    return { ok: false, error: 'unauthorized' };
  }
  // Authenticated but unparseable: still "something happened" -> one connection-wide poll.
  return { ok: true, hints: extractHints(req.body) };
}
