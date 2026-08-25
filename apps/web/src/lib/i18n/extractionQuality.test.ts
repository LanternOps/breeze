import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { i18n } from './index';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../..');

function readSource(relativePath: string): string {
  return readFileSync(join(srcDir, relativePath), 'utf8');
}

/**
 * `{t('key')}{expr}` in JSX: the two children are concatenated with nothing
 * between them. The extraction codemod consumed the separating space into the
 * matched English literal and never emitted it back as JSX whitespace, so the
 * label and its value render glued together ("0 of0 providers", "Step1 of3").
 * See #3965.
 *
 * A trailing space baked into the JSON value is NOT the fix: it is invisible to
 * translators, trivially stripped by a TMS round-trip, and it cannot help a
 * language that orders the value before the label. The fix is interpolation
 * (`t('key', { value })`) so the whole phrase is one translatable unit, or an
 * explicit `{' '}` separator where the two parts are genuinely independent.
 */
const ADJACENCY = /\{t\('([^']+)'\)\}\{/g;

/**
 * Adjacencies that are correct as written, because the expression that follows
 * supplies its own leading separator (a template literal starting with a space)
 * or because the English value deliberately ends mid-token. Each entry is
 * `<src-relative file>: <key>` mapped to the reason it was cleared.
 *
 * A NEW entry here needs a real review: the default answer for a fresh
 * adjacency is to fix the call site, not to widen this list.
 */
const REVIEWED_ADJACENCIES = new Map<string, string>([
  [
    'components/alerts/SuppressAlertDialog.tsx: suppressAlertDialog.howLongShould',
    'value closes on an opening curly quote that wraps the alert title; no space wanted (the raw entity is #3964)',
  ],
  [
    'components/billing/InvoiceDetail.tsx: invoiceDetail.summary.tax',
    'followed by a template literal that starts with its own space: ` (12%)`',
  ],
  [
    'components/billing/InvoiceDocument.tsx: invoiceDocument.totals.tax',
    'followed by a template literal that starts with its own space: ` (12%)`',
  ],
  [
    'components/billing/InvoiceEditor.tsx: invoiceEditor.summary.tax',
    'followed by a template literal that starts with its own space: ` (12.00%)`',
  ],
  [
    'components/billing/quotes/QuoteDetail.tsx: quotes.detail.totals.tax',
    'followed by a template literal that starts with its own space: ` (12%)`',
  ],
  [
    'components/billing/quotes/QuoteDocument.tsx: quotes.document.totals.tax',
    'followed by a template literal that starts with its own space: ` (12%)`',
  ],
  [
    'components/devices/DeviceReliabilityPanel.tsx: deviceReliabilityPanel.notScoredForType',
    'followed by a template literal that starts with its own space: ` — {evidence}`',
  ],
  [
    'components/remote/FileManager.tsx: fileManager.activity',
    'followed by a template literal that starts with its own space: ` ({count})`',
  ],
]);

function* walkTsx(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'locales') yield* walkTsx(path);
    } else if (entry.endsWith('.tsx') && !/\.test\.tsx$/.test(entry)) {
      yield path;
    }
  }
}

/**
 * Reports every `{t('key')}{…}` adjacency whose English value does not already
 * end in whitespace — i.e. every site where the rendered text glues the label
 * to the following expression unless something else supplies the separator.
 * `{t('key')}{' '}{…}` is the explicit separator form and is never reported.
 */
export function gluedAdjacencies(
  files: Iterable<[string, string]>,
  englishValue: (key: string) => string | undefined,
): string[] {
  const found: string[] = [];
  for (const [file, source] of files) {
    for (const match of source.matchAll(ADJACENCY)) {
      // The regex ends on the following child's opening brace; re-read from
      // there so an explicit `{' '}` separator is recognised.
      if (source.slice(match.index + match[0].length - 1).startsWith("{' '}")) continue;
      const key = match[1];
      const value = englishValue(key);
      if (value === undefined || value !== value.trimEnd()) continue;
      found.push(`${file}: ${key}`);
    }
  }
  return found.sort();
}

