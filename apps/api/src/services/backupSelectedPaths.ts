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

function segmentKey(value: string): string {
  return normalizeSnapshotPath(value).split('/').filter(Boolean).join('/');
}

export type SelectedSnapshotPathsResolution =
  | { ok: true; paths: string[] }
  | { ok: false; invalidPath: string; reason: 'not_found' | 'ambiguous' }
  | { ok: false; invalidPath: string; reason: 'too_many'; count: number; limit: number };

/** Most files a single selective restore may name once directories are expanded. */
export const MAX_SELECTED_RESTORE_FILES = 10_000;

/**
 * Resolve requested selections to the stored original paths of files in the
 * snapshot. A selection matches a stored path exactly, or failing that, by its
 * normalized form when exactly one stored path shares it. Failing both, it is
 * treated as a directory and expands to every stored file whose normalized
 * path is `<dir>/…` (exact-or-child rule: `pick.txt` never selects
 * `pick.txtx/…`). Selections that match nothing, or whose normalized form is
 * shared by several stored paths (possible on POSIX, where `\` is a legal
 * filename character), are refused, as is a result above
 * MAX_SELECTED_RESTORE_FILES.
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
  const add = (original: string) => {
    if (!seen.has(original)) {
      seen.add(original);
      resolved.push(original);
    }
  };

  // Segment keys are computed once, lazily, the first time they are needed.
  let segmentKeys: { seg: string; originals: string[] }[] | undefined;
  let dirKeys: Set<string> | undefined;
  const ensureSegments = () => {
    if (segmentKeys) return segmentKeys;
    segmentKeys = Array.from(byNormalized, ([key, originals]) => ({ seg: segmentKey(key), originals }));
    dirKeys = new Set();
    for (const { seg } of segmentKeys) {
      for (let i = seg.indexOf('/'); i !== -1; i = seg.indexOf('/', i + 1)) dirKeys.add(seg.slice(0, i));
    }
    return segmentKeys;
  };
  // Directory expansion. Compared segment-wise — the same segmentation the
  // browse tree uses (backslashes → `/`, repeated and leading/trailing
  // separators dropped), because the tree hands directories back as
  // `/C:/Users/x` or `/fileserver/share/x`. The match requires a segment
  // boundary, so a sibling sharing a name prefix can never match. Returns
  // whether anything lay beneath the directory.
  const expandDirectory = (selected: string): boolean => {
    const dir = segmentKey(selected);
    if (dir === '') return false;
    const prefix = `${dir}/`;
    let matched = false;
    for (const { seg, originals } of ensureSegments()) {
      if (!seg.startsWith(prefix)) continue;
      matched = true;
      for (const original of originals) add(original);
      // Stop scanning as soon as the cap is blown; the check below reports it.
      if (resolved.length > MAX_SELECTED_RESTORE_FILES) break;
    }
    return matched;
  };

  for (const selected of new Set(selectedPaths)) {
    let fileMatch: string | undefined;
    if (exact.has(selected)) {
      fileMatch = selected;
    } else {
      const candidates = byNormalized.get(normalizeSnapshotPath(selected));
      if (candidates) {
        if (candidates.length > 1) return { ok: false, invalidPath: selected, reason: 'ambiguous' };
        fileMatch = candidates[0]!;
      }
    }
    if (fileMatch !== undefined) {
      add(fileMatch);
      // A file and a folder can share a name (`b` and `b/…`): the folder's
      // contents are part of the selection too, never silently dropped.
      ensureSegments();
      if (dirKeys!.has(segmentKey(selected))) expandDirectory(selected);
    } else if (!expandDirectory(selected)) {
      return { ok: false, invalidPath: selected, reason: 'not_found' };
    }
    if (resolved.length > MAX_SELECTED_RESTORE_FILES) {
      return {
        ok: false,
        invalidPath: selected,
        reason: 'too_many',
        count: resolved.length,
        limit: MAX_SELECTED_RESTORE_FILES,
      };
    }
  }

  return { ok: true, paths: resolved };
}

/** User-facing error for a refused selection, shared by the route and AI tool. */
export function selectedSnapshotPathError(
  failure: Extract<SelectedSnapshotPathsResolution, { ok: false }>
): string {
  if (failure.reason === 'too_many') {
    return `Selection reached ${failure.count} files while expanding ${failure.invalidPath}, more than the ${failure.limit}-file limit per restore; select fewer or smaller folders`;
  }
  return failure.reason === 'ambiguous'
    ? `Selected path matches more than one file in this snapshot: ${failure.invalidPath}`
    : `Selected path is not available in this snapshot: ${failure.invalidPath}`;
}
