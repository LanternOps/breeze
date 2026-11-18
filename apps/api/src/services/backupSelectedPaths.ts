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

import type { SnapshotEntryKind } from './backupSnapshotEntryKind';

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

/**
 * Most paths a single selective restore may name, and most files a folder that
 * cannot be named by one prefix may expand to.
 */
export const MAX_SELECTED_RESTORE_FILES = 10_000;

/**
 * Bound on the member paths kept, across all selected folders, while it is not
 * yet known whether each can be named by one prefix. Real selections are far
 * below it; only deeply nested selections of one another reach it, and they
 * then end as too_many rather than holding the whole index.
 */
const MAX_RETAINED_MEMBERS = 1_000_000;

const isSeparator = (ch: string) => ch === '/' || ch === '\\';

/**
 * Mirror of the agent's pathSelectionMatches (agent/internal/backup/restore.go):
 * a stored path is selected by `selected` when it is that path, or lies beneath
 * it after either separator. Pinned to the Go source by
 * backupSelectedPaths.agentParity.test.ts.
 */
export function pathSelectionMatches(sourcePath: string, selected: string): boolean {
  let end = selected.length;
  while (end > 0 && isSeparator(selected[end - 1]!)) end -= 1;
  const trimmed = selected.slice(0, end);
  if (sourcePath === trimmed) return true;
  return sourcePath.startsWith(`${trimmed}/`) || sourcePath.startsWith(`${trimmed}\\`);
}

/** `stored` up to the end of its `count`th segment, in its own separators. */
function cutAfterSegments(stored: string, count: number): string {
  let i = 0;
  let seen = 0;
  while (i < stored.length && isSeparator(stored[i]!)) i += 1;
  while (i < stored.length) {
    while (i < stored.length && !isSeparator(stored[i]!)) i += 1;
    seen += 1;
    if (seen === count) return stored.slice(0, i);
    while (i < stored.length && isSeparator(stored[i]!)) i += 1;
  }
  return stored;
}

/** One selected folder, as the stored paths beneath it are seen. */
type FolderState = {
  segments: number;
  /** Stored paths beneath it, at any depth. */
  count: number;
  /** The stored-form prefix cut from the first member. */
  prefix: string | null;
  /** A member the prefix does not select under the agent's rule. */
  mixed: boolean;
  /** Members kept for the expansion fallback; null once past what may be kept. */
  members: string[] | null;
  /**
   * Stored paths AT the folder (its segments, any spelling: a file `b` beside a
   * folder `b/`) that are not the folder's own entry. The agent's rule selects
   * one equal to the prefix, so the prefix may only stand in for the folder
   * when the selection also chose it. Null past a few: then the folder is
   * expanded instead.
   */
  selfPaths: string[] | null;
  /**
   * The folder's own directory entries (#11235: kind 'dir', any spelling):
   * part of the folder, so selected with it, and the whole of an empty one.
   * Null past a few spellings: then the selection is ambiguous.
   */
  dirSelfPaths: string[] | null;
};

const MAX_SELF_PATHS = 16;

/**
 * Resolves selective-restore selections against a snapshot's stored paths fed
 * one at a time, holding the selections rather than the paths (#11026), so a
 * snapshot of any size can be walked in pages.
 *
 * A selection matches a stored path exactly, or failing that, by its normalized
 * form when exactly one stored path shares it (several is `ambiguous`: possible
 * on POSIX, where `\` is a legal filename character). It is also a folder when
 * stored paths lie beneath it, compared segment-wise, the way the browse tree
 * hands folders back (`/C:/Users/x`, `/fileserver/share/x`), so a sibling
 * sharing a name prefix (`pick.txt`, `pick.txtx/…`) never matches. A folder
 * resolves to its stored-form prefix, which the agent expands itself: no file
 * limit. When one prefix cannot name every member under the agent's rule (its
 * files are stored with mixed separators), the folder falls back to listing
 * its files, up to MAX_SELECTED_RESTORE_FILES. A selection that is neither is
 * `not_found`.
 *
 * A stored directory entry (kind 'dir', #11235) at a selected folder's
 * segments is the folder itself: it is selected with the folder (the prefix
 * already names it, or it is added in its own spelling), never counts as a
 * file beside it, and is the whole selection for an empty folder, which has
 * nothing beneath it to resolve a prefix from. A row of unknown kind (written
 * before kinds were recorded) is treated as a file, as it always was.
 *
 * Every returned path is a stored path, or a prefix that selects, under the
 * agent's rule, only stored paths beneath the folder selected, so the result
 * never widens a restore beyond what the snapshot indexed.
 */
