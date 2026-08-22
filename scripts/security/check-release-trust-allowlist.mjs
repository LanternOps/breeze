#!/usr/bin/env node
/**
 * check-release-trust-allowlist.mjs — keep the release pipeline and the API's
 * trust allowlist from drifting apart.
 *
 * WHY THIS EXISTS (issue #3504)
 * -----------------------------
 * Two files independently encode the same policy — "which Windows agent-family
 * assets ship WITHOUT Authenticode":
 *
 *   1. `.github/workflows/release.yml` — `AGENT_FAMILY_WINDOWS_RE` in the
 *      manifest generator. Names matching it get `platformTrust: "none"`.
 *   2. `apps/api/src/services/releaseAssetTrust.ts` —
 *      `SELF_HOST_UNSIGNED_ASSET_NAMES`. Names in it are ALLOWED to arrive
 *      with `platformTrust: "none"`.
 *
 * When (1) grew and (2) did not, every release became unusable. v0.105.0
 * stopped signing the four agent-family exes; the allowlist still granted the
 * exception to `breeze-agent.msi` alone. The API rejected the exes as
 * non-distributable, and because Phase 1 of `syncFromGitHub` treats a trust
 * failure as a deployment-wide fault (deliberately — it prevents a
 * half-updated `agent_versions` that promotes agents while stranding
 * watchdogs), the whole sync aborted. `agent_versions` froze at 0.104.0 in
 * BOTH prod regions for nine days. It surfaced to self-hosters as a 404
 * "Version not found for the specified platform and architecture" on EVERY
 * platform — including Linux and macOS, which were signed correctly and had
 * nothing to do with the fault.
 *
 * That is the shape worth guarding: a Windows-only policy edit silently
 * becoming a total, cross-platform outage whose symptom points somewhere else
 * entirely. Neither file is wrong on its own, so no reviewer reading either
 * one in isolation can see the bug.
 *
 * The risk is live, not historical. Changing the signing provider (the ssl.com
 * migration tracked in #3708) or adding an agent-family artifact edits exactly
 * one of these two files first.
 *
 * ENFORCED (exit 1)
 * -----------------
 *   MISSING_FROM_ALLOWLIST  release.yml publishes the asset unsigned, but the
 *                           API still demands Authenticode. This is the #3504
 *                           outage, exactly.
 *   MISSING_FROM_PIPELINE   The API would accept the asset unsigned, but the
 *                           pipeline signs it. Not an outage — a silently
 *                           widened trust exception, which is worse in kind:
 *                           it accepts an unsigned binary we never intended to
 *                           ship unsigned.
 *   UNPARSEABLE             Either declaration could not be read. Failing
 *                           closed on purpose: a guard that silently finds
 *                           nothing to compare is indistinguishable from a
 *                           guard that passes, which is how this class of
 *                           check rots.
 *
 * DELIBERATELY NOT COVERED
 * ------------------------
 * The viewer/helper Tauri MSIs (`breeze-viewer-windows.msi`,
 * `breeze-helper-windows.msi`) are still Authenticode-signed and must stay
 * that way — they are tech-facing tools downloaded and double-clicked on a
 * workstation, where SmartScreen friction actually bites. They are not in
 * either declaration, and this guard asserts they never leak into one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELEASE_YML = join(repoRoot, '.github', 'workflows', 'release.yml');
const TRUST_TS = join(repoRoot, 'apps', 'api', 'src', 'services', 'releaseAssetTrust.ts');

/** Assets that must ALWAYS require platform signing, in both declarations. */
const MUST_STAY_SIGNED = ['breeze-viewer-windows.msi', 'breeze-helper-windows.msi'];


/**
 * Split a regex source on its TOP-LEVEL `|` only.
 *
 * A naive `.split('|')` also splits inside the `(agent|backup|...)` component
 * group, which shears `^breeze-(agent` off as a bogus alternative. Depth
 * tracking keeps group-internal alternation intact.
 */
