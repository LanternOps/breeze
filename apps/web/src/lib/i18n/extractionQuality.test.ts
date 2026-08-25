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
 *
 * Scope: same-line, zero-gap adjacency of a single-argument translation call,
 * which is the shape the codemod produced. It deliberately does NOT match
 * `{t(k, {...})}` followed by another call, nor children separated by a newline.
 * Both quote styles are matched, and both calling conventions — the
 * `useTranslation()` hook's `t()` and the module singleton's `i18n.t()`, which
 * the repo uses side by side. Missing the `i18n.t()` form left a live glued
 * heading ("RevokeMyLaptop?") invisible to the first cut of this guard.
 */
const ADJACENCY = /\{(?:i18n\.)?t\((['"])([^'"]+)\1\)\}\{/g;

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
      // there so an explicit separator is recognised in either quote style.
      const rest = source.slice(match.index + match[0].length - 1);
      if (rest.startsWith("{' '}") || rest.startsWith('{" "}')) continue;
      const key = match[2];
      const value = englishValue(key);
      // An unresolvable key is not this guard's problem: keyUsage.test.ts
      // already fails on any literal t() key missing from the en catalogs, so
      // skipping it here cannot hide one.
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

/**
 * A `t('key')` call with no interpolation object. i18next leaves an unmatched
 * `{{token}}` in the output verbatim (no `missingInterpolationHandler` is
 * configured), so calling a key whose value carries placeholders without
 * supplying them renders the raw `{{token}}` to the user.
 *
 * This is how a *reused* key goes wrong: one call site interpolates it, another
 * uses it as a bare label. It is exactly the bug review caught in the first cut
 * of this PR — `accessReviewPage.dueDate` was an existing column header, and
 * giving it the value "Due {{date}}" for the badge made the header render
 * "Due {{date}}" in all eight locales.
 */
const BARE_CALL = /(?<![\w.])(?:i18n\.)?t\((['"])([^'"]+)\1\s*\)/g;

/**
 * Keys whose placeholders are shown to the user ON PURPOSE, because the tokens
 * are the template syntax the user is being invited to type. These are form
 * `placeholder=` hints, not rendered copy.
 */
const REVIEWED_PLACEHOLDER_PREVIEWS = new Set<string>([
  'notificationChannelForm.alertValueValueIsValueThresholdValue',
  'notificationChannelForm.resolvedValueValueHasReturnedToNormal',
  'inboundEmail.subjectPlaceholder',
  'inboundEmail.bodyPlaceholder',
]);

/**
 * Reports every bare `t('key')` whose English value still contains a `{{token}}`
 * the call cannot fill.
 */
export function unfilledPlaceholderCalls(
  files: Iterable<[string, string]>,
  englishValue: (key: string) => string | undefined,
): string[] {
  const found: string[] = [];
  for (const [file, source] of files) {
    for (const match of source.matchAll(BARE_CALL)) {
      const key = match[2];
      if (REVIEWED_PLACEHOLDER_PREVIEWS.has(key)) continue;
      const value = englishValue(key);
      if (value === undefined || !value.includes('{{')) continue;
      found.push(`${file}: ${key}`);
    }
  }
  return found.sort();
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
  // between a label and its value across the settings screens.
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
      ['components/GluedSingleton.tsx', "<p>{i18n.t('sso.of')}{total}</p>"],
      ['components/Separated.tsx', "<p>{t('sso.of')}{' '}{total}</p>"],
      ['components/SeparatedDoubleQuoted.tsx', '<p>{t("sso.of")}{" "}{total}</p>'],
      ['components/TrailingSpaceValue.tsx', "<p>{t('sso.showing')}{total}</p>"],
      ['components/SelfSpacing.tsx', "<p>{t('billing.tax')}{rate ? ` (${rate}%)` : ''}</p>"],
    ];

    // The self-spacing site is still reported: only an explicit `{' '}` or a
    // value that already ends in whitespace clears it automatically, so a
    // template literal that supplies its own space must be reviewed by hand.
    expect(gluedAdjacencies(files, key => english[key])).toEqual([
      'components/Glued.tsx: sso.of',
      'components/GluedSingleton.tsx: sso.of',
      'components/SelfSpacing.tsx: billing.tax',
    ]);
  });

  // Guard for the reused-key failure mode that review caught in this PR's own
  // first cut: a key used as a bare label in one place and interpolated in
  // another renders its raw {{token}} at the bare call site.
  it('flags a bare placeholder call in either calling convention', () => {
    const english: Record<string, string> = {
      'page.dueDate': 'Due {{date}}',
      'page.header': 'Due Date',
    };
    const files: Array<[string, string]> = [
      ['components/Hook.tsx', "<th>{t('page.dueDate')}</th>"],
      ['components/Singleton.tsx', "<th>{i18n.t('page.dueDate')}</th>"],
      ['components/Filled.tsx', "<span>{t('page.dueDate', { date })}</span>"],
      ['components/Plain.tsx', "<th>{t('page.header')}</th>"],
    ];

    expect(unfilledPlaceholderCalls(files, key => english[key])).toEqual([
      'components/Hook.tsx: page.dueDate',
      'components/Singleton.tsx: page.dueDate',
    ]);
  });

  it('never renders an unfilled {{placeholder}} from a bare t() call', () => {
    const files = [...walkTsx(srcDir)].map(
      path => [relative(srcDir, path).split(sep).join('/'), readFileSync(path, 'utf8')] as [string, string],
    );

    const leaking = unfilledPlaceholderCalls(files, englishValueForKey);

    expect(leaking, `bare t() call on a key with placeholders:\n${leaking.join('\n')}`).toEqual([]);
  }, 30_000);

  it('separates a reused key\'s interpolated and bare forms', () => {
    // The column header and the badge are two different keys precisely so the
    // header cannot inherit the badge's placeholder.
    expect(i18n.t('settings:accessReviewPage.dueDate', { lng: 'en' })).toBe('Due Date');
    expect(i18n.t('settings:accessReviewPage.dueOn', { lng: 'en', date: '8/24/2026' }))
      .toBe('Due 8/24/2026');
    expect(i18n.t('security:securitySecurityScanManager.startedColumn', { lng: 'en' }))
      .toBe('Started');
  });

  it('renders the fixed count summaries with their separators intact', () => {
    expect(i18n.t('settings:ssoProviderList.countSummary', { lng: 'en', shown: 0, total: 0 }))
      .toBe('0 of 0 providers');
    expect(i18n.t('settings:accessReviewForm.stepSummary', { lng: 'en', current: 1, total: 3 }))
      .toBe('Step 1 of 3');
    expect(i18n.t('settings:accessReviewPage.showingSummary', { lng: 'en', shown: 12, total: 40 }))
      .toBe('Showing 12 of 40 users');
    expect(i18n.t('settings:roleManager.permissionsForRole', { lng: 'en', role: 'Partner Billing' }))
      .toBe('Permissions for Partner Billing');
    expect(i18n.t('settings:profilePage.lastUsedAt', { lng: 'en', date: '8/24/2026' }))
      .toBe('Last used: 8/24/2026');
  });
});
