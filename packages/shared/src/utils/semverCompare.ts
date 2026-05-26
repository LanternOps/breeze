/**
 * Compare two semver-ish version strings of the form MAJOR.MINOR.PATCH[-suffix].
 * The prerelease suffix is intentionally ignored so dev/local builds (e.g. "0.65.10-dev")
 * compare equal to their release counterparts.
 *
 * @returns negative if a < b, 0 if equal, positive if a > b, null if either is unparseable.
 */
export function semverCompare(a: string, b: string): number | null {
  const parsed = (v: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/.exec(v);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parsed(a);
  const pb = parsed(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}