export function createSelectionResolver(selected: readonly string[]): {
  add(storedPath: string, kind?: SnapshotEntryKind | null): void;
  finish(): SelectedSnapshotPathsResolution;
} {
  const selections = [...new Set(selected)];
  const exactHits = new Set<string>();
  const byNormalized = new Map<string, Set<string>>();
  const folders = new Map<string, FolderState>();
  for (const selection of selections) {
    byNormalized.set(normalizeSnapshotPath(selection), new Set());
    const key = segmentKey(selection);
    if (key !== '' && !folders.has(key)) {
      folders.set(key, {
        segments: key.split('/').length, count: 0, prefix: null, mixed: false, members: [], selfPaths: [], dirSelfPaths: [],
      });
    }
  }
  const wanted = new Set(selections);
  let retained = 0;
  let previous: string | null = null;

  const observe = (folder: FolderState, stored: string) => {
    folder.count += 1;
    if (folder.prefix === null) folder.prefix = cutAfterSegments(stored, folder.segments);
    else if (!folder.mixed && !pathSelectionMatches(stored, folder.prefix)) folder.mixed = true;
    if (folder.members === null) return;
    if (folder.members.length >= MAX_SELECTED_RESTORE_FILES || retained >= MAX_RETAINED_MEMBERS) {
      // More than an expansion may list: if this folder turns out mixed, it is
      // too_many whatever else is kept.
      retained -= folder.members.length;
      folder.members = null;
      return;
    }
    folder.members.push(stored);
    retained += 1;
  };

  return {
    add(stored, kind) {
      // A keyset walk over duplicate rows yields them next to each other.
      if (stored === previous) return;
      previous = stored;
      if (wanted.has(stored)) exactHits.add(stored);
      const normalized = normalizeSnapshotPath(stored);
      const candidates = byNormalized.get(normalized);
      if (candidates && candidates.size < 2) candidates.add(stored);
      if (folders.size === 0) return;
      const seg = segmentKey(normalized);
      for (let i = seg.indexOf('/'); i !== -1; i = seg.indexOf('/', i + 1)) {
        const folder = folders.get(seg.slice(0, i));
        if (folder) observe(folder, stored);
      }
      const self = folders.get(seg);
      if (!self) return;
      if (kind === 'dir') {
        if (self.dirSelfPaths === null) return;
        if (self.dirSelfPaths.length < MAX_SELF_PATHS) self.dirSelfPaths.push(stored);
        else self.dirSelfPaths = null;
      } else if (self.selfPaths !== null) {
        if (self.selfPaths.length < MAX_SELF_PATHS) self.selfPaths.push(stored);
        else self.selfPaths = null;
      }
    },

    finish() {
      const resolved: string[] = [];
      const seen = new Set<string>();
      const prefixes = new Set<string>();
      const push = (path: string) => {
        if (seen.has(path)) return;
        seen.add(path);
        resolved.push(path);
      };
      const tooMany = (selection: string, count: number): SelectedSnapshotPathsResolution => ({
        ok: false,
        invalidPath: selection,
        reason: 'too_many',
        count,
        limit: MAX_SELECTED_RESTORE_FILES,
      });

      for (const selection of selections) {
        let fileMatch: string | undefined;
        if (exactHits.has(selection)) {
          fileMatch = selection;
        } else {
          const candidates = byNormalized.get(normalizeSnapshotPath(selection));
          if (candidates && candidates.size > 1) return { ok: false, invalidPath: selection, reason: 'ambiguous' };
          if (candidates && candidates.size === 1) fileMatch = [...candidates][0]!;
        }
        const key = segmentKey(selection);
        const folder = key === '' ? undefined : folders.get(key);
        const isFolder = folder !== undefined && folder.count > 0;
        if (folder?.dirSelfPaths === null) return { ok: false, invalidPath: selection, reason: 'ambiguous' };
        const ownEntries = folder?.dirSelfPaths ?? [];

        // A file and a folder can share a name (`b` and `b/…`): the folder's
        // contents are part of the selection too, never silently dropped.
        if (fileMatch !== undefined) push(fileMatch);
        if (isFolder) {
          // The prefix would also select a stored path at the folder itself
          // (`/docs` for a folder selected as `docs\`) that this selection did
          // not choose: list the folder's files instead. The folder's own
          // directory entry is not such a path: it is the folder.
          const prefixWidens = folder.selfPaths === null
            || folder.selfPaths.some((self) => self !== fileMatch && pathSelectionMatches(self, folder.prefix!));
          if (!folder.mixed && !prefixWidens) {
            push(folder.prefix!);
            prefixes.add(folder.prefix!);
            // The prefix already names the folder's own entry, unless that
            // entry is spelled otherwise than the member it was cut from.
            for (const own of ownEntries) if (!pathSelectionMatches(own, folder.prefix!)) push(own);
          } else if (folder.members === null) {
            return tooMany(selection, resolved.length + ownEntries.length + folder.count);
          } else {
            for (const own of ownEntries) push(own);
            for (const member of folder.members) push(member);
          }
        } else if (ownEntries.length > 0) {
          // An empty folder: its own entry is all there is to restore.
          for (const own of ownEntries) push(own);
        } else if (fileMatch === undefined) {
          return { ok: false, invalidPath: selection, reason: 'not_found' };
        }
        if (resolved.length > MAX_SELECTED_RESTORE_FILES) return tooMany(selection, resolved.length);
      }

      // A file inside a folder that is also selected adds nothing: the
      // folder's prefix already selects it.
      if (prefixes.size === 0) return { ok: true, paths: resolved };
      const covered = (path: string) => {
        if (prefixes.has(path)) return false;
        for (let segments = 1; ; segments += 1) {
          const cut = cutAfterSegments(path, segments);
          if (cut === path) return false;
          if (prefixes.has(cut) && pathSelectionMatches(path, cut)) return true;
        }
      };
      return { ok: true, paths: resolved.filter((path) => !covered(path)) };
    },
  };
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
