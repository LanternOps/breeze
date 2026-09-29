/**
 * Selective-restore path handling shared by the snapshot browse tree, the
 * restore route and the AI restore tool.
 *
 * The agent indexes each backed-up file's original path in its native form,
 * so on Windows `backup_snapshot_files.source_path` holds `C:\Users\…` or
 * `\\server\share\…`. The browse tree shows every path with forward slashes
 * (`normalizeSnapshotPath`), and that is the form a restore request selects.
 * The agent, however, matches `selectedPaths` against its manifest's original
 * paths, so each selection has to be mapped back to its stored original
 * before it is persisted or dispatched.
 */

/**
 * Display/lookup form of a snapshot path: backslashes become forward slashes.
 * Deliberately nothing more — no dot-segment resolution, no separator
 * collapsing, no case folding — so a selection can only ever match a path the
 * agent actually indexed, never something that merely resolves to one.
 */
export function normalizeSnapshotPath(value: string): string {
  return value.replaceAll('\\', '/');
}

export type SelectedSnapshotPathsResolution =
  | { ok: true; paths: string[] }
  | { ok: false; invalidPath: string; reason: 'not_found' | 'ambiguous' };

/**
 * Resolve requested selections to the stored original paths of files in the
 * snapshot. A selection matches a stored path exactly, or failing that, by its
 * normalized form when exactly one stored path shares it. Selections that
 * match nothing, or whose normalized form is shared by several stored paths
 * (possible on POSIX, where `\` is a legal filename character), are refused.
 *
 * The returned paths are always members of `storedPaths`, so the result can
 * never widen a restore beyond files indexed for the snapshot.
 */
export function resolveSelectedSnapshotPaths(
  selectedPaths: readonly string[],
  storedPaths: Iterable<string>
): SelectedSnapshotPathsResolution {
  const exact = new Set<string>();
  const byNormalized = new Map<string, string[]>();
  for (const stored of storedPaths) {
    if (exact.has(stored)) continue;
    exact.add(stored);
    const key = normalizeSnapshotPath(stored);
    const originals = byNormalized.get(key);
    if (originals) originals.push(stored);
    else byNormalized.set(key, [stored]);
  }

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const selected of selectedPaths) {
    let original: string;
    if (exact.has(selected)) {
      original = selected;
    } else {
      const candidates = byNormalized.get(normalizeSnapshotPath(selected));
      if (!candidates) return { ok: false, invalidPath: selected, reason: 'not_found' };
      if (candidates.length > 1) return { ok: false, invalidPath: selected, reason: 'ambiguous' };
      original = candidates[0]!;
    }
    if (!seen.has(original)) {
      seen.add(original);
      resolved.push(original);
    }
  }

  return { ok: true, paths: resolved };
}

/** User-facing error for a refused selection, shared by the route and AI tool. */
export function selectedSnapshotPathError(
  failure: Extract<SelectedSnapshotPathsResolution, { ok: false }>
): string {
  return failure.reason === 'ambiguous'
    ? `Selected path matches more than one file in this snapshot: ${failure.invalidPath}`
    : `Selected path is not available in this snapshot: ${failure.invalidPath}`;
}
