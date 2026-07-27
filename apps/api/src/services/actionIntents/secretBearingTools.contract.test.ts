import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isSecretBearingTool } from './secretBearingTools';

/**
 * Files that legitimately mention credential identifiers without minting one.
 * Every entry needs a reason — an unexplained allowlist entry is how this test
 * decays into a rubber stamp.
 *
 * NOTE: an entry only needs to appear here if it trips ONE of the two checks
 * below (the `generateTempPassword` call-site scan, or the `temporaryPassword`
 * field-name scan). A file that matches neither should not be listed — see
 * the "no stale entries" test, which fails if an entry stops earning its
 * place. `services/m365ControlPlane/writeActionService.ts` was removed for
 * exactly this reason: it contains zero occurrences of either pattern.
 */
const ALLOWLIST: Record<string, string> = {
  'services/m365DirectGraph.ts': 'generates the credential for the M365 direct backend; returns it structured',
  'services/actionIntents/resultSecrets.ts': 'owns the seal/unseal/burn primitives',
  'services/actionIntents/secretBearingTools.ts': 'this registry',
  'routes/actionIntents.ts': 'the reveal endpoint',
  'routes/ai.ts': 'tempPasswordState projection (key presence only)',
  'jobs/intentExpiryReaper.ts': 'sweeps sealed credentials past the reveal window',
  'jobs/intentReleaseWorker.ts': 'seals on the durable path',
  'services/m365ToolsHeadless.ts': 'comment only ("temporaryPassword is encrypted at rest") — no code reference to the field, no carrier construction',
};

/**
 * Detects a new tool minting a credential via the one shared helper that
 * every current minter happens to call.
 *
 * COVERAGE BOUNDARY — read this before trusting this check alone:
 * this regex catches ONLY call sites of the named `generateTempPassword`
 * helper. It does NOT catch a new tool that:
 *   - inlines its own randomness (e.g. composes `crypto.randomBytes(...)`
 *     ad hoc instead of calling the shared helper), or
 *   - receives an already-generated credential from a provider SDK response,
 *     with no local generator call site to match at all.
 * The `temporaryPassword`-field-name scan below is a second, independent net
 * for exactly that gap: any minter — however it obtains the credential —
 * still has to place it into the `SecretToolResult.secrets.temporaryPassword`
 * carrier for `sealToolSecrets` to encrypt it, so the field name is a
 * chokepoint the call-site regex can miss.
 *
 * Neither check is a complete proof of coverage. A tool that mints a
 * credential and stores it under a different field/shape, never touching the
 * shared carrier or the shared generator, is invisible to both nets — that
 * gap is real and is called out in the task report. Anyone adding a new
 * credential-minting tool must still register it in `secretBearingTools.ts`
 * by hand; these scans exist to make forgetting that noisy, not to make
 * registration unnecessary.
 */
const MINTS_CREDENTIAL = /generateTempPassword\s*\(/;

/**
 * Second net: catches a file that references the carrier's credential field
 * name even when it never calls `generateTempPassword` itself (e.g. it reads
 * an already-minted credential out of a provider response and forwards it).
 * Word-bounded so it does not also flag the derived marker keys
 * (`temporaryPasswordEnc`, `temporaryPasswordRevealed`, `temporaryPasswordExpired`,
 * `temporaryPasswordSealFailed`) — those are storage-state keys, not the raw
 * credential carrier field, and are legitimately touched by files that never
 * see plaintext (routes/ai.ts, intentExpiryReaper.ts).
 */
const REFERENCES_CREDENTIAL_FIELD = /\btemporaryPassword\b/;

/**
 * Files that trip one of the two scans above but are accepted conditionally:
 * only while the tool they back is still registered in secretBearingTools.ts.
 * If someone later removes the registry entry, the file falls straight
 * through to the plain offenders list and the test fails — that's the whole
 * point of this contract. Shared by both checks rather than duplicated.
 */
const MINTER_TO_TOOL: Record<string, string> = {
  'services/aiToolsGoogle.ts': 'google_reset_password',
  'services/aiToolsM365.ts': 'm365_reset_password',
};

const root = join(__dirname, '../..');

/**
 * Enumerates every non-test `.ts` file under `apps/api/src` as
 * `{ rel, content }`. Shared by both scans below so the traversal, the
 * `.test.` skip rule, and the `visited` floor assertion all come from one
 * place rather than being duplicated (and potentially drifting) per check.
 */
function collectSourceFiles(): { rel: string; content: string }[] {
  const files: { rel: string; content: string }[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue;

      const rel = full.slice(root.length + 1);
      files.push({ rel, content: readFileSync(full, 'utf8') });
    }
  };
  walk(root);

  return files;
}

/**
 * A file is accepted (not an offender) if it's on the reasoned allowlist, or
 * if it mints/touches the credential only on behalf of a tool that is
 * currently registered in secretBearingTools.ts.
 */
function isAccepted(rel: string): boolean {
  if (rel in ALLOWLIST) return true;
  return Boolean(MINTER_TO_TOOL[rel] && isSecretBearingTool(MINTER_TO_TOOL[rel]));
}

describe('secret-bearing tool registry parity', () => {
  it('every generateTempPassword call site is covered by a registered tool', () => {
    const files = collectSourceFiles();

    // A silently-empty scan would pass forever. Prove the walk actually
    // visited a realistic slice of apps/api/src (well over a thousand files
    // at the time this test was written).
    expect(files.length).toBeGreaterThan(500);

    const offenders = files
      .filter(({ rel, content }) => !isAccepted(rel) && MINTS_CREDENTIAL.test(content))
      .map(({ rel }) => rel);

    expect(offenders, `these files call generateTempPassword but are neither registered nor allowlisted:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('every temporaryPassword field reference is covered by a registered tool', () => {
    const files = collectSourceFiles();
    expect(files.length).toBeGreaterThan(500);

    const offenders = files
      .filter(({ rel, content }) => !isAccepted(rel) && REFERENCES_CREDENTIAL_FIELD.test(content))
      .map(({ rel }) => rel);

    expect(offenders, `these files reference the temporaryPassword carrier field but are neither registered nor allowlisted:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('both known credential-minting tools are registered', () => {
    expect(isSecretBearingTool('m365_reset_password')).toBe(true);
    expect(isSecretBearingTool('google_reset_password')).toBe(true);
  });

  it('every MINTER_TO_TOOL mapping points at a currently-registered tool', () => {
    for (const [rel, toolName] of Object.entries(MINTER_TO_TOOL)) {
      expect(isSecretBearingTool(toolName), `${rel} is mapped to ${toolName}, which is not registered`).toBe(true);
    }
  });

  it('the allowlist has no stale entries', () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      expect(() => readFileSync(join(root, rel), 'utf8'), `allowlisted file no longer exists: ${rel}`).not.toThrow();
    }
  });

  it('the MINTER_TO_TOOL map has no stale entries', () => {
    for (const rel of Object.keys(MINTER_TO_TOOL)) {
      expect(() => readFileSync(join(root, rel), 'utf8'), `mapped file no longer exists: ${rel}`).not.toThrow();
    }
  });
});
