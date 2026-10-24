// Folder selection for selective restore (#9628). The API expands a selected
// directory to the indexed files beneath it; these helpers only decide how a
// folder checkbox looks and when to ask before a very large selection.

/** Ask for confirmation once a selection covers more than this many files. */
export const LARGE_FOLDER_SELECTION_THRESHOLD = 1000;

// Segment-wise key, matching how the browse tree and the API resolver compare
// paths: `\` and `/` are equivalent and empty segments are dropped, so the
// tree path `/C:/Users/x` lines up with the stored file path `C:\Users\x\a.txt`.
function segmentKey(value: string): string {
  return value.replaceAll('\\', '/').split('/').filter(Boolean).join('/');
}

function isStrictlyUnder(path: string, dir: string): boolean {
  const dirKey = segmentKey(dir);
  return dirKey !== '' && segmentKey(path).startsWith(`${dirKey}/`);
}

export type FolderCheckState = 'checked' | 'partial' | 'unchecked';

export function folderCheckState(dirPath: string, selected: ReadonlySet<string>): FolderCheckState {
  const dirKey = segmentKey(dirPath);
  let partial = false;
  for (const path of selected) {
    const key = segmentKey(path);
    // The folder itself, or a selected ancestor folder, covers everything here.
    if (key === dirKey || (key !== '' && dirKey.startsWith(`${key}/`))) return 'checked';
    if (isStrictlyUnder(path, dirPath)) partial = true;
  }
  return partial ? 'partial' : 'unchecked';
}

/**
 * Upper bound of files covered by the selected folders plus `addingCount`
 * (overlapping folders are counted twice — it only gates a confirmation).
 */
export function selectedFolderFileTotal(
  selected: ReadonlySet<string>,
  counts: ReadonlyMap<string, number>,
  addingCount: number
): number {
  let total = addingCount;
  for (const path of selected) total += counts.get(path) ?? 0;
  return total;
}
