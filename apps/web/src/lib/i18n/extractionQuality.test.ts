import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { i18n } from './index';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../..');

function readSource(relativePath: string): string {
  return readFileSync(join(srcDir, relativePath), 'utf8');
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
['en', 'de-DE', 'es-419', 'fr-FR', 'fr-CA', 'it-IT', 'pt-BR'];
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
});
