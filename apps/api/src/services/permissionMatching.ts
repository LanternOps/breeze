// Canonical grant-matching semantics, shared by every permission check in
// the platform: a permission row matches a required resource/action when it
// names it exactly OR carries the '*' wildcard on that axis.
//
// This lives in its own dependency-free module (no db/schema imports) so that
// enforcement paths like services/siteScope.ts can share it without pulling in
// the full permission-resolver module graph. A literal-equality divergence in
// the report-authority path locked wildcard-only super-roles (e.g. the seeded
// Partner Admin's single `*|*` grant) out of all report actions (#2874) —
// never re-implement this comparison with plain equality.
export function permissionGrantMatches(
  grant: { resource: string; action: string },
  resource: string,
  action: string,
): boolean {
  return (
    (grant.resource === resource || grant.resource === '*') &&
    (grant.action === action || grant.action === '*')
  );
}
