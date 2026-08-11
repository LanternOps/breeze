// Declared-project derivation from a file's rel_path (content phase).
// The declared location is what the folder structure CLAIMS about a file; the
// enrichment pass stores it next to the LLM-inferred project so disagreement
// (a misfile) can be shown, never silently corrected.
export interface DeclaredProject {
  key: string;
  label: string | null;
}

// A project folder is the first path segment under Projects/ or Short Term/
// whose name starts with a job-number key ("2023-041 Henderson Water Main…").
// Email folders declare by bare key: Emails/2023-041/…  Anything else —
// Unfiled, loose root files, Legacy — declares nothing (returns null).
const PROJECT_ROOTS = new Set(['Projects', 'Short Term']);
const KEY_FOLDER_RE = /^(\d{4}-\d{3})(?:\s+(.+))?$/;
const EMAIL_KEY_RE = /^\d{4}-\d{3}$/;

export function deriveDeclaredProject(relPath: string): DeclaredProject | null {
  const segments = relPath.split('/').filter((s) => s.length > 0);
  // A declared project needs root/<project folder>/<file…> — a file sitting
  // directly under a root (or at the share root) is unclaimed by design.
  if (segments.length < 3) return null;
  const [root, folder] = segments;
  if (root === 'Emails') {
    return EMAIL_KEY_RE.test(folder) ? { key: folder, label: null } : null;
  }
  if (!PROJECT_ROOTS.has(root)) return null;
  const m = folder.match(KEY_FOLDER_RE);
  if (!m) return null;
  return { key: m[1], label: m[2]?.trim() || null };
}
