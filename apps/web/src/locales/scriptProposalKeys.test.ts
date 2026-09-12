import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = dirname(fileURLToPath(import.meta.url));
const locales = readdirSync(localesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const read = (locale: string, ns: string) => JSON.parse(readFileSync(join(localesDir, locale, ns), 'utf8'));

const AI_KEYS = [
  'title','goal','expectedEffect','verificationClaim','rollback','findings','blastRadius','touches','devices',
  'showCode','hideCode','acknowledgeTitle','acknowledgeRequirement','acknowledgeIncomplete','expiresIn',
  'requestChanges','notePlaceholder','noteRequired','sendBack','severityInfo','severityWarning','severityBlocking',
  'saveToLibrary','verificationPending','verified','verificationFailed','verificationUnknown',
  'promoteDescription','ownerScopeOrganization','ownerScopePartner','nameRequired',
];
const SCRIPT_KEYS = [
  'origin','originHuman','originAiProposal','originImported','originSystem','reviewed','editedSinceReview',
  'provenanceTitle','reviewSummary','approvedBy','evidenceErased','allOrigins',
];

describe('script proposal i18n', () => {
  it.each(locales)('%s ai.json carries every scriptProposal key', (locale) => {
    const block = read(locale, 'ai.json').scriptProposal;
    expect(Object.keys(block ?? {}).sort()).toEqual([...AI_KEYS].sort());
  });
  it.each(locales)('%s scripts.json carries every provenance key', (locale) => {
    const block = read(locale, 'scripts.json').provenance;
    expect(Object.keys(block ?? {}).sort()).toEqual([...SCRIPT_KEYS].sort());
  });
  it.each(locales.filter((l) => l !== 'en'))('%s translates them (no English copies)', (locale) => {
    const en = read('en', 'ai.json').scriptProposal as Record<string, string>;
    const other = read(locale, 'ai.json').scriptProposal as Record<string, string>;
    // expiresIn is pure interpolation in some locales; everything else must differ.
    const copied = Object.keys(en).filter((k) => en[k] === other[k]);
    expect(copied).toEqual([]);
  });
});
