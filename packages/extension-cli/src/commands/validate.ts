/**
 * `breeze-ext validate` — an AUTHOR-SIDE PRE-PACK CHECK that reports whether an
 * extension source directory would pack cleanly: the manifest parses and
 * conforms to the v1 schema, the source layout is safe (no symlinks, no
 * reserved generated members carried in from source), and every entry the
 * manifest points at (`server.entry`, and `web.entry` when web is declared)
 * actually exists in the tree.
 *
 * It reuses the exact machinery `pack` uses — `collectPayload` for the layout
 * and security gate, `safeParseExtensionManifestV1` for structured manifest
 * diagnostics — so "validate passes" implies "pack will not reject the manifest
 * or layout". It is NOT the host's trust decision:
 * `apps/api/src/extensions/bundleVerifier.ts` (`verifyExtensionBundle`) is the
 * only place that enforces publisher trust, digest pinning, and archive-safety
 * limits before code is allowed to load. `validate` never imports or duplicates
 * that trust logic.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeParseExtensionManifestV1 } from '@breeze/extension-sdk';
import { collectPayload } from '../artifact/collectPayload';

export interface ValidateOptions {
  /** Path to the extension source directory (contains the manifest). */
  path: string;
  /** Emit machine-readable JSON instead of human-readable text. */
  json?: boolean;
}

/**
 * A single validation problem.
 *
 * `code` is a stable, machine-readable identifier so callers (CI, other
 * tooling) can match on it without parsing the human `message`:
 * - `manifest_missing`      — no `manifest.json` in the source tree.
 * - `manifest_invalid_json` — `manifest.json` is present but not valid JSON.
 * - `manifest_schema`       — `manifest.json` parsed but failed the v1 schema;
 *                             `path` is the dotted field path of the issue.
 * - `entry_missing`         — a manifest-declared entry file is not in the tree;
 *                             `path` is the declared relative entry path.
 * - `layout`                — a source-layout / safety violation surfaced by
 *                             `collectPayload` (a symlink, or a reserved
 *                             generated member carried in from source).
 */
export interface ValidateFinding {
  code: 'manifest_missing' | 'manifest_invalid_json' | 'manifest_schema' | 'entry_missing' | 'layout';
  /** Manifest field path (for `manifest_schema`) or member path (for `entry_missing`); omitted otherwise. */
  path?: string;
  message: string;
}

export interface ValidateResult {
  /** `true` iff the source tree would pack cleanly — drives the exit code. */
  ok: boolean;
  /** Manifest identity, present only once the manifest has parsed and conformed. */
  manifest?: { name: string; version: string; apiVersion: string };
  findings: ValidateFinding[];
}

/**
 * Validate an extension source directory. Returns a structured result rather
 * than throwing, so `runValidate` can print a full report (JSON or human) and
 * set an exit code without a stack trace escaping.
 *
 * Order is load-bearing and short-circuits: manifest presence → JSON validity →
 * schema conformance. Each stage needs the previous one's output, so a failure
 * returns immediately rather than cascading into misleading downstream findings
 * (e.g. an `entry_missing` computed from a field the schema already rejected).
 * Only once the manifest is known-good does it run the layout/security gate and
 * the entry-existence checks.
 */
export async function validateExtension(options: ValidateOptions): Promise<ValidateResult> {
  const manifestPath = join(options.path, 'manifest.json');

  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(manifestPath);
  } catch (error) {
    // Only a genuinely absent file is "manifest_missing". A permission/IO error
    // (EACCES, EISDIR, …) is a real failure the author needs to see, not a
    // conformance finding — surface it rather than mislabeling it as missing.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ok: false,
        findings: [{
          code: 'manifest_missing',
          message: 'source tree is missing required "manifest.json"',
        }],
      };
    }
    throw error;
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    return {
      ok: false,
      findings: [{ code: 'manifest_invalid_json', message: 'manifest.json is not valid JSON' }],
    };
  }

  // safeParse (not the throwing parse) so EVERY schema issue is enumerated with
  // its structured path/message, rather than a single prettified string.
  const parsed = safeParseExtensionManifestV1(manifestRaw);
  if (!parsed.success) {
    return {
      ok: false,
      findings: parsed.error.issues.map((issue) => ({
        code: 'manifest_schema',
        path: issue.path.join('.') || undefined,
        message: issue.message,
      })),
    };
  }
  const manifest = parsed.data;
  const identity = { name: manifest.name, version: manifest.version, apiVersion: manifest.apiVersion };

  // Layout + security gate — identical to what `pack` runs. Since the manifest
  // already passed the schema above, collectPayload's own re-parse cannot fail
  // here; its remaining job is to refuse symlinks and reserved source members.
  let members;
  try {
    members = await collectPayload(options.path);
  } catch (error) {
    return {
      ok: false,
      manifest: identity,
      findings: [{ code: 'layout', message: error instanceof Error ? error.message : String(error) }],
    };
  }

  // Entry-path existence: the manifest may reference files that were never
  // shipped in the source tree. pack does not check this, so validate is the
  // place that catches a bundle that would load-fail at the host.
  const memberPaths = new Set(members.map((member) => member.path));
  const findings: ValidateFinding[] = [];
  if (!memberPaths.has(manifest.server.entry)) {
    findings.push({
      code: 'entry_missing',
      path: manifest.server.entry,
      message: `server.entry "${manifest.server.entry}" is not present in the source tree`,
    });
  }
  if (manifest.web && !memberPaths.has(manifest.web.entry)) {
    findings.push({
      code: 'entry_missing',
      path: manifest.web.entry,
      message: `web.entry "${manifest.web.entry}" is not present in the source tree`,
    });
  }

  return { ok: findings.length === 0, manifest: identity, findings };
}

/**
 * Human-readable report. Contains only source-relative paths and result data —
 * never `options.path` (an absolute checkout path) or environment data.
 */
function formatHuman(result: ValidateResult): string {
  const lines: string[] = [];
  if (result.manifest) {
    lines.push(`name: ${result.manifest.name}`);
    lines.push(`version: ${result.manifest.version}`);
    lines.push(`apiVersion: ${result.manifest.apiVersion}`);
  }
  if (result.ok) {
    lines.push('valid: ok');
  } else {
    lines.push(`valid: ${result.findings.length} problem(s) found`);
    for (const finding of result.findings) {
      const where = finding.path ? ` [${finding.path}]` : '';
      lines.push(`  - ${finding.code}${where}: ${finding.message}`);
    }
  }
  return lines.join('\n');
}

/**
 * Run `validate` and print its report. Exit code is nonzero on any validation
 * failure and zero on a clean source tree — set via `process.exitCode` (not
 * `throw`) so the report itself is still printed before the process exits.
 */
export async function runValidate(options: ValidateOptions): Promise<void> {
  const result = await validateExtension(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatHuman(result));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}