const englishNamespaces = readdirSync(join(srcDir, 'locales/en'))
  .filter(entry => entry.endsWith('.json'))
  .map(entry => entry.slice(0, -'.json'.length));

/**
 * Resolves a `t()` key against the en catalogs. An unprefixed key is looked up
 * in every namespace because the calling component's `useTranslation(ns)` isn't
 * known here; key names are namespace-prefixed by component in this repo, so a
 * collision would resolve to the same string anyway.
 */
function englishValueForKey(key: string): string | undefined {
  const [namespace, bare] = key.includes(':')
    ? (key.split(':', 2) as [string, string])
    : [undefined, key];
  for (const ns of namespace ? [namespace] : englishNamespaces) {
    const value = i18n.getResource('en', ns, bare) as unknown;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

describe('i18n extraction quality', () => {
  it('keeps adopted date displays on the resolved-locale formatters', () => {
    const adoptedFiles = [
      'components/patches/PatchInstallHistory.tsx',
      'components/settings/OrgSettingsPage.tsx',
      'components/settings/EnrollmentKeyManager.tsx',
    ];

    const directDateFormatters = [
      '.toLocaleDateString(',
      '.toLocaleTimeString(',
      '.toLocaleString(',
      'Intl.DateTimeFormat(',
    ];
    const bypasses = adoptedFiles.flatMap((file) =>
      directDateFormatters
        .filter(formatter => readSource(file).includes(formatter))
        .map(formatter => `${file}: ${formatter}`),
    );

    expect(bypasses, bypasses.join('\n')).toEqual([]);
  });

  it('does not rebuild translated sentences from English fragments', () => {
    const forbiddenFragments: Array<[string, string]> = [
      ['components/settings/RoleManager.tsx', 'roleManager.thisRoleHas'],
      ['components/settings/RoleManager.tsx', 'roleManager.areYouSureYouWantToDeleteTheRole'],
      ['components/backup/BackupOverviewContent.tsx', 'backupOverviewContent.alreadyRunningABackup'],
      ['components/backup/BackupOverviewContent.tsx', 'backupOverviewContent.thisWillStartManualBackupJobsFor'],
      ['components/backup/BackupOverviewContent.tsx', 'backupOverviewContent.beSkipped'],
    ];

    const remaining = forbiddenFragments
      .filter(([file, key]) => readSource(file).includes(key))
      .map(([file, key]) => `${file}: ${key}`);

    expect(remaining, remaining.join('\n')).toEqual([]);
  });

  it('keeps the Pax8 MFA hint in the integrations locale namespace', () => {
    expect(readSource('components/integrations/LinkSubscriptionPicker.tsx')).not.toContain(
      'const MFA_HINT',
    );
  });

  it('keeps Pax8 contract links observation-only in every locale', () => {
    const locales = ['en', 'de-DE', 'es-419', 'fr-FR', 'fr-CA', 'it-IT', 'pt-BR', 'tr-TR'];
    const requiredPax8Keys = [
      'subscriptionObservationDescription',
      'observingQuantity',
      'observationPaused',
      'pauseObservations',
      'resumeObservations',
    ];
    const removedPax8Keys = [
      'licenseSubscriptionsPulledFromPax8LinkASubscription',
      'syncPaused',
      'syncResumed',
      'syncing',
      'linked',
      'pause',
      'resume',
    ];
    const forbiddenPromises = [
      /sync quantities automatically/i,
      /Mengen automatisch zu synchronisieren/i,
      /sincronizar las cantidades automáticamente/i,
      /synchroniser automatiquement les quantités/i,
      /sincronizar quantidades automaticamente/i,
      /keep quantity in sync/i,
      /Halten Sie die Menge synchron/i,
      /Mantenga la cantidad sincronizada/i,
      /Gardez la quantité synchronisée/i,
      /Mantenha a quantidade sincronizada/i,
    ];

    for (const locale of locales) {
      const catalog = JSON.parse(
        readSource(`locales/${locale}/integrations.json`),
      ) as {
        pax8Integration: Record<string, string>;
        linkSubscriptionPicker: Record<string, string>;
      };
      for (const key of requiredPax8Keys) {
        expect(catalog.pax8Integration[key], `${locale}: missing ${key}`).toBeTruthy();
      }
      for (const key of removedPax8Keys) {
        expect(catalog.pax8Integration, `${locale}: stale ${key}`).not.toHaveProperty(key);
      }
      expect(
        catalog.linkSubscriptionPicker.trackQuantityForDrift,
        `${locale}: missing drift label`,
      ).toBeTruthy();
      expect(catalog.linkSubscriptionPicker).not.toHaveProperty('keepQuantityInSync');

      const pax8Copy = JSON.stringify({
        pax8Integration: catalog.pax8Integration,
        linkSubscriptionPicker: catalog.linkSubscriptionPicker,
      });
      for (const promise of forbiddenPromises) {
        expect(pax8Copy, `${locale}: ${promise}`).not.toMatch(promise);
      }
    }
  });

  it('provides complete singular and plural backup sentences', () => {
    expect(i18n.t('backup:backupOverviewContent.alreadyRunningCount', { lng: 'en', count: 1 }))
      .toBe('1 device is already running a backup.');
    expect(i18n.t('backup:backupOverviewContent.alreadyRunningCount', { lng: 'en', count: 2 }))
      .toBe('2 devices are already running a backup.');
    const portuguese = JSON.parse(
      readSource('locales/pt-BR/backup.json'),
    ) as { backupOverviewContent: Record<string, string> };
    expect(portuguese.backupOverviewContent.offlineSkipped_one)
      .toBe('{{count}} dispositivo offline será ignorado.');
    expect(portuguese.backupOverviewContent.offlineSkipped_other)
      .toBe('{{count}} dispositivos offline serão ignorados.');
  });

  // Regression guard for #3965: the extraction codemod dropped the space
  // between a label and its value at 14 call sites.
  it('never glues a t() label to the expression that follows it', () => {
    const files = [...walkTsx(srcDir)].map(
      path => [relative(srcDir, path).split(sep).join('/'), readFileSync(path, 'utf8')] as [string, string],
    );

    const glued = gluedAdjacencies(files, englishValueForKey);
    const unreviewed = glued.filter(entry => !REVIEWED_ADJACENCIES.has(entry));
    const stale = [...REVIEWED_ADJACENCIES.keys()].filter(entry => !glued.includes(entry));

    expect(unreviewed, `glued label/value adjacency:\n${unreviewed.join('\n')}`).toEqual([]);
    expect(stale, `stale reviewed adjacency (fixed — drop it):\n${stale.join('\n')}`).toEqual([]);
  }, 30_000);

  it('reports a glued adjacency and ignores separated or self-spacing ones', () => {
    const english: Record<string, string> = {
      'sso.of': 'of',
      'sso.showing': 'Showing ',
      'billing.tax': 'Tax',
    };
    const files: Array<[string, string]> = [
      ['components/Glued.tsx', "<p>{t('sso.of')}{total}</p>"],
      ['components/Separated.tsx', "<p>{t('sso.of')}{' '}{total}</p>"],
      ['components/TrailingSpaceValue.tsx', "<p>{t('sso.showing')}{total}</p>"],
      ['components/SelfSpacing.tsx', "<p>{t('billing.tax')}{rate ? ` (${rate}%)` : ''}</p>"],
    ];

    // The self-spacing site is still reported: only an explicit `{' '}` or a
    // value that already ends in whitespace clears it automatically, so a
    // template literal that supplies its own space must be reviewed by hand.
    expect(gluedAdjacencies(files, key => english[key])).toEqual([
      'components/Glued.tsx: sso.of',
      'components/SelfSpacing.tsx: billing.tax',
    ]);
  });
});
