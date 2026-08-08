/**
 * Client-side script bundle helpers (#3245).
 *
 * The API takes exactly one intake format: a versioned JSON bundle. Loose
 * script files (.ps1/.sh/.py/.bat) are converted to a bundle HERE, in the
 * browser — inferring `language` and `osTypes` from the extension and `name`
 * from the filename — so the server never grows a second intake path (same
 * split as the CSV handling in #3242).
 */

export type BundleOsType = 'windows' | 'macos' | 'linux';
export type BundleLanguage = 'powershell' | 'bash' | 'python' | 'cmd';

export type ScriptBundleEntry = {
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  osTypes: BundleOsType[];
  language: BundleLanguage;
  content: string;
  parameters?: unknown;
  timeoutSeconds?: number;
  runAs?: 'system' | 'user' | 'elevated';
  exitCodeSeverityMapping?: Record<string, string | null> | null;
};

export type ScriptBundle = {
  bundleVersion: 1;
  exportedAt?: string;
  scripts: ScriptBundleEntry[];
};

const EXTENSION_MAP: Record<string, { language: BundleLanguage; osTypes: BundleOsType[] }> = {
  ps1: { language: 'powershell', osTypes: ['windows'] },
  bat: { language: 'cmd', osTypes: ['windows'] },
  cmd: { language: 'cmd', osTypes: ['windows'] },
  sh: { language: 'bash', osTypes: ['linux', 'macos'] },
  py: { language: 'python', osTypes: ['windows', 'macos', 'linux'] }
};

export const LOOSE_SCRIPT_EXTENSIONS = Object.keys(EXTENSION_MAP);

function splitExtension(fileName: string): { base: string; ext: string } {
  // Folder pickers hand over relative paths — keep only the basename.
  const baseName = fileName.split('/').pop() ?? fileName;
  const dot = baseName.lastIndexOf('.');
  if (dot <= 0) return { base: baseName, ext: '' };
  return { base: baseName.slice(0, dot), ext: baseName.slice(dot + 1).toLowerCase() };
}

/** Convert one loose script file into a bundle entry, or null if unsupported. */
export function looseFileToEntry(fileName: string, content: string): ScriptBundleEntry | null {
  const { base, ext } = splitExtension(fileName);
  const mapping = EXTENSION_MAP[ext];
  if (!mapping || !base || content.length === 0) return null;
  return {
    name: base,
    osTypes: mapping.osTypes,
    language: mapping.language,
    content
  };
}

export type FilesToBundleResult = {
  bundle: ScriptBundle | null;
  /** Names of files that could not be converted or parsed. */
  errors: string[];
};

type ReadableFile = { name: string; text: () => Promise<string> };

/**
 * Turn a user file selection into a bundle:
 * - exactly one file, and it's `.json` → parsed as an existing bundle
 *   (shape-checked lightly; the server schema is authoritative);
 * - otherwise, supported loose script files are converted and everything
 *   else — including stray `.json` files inside a picked folder, which the
 *   folder picker cannot exclude — is reported in `errors` and skipped.
 *
 * `errors` contains only file names (rendered after a localized label);
 * this module never emits user-facing prose.
 */
export async function filesToBundle(files: ReadableFile[]): Promise<FilesToBundleResult> {
  const errors: string[] = [];
  if (files.length === 0) return { bundle: null, errors: [] };

  if (files.length === 1 && files[0]!.name.toLowerCase().endsWith('.json')) {
    const file = files[0]!;
    try {
      const parsed = JSON.parse(await file.text()) as Partial<ScriptBundle>;
      if (typeof parsed?.bundleVersion !== 'number' || !Array.isArray(parsed?.scripts)) {
        return { bundle: null, errors: [file.name] };
      }
      return { bundle: parsed as ScriptBundle, errors: [] };
    } catch {
      return { bundle: null, errors: [file.name] };
    }
  }

  const entries: ScriptBundleEntry[] = [];
  for (const file of files) {
    try {
      const entry = file.name.toLowerCase().endsWith('.json')
        ? null
        : looseFileToEntry(file.name, await file.text());
      if (entry) entries.push(entry);
      else errors.push(file.name);
    } catch {
      errors.push(file.name);
    }
  }

  if (entries.length === 0) return { bundle: null, errors };
  return { bundle: { bundleVersion: 1, scripts: entries }, errors };
}

/** Trigger a browser download of a bundle as a .json file. */
export function downloadBundle(bundle: ScriptBundle, fileName?: string) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName ?? `script-bundle-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
