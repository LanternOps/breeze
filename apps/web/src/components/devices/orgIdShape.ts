// The org id shape the devices-list hash accepts (#3205 W06). Dependency-free
// on purpose: deviceCoverageLinks.ts (rendered inside ContractDetail/Editor)
// must not drag orgStore/auth into every contract component's module graph.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is the only org id shape `#orgId=` reads or writes. */
export function isOrgIdForHash(value: string): boolean {
  return UUID_RE.test(value);
}