export function splitTopLevel(src) {
  const out = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\\') {
      current += ch + (src[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === '|' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/**
 * Expand the pipeline's `AGENT_FAMILY_WINDOWS_RE` into concrete asset names.
 *
 * The regex is a literal alternation of fully-anchored names with one
 * `(a|b|c)` component group, so expanding it is exact rather than approximate.
 * Anything structurally unexpected is reported as UNPARSEABLE instead of being
 * silently skipped — see the note above about guards that rot.
 */
export function pipelineUnsignedNames(src, fail) {
  const block = src.match(/AGENT_FAMILY_WINDOWS_RE\s*=\s*re\.compile\(([\s\S]*?)\)\n/);
  if (!block) {
    fail('UNPARSEABLE', `Could not locate AGENT_FAMILY_WINDOWS_RE in ${RELEASE_YML}`);
    return null;
  }

  // Collect the r"..." string fragments the alternation is built from.
  const fragments = [...block[1].matchAll(/r"([^"]*)"/g)].map((m) => m[1]);
  if (fragments.length === 0) {
    fail('UNPARSEABLE', 'AGENT_FAMILY_WINDOWS_RE contains no r"..." fragments');
    return null;
  }

  const names = new Set();
  for (const alt of splitTopLevel(fragments.join(''))) {
    const pattern = alt.trim();
    if (!pattern) continue;
    if (!pattern.startsWith('^') || !pattern.endsWith('$')) {
      fail('UNPARSEABLE', `Alternative is not fully anchored, refusing to guess: ${pattern}`);
      return null;
    }
    const body = pattern.slice(1, -1).replace(/\\\./g, '.');
    const group = body.match(/\(([^)]*)\)/);
    if (!group) {
      names.add(body);
      continue;
    }
    for (const member of group[1].split('|')) {
      names.add(body.replace(/\([^)]*\)/, member));
    }
  }
  return names;
}

/** Read the API's SELF_HOST_UNSIGNED_ASSET_NAMES set. */
export function apiAllowlistNames(src, fail) {
  const block = src.match(
    /SELF_HOST_UNSIGNED_ASSET_NAMES[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/
  );
  if (!block) {
    fail('UNPARSEABLE', `Could not locate SELF_HOST_UNSIGNED_ASSET_NAMES in ${TRUST_TS}`);
    return null;
  }
  const names = new Set([...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]));
  if (names.size === 0) {
    fail('UNPARSEABLE', 'SELF_HOST_UNSIGNED_ASSET_NAMES parsed as empty');
    return null;
  }
  return names;
}

/**
 * Pure comparison of the two declarations. Exported so the guard's own logic is
 * testable without touching the real files — a guard whose parser is untested is
 * exactly the kind that passes while seeing nothing.
 */
export function compareTrustSets(pipeline, api) {
  const problems = [];
  for (const name of pipeline) {
    if (!api.has(name)) {
      problems.push({
        code: 'MISSING_FROM_ALLOWLIST',
        message:
          `${name}\n` +
          `      release.yml publishes this unsigned (platformTrust: "none"), but it is absent from\n` +
          `      SELF_HOST_UNSIGNED_ASSET_NAMES, so the API will reject it as non-distributable.\n` +
          `      One rejected asset aborts the ENTIRE sync — Linux and macOS included (#3504).\n` +
          `      Fix: add '${name}' to SELF_HOST_UNSIGNED_ASSET_NAMES in releaseAssetTrust.ts.`,
      });
    }
  }
  for (const name of api) {
    if (!pipeline.has(name)) {
      problems.push({
        code: 'MISSING_FROM_PIPELINE',
        message:
          `${name}\n` +
          `      The API would accept this unsigned, but release.yml no longer publishes it that way.\n` +
          `      A trust exception wider than the pipeline needs: it accepts an unsigned binary we do\n` +
          `      not intend to ship unsigned.\n` +
          `      Fix: remove '${name}' from SELF_HOST_UNSIGNED_ASSET_NAMES, or restore it in\n` +
          `      AGENT_FAMILY_WINDOWS_RE if dropping its signature was intended.`,
      });
    }
  }
  for (const name of MUST_STAY_SIGNED) {
    if (pipeline.has(name) || api.has(name)) {
      problems.push({
        code: 'VIEWER_MUST_STAY_SIGNED',
        message:
          `${name} must keep requiring Authenticode.\n` +
          `      It is a tech-facing tool downloaded and double-clicked on a workstation, which is\n` +
          `      where SmartScreen friction actually bites. Unlike the agent family, no self-hoster\n` +
          `      re-signs it under BYO signing, so there is no reason for it to arrive unsigned.`,
      });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && process.argv[1].endsWith('check-release-trust-allowlist.mjs');
if (isMain) {
  const problems = [];
  const fail = (code, message) => problems.push({ code, message });

  const pipeline = pipelineUnsignedNames(readFileSync(RELEASE_YML, 'utf8'), fail);
  const api = apiAllowlistNames(readFileSync(TRUST_TS, 'utf8'), fail);

  if (pipeline && api) problems.push(...compareTrustSets(pipeline, api));

  if (problems.length > 0) {
    console.error('\n  Release trust allowlist has drifted from the release pipeline.\n');
    for (const { code, message } of problems) console.error(`  [${code}] ${message}\n`);
    console.error(
      '  Both files encode the same policy and must be edited together.\n' +
        '    pipeline: .github/workflows/release.yml              (AGENT_FAMILY_WINDOWS_RE)\n' +
        '    api:      apps/api/src/services/releaseAssetTrust.ts (SELF_HOST_UNSIGNED_ASSET_NAMES)\n'
    );
    process.exit(1);
  }

  console.log(
    `check-release-trust-allowlist: OK — ${pipeline.size} agent-family asset(s) published unsigned, ` +
      'allowlist matches, viewer/helper still require Authenticode.'
  );
}
