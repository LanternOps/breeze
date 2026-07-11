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

    const bypasses = adoptedFiles.filter((file) =>
      readSource(file).includes('.toLocaleDateString('),
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
