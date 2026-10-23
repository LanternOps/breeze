import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Spec §11 copy rule for the YARA / IOC-scan UI (#6263 W04): the feature is an
 * "IOC scan", "detection rules", "threat hunting" or a "malware scan
 * (signature-based)". It is never sold as EDR, antivirus, real-time protection
 * or prevention — it scans on a schedule or on demand. Auto-quarantine is an
 * opt-in action on a match, not prevention.
 */

const localesDir = dirname(fileURLToPath(import.meta.url));
const LOCALES = ['de-DE', 'en', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'] as const;
type Locale = (typeof LOCALES)[number];

/** Copy owned by the YARA UI: `namespace` + dotted key prefix. */
const SCOPES: ReadonlyArray<{ ns: string; prefix: string }> = [
  { ns: 'security', prefix: 'detectionRules' },
  { ns: 'security', prefix: 'securityThreatDetail.rule' },
  { ns: 'security', prefix: 'securityEdrPage.iocScansLink' },
  { ns: 'policies', prefix: 'configurationPolicies.featureTabs.securityTab.ruleSets' },
  { ns: 'pages', prefix: 'titles.securityDetectionRules' },
  { ns: 'common', prefix: 'nav.securityDetectionRules' },
];

const EVERYWHERE: RegExp[] = [/\bEDR\b/i, /\banti-?vir/i, /\breal[- ]time protection\b/i, /\bprevention\b/i];

const BANNED: Record<Locale, RegExp[]> = {
  en: [],
  'de-DE': [/virenschutz/i, /echtzeitschutz/i, /prävention/i],
  'es-419': [/antivirus/i, /tiempo real/i, /prevención/i],
  'fr-CA': [/antivirus/i, /temps réel/i, /prévention/i],
  'fr-FR': [/antivirus/i, /temps réel/i, /prévention/i],
  'it-IT': [/antivirus/i, /tempo reale/i, /prevenzione/i],
  'pt-BR': [/antiv[ií]rus/i, /tempo real/i, /prevenção/i],
  'tr-TR': [/antivirüs/i, /gerçek zamanlı/i, /önleme/i],
};

function leavesUnder(obj: unknown, prefix: string): Array<[string, string]> {
  let node: unknown = obj;
  for (const seg of prefix.split('.')) {
    if (!node || typeof node !== 'object') return [];
    node = (node as Record<string, unknown>)[seg];
  }
  const out: Array<[string, string]> = [];
  const walk = (n: unknown, path: string) => {
    if (typeof n === 'string') out.push([path, n]);
    else if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) walk(v, `${path}.${k}`);
  };
  walk(node, prefix);
  return out;
}

export function copyRuleViolations(locale: Locale, leaves: Array<[string, string]>): string[] {
  const patterns = [...EVERYWHERE, ...BANNED[locale]];
  return leaves.flatMap(([key, value]) =>
    patterns.filter((p) => p.test(value)).map((p) => `${locale} ${key}: "${value}" matches ${p}`),
  );
}

function load(locale: Locale, ns: string): unknown {
  return JSON.parse(readFileSync(join(localesDir, locale, `${ns}.json`), 'utf8'));
}

describe('YARA UI copy rule (spec §11)', () => {
  it('the checker catches a banned phrase (control)', () => {
    expect(copyRuleViolations('en', [['x', 'Real-time protection for every endpoint']])).toHaveLength(1);
    expect(copyRuleViolations('de-DE', [['x', 'Echtzeitschutz']])).toHaveLength(1);
    expect(copyRuleViolations('en', [['x', 'IOC scans and threat hunting']])).toHaveLength(0);
  });

  it('every scoped key prefix that has shipped carries copy in en', () => {
    const present = SCOPES.filter(({ ns, prefix }) => leavesUnder(load('en', ns), prefix).length > 0);
    // Every scope must carry copy, so a renamed prefix cannot silently drop
    // out of the check.
    expect(present.map((s) => `${s.ns}:${s.prefix}`)).toEqual(
      expect.arrayContaining([
        'security:detectionRules',
        'security:securityEdrPage.iocScansLink',
        'pages:titles.securityDetectionRules',
        'common:nav.securityDetectionRules',
        'policies:configurationPolicies.featureTabs.securityTab.ruleSets',
        'security:securityThreatDetail.rule',
      ]),
    );
  });

  it.each(LOCALES)('%s carries no banned term in YARA UI copy', (locale) => {
    const leaves = SCOPES.flatMap(({ ns, prefix }) => leavesUnder(load(locale, ns), prefix));
    expect(leaves.length).toBeGreaterThan(0);
    expect(copyRuleViolations(locale, leaves)).toEqual([]);
  });
});
