import type { ConfigFeatureType } from '@breeze/shared/constants';

/**
 * Concrete, known-good inlineSettings for the feature types whose AI writes are
 * schema-validated (VALIDATED_INLINE_SETTINGS in aiToolsConfigPolicy.ts).
 * `manage_policy_feature_link` `describe` returns the matching example next to
 * the prose reference, so the model can copy a shape instead of learning it by
 * rejection (#6669).
 *
 * aiToolsConfigPolicy.inlineReference.test.ts holds every example to three
 * contracts: it parses through its feature's write validator, every key it uses
 * is named in POLICY_FEATURE_INLINE_SETTINGS_REFERENCE, and (compliance) every
 * rule passes the real evaluator on a device that satisfies it. Placeholder
 * names only — this file is public.
 */
export const INLINE_SETTINGS_EXAMPLES: Readonly<Partial<Record<ConfigFeatureType, unknown>>> = {
  compliance: {
    items: [
      {
        name: 'Endpoint baseline',
        enforcementLevel: 'monitor',
        checkIntervalMinutes: 60,
        rules: [
          // Presence only: no versionOperator (or "any") and no version.
          { type: 'required_software', softwareName: 'Contoso Endpoint Agent' },
          { type: 'required_software', softwareName: 'Contoso Endpoint Agent', softwareVersion: '7.0', versionOperator: 'gte' },
          { type: 'prohibited_software', prohibitedName: 'Fabrikam Torrent' },
          { type: 'disk_space_minimum', minGb: 20, diskPath: 'C:' },
          { type: 'os_version', osType: 'windows', minOsVersion: '10.0.19045' },
          { type: 'registry_check', registryPath: 'HKLM\\SOFTWARE\\Policies\\Contoso', registryValueName: 'Enabled', registryExpectedValue: '1' },
          { type: 'config_check', configFilePath: 'C:\\ProgramData\\Contoso\\agent.conf', configKey: 'TamperProtection', configExpectedValue: 'on' },
        ],
      },
    ],
  },
  maintenance: {
    recurrence: 'weekly',
    windowStart: '02:00',
    durationHours: 4,
    timezone: 'America/New_York',
    suppressAlerts: true,
    suppressPatching: true,
  },
  warranty: { enabled: true, warnDays: 90, criticalDays: 30 },
  onedrive_helper: {
    silentAccountConfig: true,
    filesOnDemand: true,
    kfmSilentOptIn: true,
    kfmFolders: ['Desktop', 'Documents'],
    libraries: [{ libraryId: 'library-id-placeholder', displayName: 'Shared Documents', targetingMode: 'everyone' }],
  },
};
