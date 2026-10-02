// apps/api/src/services/aiModels/legacyRemoval.contract.test.ts
/**
 * AI model registry W08 (#7606) ratchet: the legacy AI model configuration path
 * stays deleted. DELETED_PATHS must not exist; RETIRED_IDENTIFIERS must not
 * appear in non-test source under the scanned roots. Migrations, docs and the
 * W08 preflight are history and are not scanned. The one legacy string that
 * must survive is the AAD tag 'partner_llm_configs.api_key_encrypted', which
 * seals every stored connection key (encryptedColumnRegistry.ts).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..', '..');
const ROOTS = ['apps/api/src', 'apps/web/src', 'packages/shared/src', 'ee'];
const SKIP_DIR = new Set(['node_modules', 'dist', 'build', '.astro', '__tests__', '__fixtures__']);
/** Files whose job is to NAME the legacy objects (archive metadata), never to read them. */
const ALLOWED_FILES = new Set([
  'apps/api/src/db/schema/aiModelRegistryLegacyArchive.ts',
  // purgeRetiredLegacyKeyCopy deletes the partner's row from the still-existing legacy table
  // (guarded by to_regclass) when a key is rotated or disconnected, preserving the W03 #7700
  // "revoked key must not persist" behaviour until W08b drops the table.
  // W08b removes the helper and this entry.
  'apps/api/src/services/aiModels/connectionRemap.ts',
]);

export const DELETED_PATHS: readonly string[] = [
  'apps/api/src/routes/aiProvider.ts',
  'apps/api/src/services/partnerLlmConfig.ts',
  'apps/api/src/services/aiModels/compatRemap.ts',
  'apps/api/src/services/aiModels/legacyCostEvents.ts',
  'apps/api/src/services/aiModels/legacyProjection.ts',
  'apps/api/src/services/aiModels/legacyReconcile.ts',
  'apps/api/src/services/aiModels/legacySurfaceModels.ts',
  'apps/api/src/services/aiModels/parity',
  'apps/api/src/db/schema/partnerLlmConfigs.ts',
];

/** [identifier, pattern]: the pattern lets an allowed superstring through. */
export const RETIRED_IDENTIFIERS: ReadonlyArray<readonly [string, RegExp]> = [
  ['partnerLlmConfigs', /\bpartnerLlmConfigs\b/],
  ['partner_llm_configs', /partner_llm_configs(?!\.api_key_encrypted)/],
  ['legacyDefaultModel', /\blegacyDefaultModel\b/],
  ['legacy_default_model', /\blegacy_default_model\b/],
  ['getLegacyModelRates', /\bgetLegacyModelRates\b/],
  ['LEGACY_MODEL_RATES', /\bLEGACY_MODEL_RATES\b/],
  ['reconcilePartnerFromLegacy', /\breconcilePartnerFromLegacy/],
  ['buildDesiredRegistryState', /\bbuildDesiredRegistryState\b/],
  ['resolveReviewerDefaultModel', /\bresolveReviewerDefaultModel\b/],
  ['AI_SCRIPT_REVIEWER_MODEL', /(?<!BREEZE_)\bAI_SCRIPT_REVIEWER_MODEL\b/],
  ['BREEZE_AI_SCRIPT_REVIEWER_MODEL', /\bBREEZE_AI_SCRIPT_REVIEWER_MODEL\b/],
  ['WORKSPACE_CONTENT_LLM_MODEL', /\bWORKSPACE_CONTENT_LLM_MODEL\b/],
  ['registerInvocationLedgerShadow', /\bregisterInvocationLedgerShadow\b/],
  ['emitLegacyCostRecorded', /\bemitLegacyCostRecorded\b/],
  ['getCompatConnection', /\bgetCompatConnection\b/],
  ['PartnerLlmError', /\bPartnerLlmError\b/],
  ['_ignoredReviewerModel', /_ignoredReviewerModel/],
];

function walk(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('AI model registry legacy removal (W08 ratchet)', () => {
  it('every deleted path stays deleted', () => {
    expect(DELETED_PATHS.filter((p) => existsSync(join(REPO, p)))).toEqual([]);
  });

  it('no retired identifier appears in non-test source', () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(join(REPO, root), [])) {
        if (ALLOWED_FILES.has(relative(REPO, file).split(sep).join('/'))) continue;
        const src = readFileSync(file, 'utf8');
        for (const [name, pattern] of RETIRED_IDENTIFIERS) {
          if (pattern.test(src)) hits.push(`${relative(REPO, file).split(sep).join('/')}: ${name}`);
        }
      }
    }
    expect(hits).toEqual([]);
    // A synchronous walk of four source trees: under a parallel full-suite run it
    // can outlast the default 5 s test timeout (seen locally at ~7 s).
  }, 60_000);

  it('the scanner fires (control)', () => {
    const [, pattern] = RETIRED_IDENTIFIERS.find(([n]) => n === 'partner_llm_configs')!;
    expect(pattern.test('FROM partner_llm_configs')).toBe(true);
    expect(pattern.test("aadTag: 'partner_llm_configs.api_key_encrypted'")).toBe(false);
  });
});
