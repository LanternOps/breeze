/**
 * Tool Catalog W04/W05 (#5219 / #5220) — the read ceiling on flow BODIES.
 *
 * Whether the caller may see run bodies (trigger payload, inputs, rendered
 * step inputs and outputs) and the sender-supplied identifiers a webhook
 * delivery row keeps (delivery id, resolver value). Runs and deliveries have
 * no site column, so a body cannot be checked against a site or device
 * ceiling: a site-limited caller (`hasSiteCeiling`, `[]` included) or a
 * device-bound agent (`allowedDeviceIds` set) sees the ledger's shape only —
 * summaries, statuses and errors — never a body.
 */
import { hasExactDeviceCeiling, hasSiteCeiling, type SiteCeilingAuth } from '../siteCeilingAccess';

export function runBodiesRestricted(auth: SiteCeilingAuth): boolean {
  return hasSiteCeiling(auth) || hasExactDeviceCeiling(auth);
}
