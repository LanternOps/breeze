export type BuiltinProvider = 'huntress' | 'sentinelone';

export interface BuiltinPackageDef {
  provider: BuiltinProvider;
  name: string;
  vendor: string;
  category: string;
  iconUrl?: string;
  websiteUrl?: string;
  fileType: string;
  supportedOs: string[];
  /** Templated download URL; undefined when the binary must be uploaded. */
  downloadUrlTemplate?: string;
  silentInstallArgsTemplate: string;
  requiresBinaryUpload: boolean;
}

export const BUILTIN_PACKAGES: Record<BuiltinProvider, BuiltinPackageDef> = {
  huntress: {
    provider: 'huntress',
    name: 'Huntress EDR Agent',
    vendor: 'Huntress',
    category: 'security',
    websiteUrl: 'https://www.huntress.com',
    fileType: 'exe',
    supportedOs: ['windows'],
    downloadUrlTemplate:
      'https://update.huntress.io/download/{huntress_acct_key}/HuntressInstaller.exe',
    silentInstallArgsTemplate:
      '/ACCT_KEY="{huntress_acct_key}" /ORG_KEY="{huntress_org_key}" /S',
    requiresBinaryUpload: false,
  },
  sentinelone: {
    provider: 'sentinelone',
    name: 'SentinelOne Agent',
    vendor: 'SentinelOne',
    category: 'security',
    websiteUrl: 'https://www.sentinelone.com',
    fileType: 'msi',
    supportedOs: ['windows'],
    silentInstallArgsTemplate: 'SITE_TOKEN={s1_site_token} /q /NORESTART',
    requiresBinaryUpload: true,
  },
};

export function getBuiltinPackage(provider: BuiltinProvider): BuiltinPackageDef {
  return BUILTIN_PACKAGES[provider];
}
