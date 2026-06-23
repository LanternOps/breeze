function segments(v: string): number[] {
  return v.split('.').map((s) => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  });
}

export function compareBuilds(a: string, b: string): -1 | 0 | 1 {
  const sa = segments(a);
  const sb = segments(b);
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const x = sa[i] ?? 0;
    const y = sb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export function isVulnerable(installed: string, fixedBuild: string): boolean {
  return compareBuilds(installed, fixedBuild) < 0;
}

export interface VersionRange {
  startIncluding?: string | null;
  startExcluding?: string | null;
  endIncluding?: string | null;
  endExcluding?: string | null;
}

export function isVersionInRange(version: string, range: VersionRange): boolean {
  if (range.startIncluding && compareBuilds(version, range.startIncluding) < 0) return false;
  if (range.startExcluding && compareBuilds(version, range.startExcluding) <= 0) return false;
  if (range.endIncluding && compareBuilds(version, range.endIncluding) > 0) return false;
  if (range.endExcluding && compareBuilds(version, range.endExcluding) >= 0) return false;
  return true;
}
