import { TELEMETRY_CONTROL_IDS, type TelemetryControlId, type TrustControlDefinition } from './types';
export { TELEMETRY_CONTROL_IDS };

/**
 * Bump the suffix whenever an entry's semantics change; the date is the catalog's publication date.
 * 2026-10-17.1 (W2): + mfa_enforced_m365 (insurer rank 1, every other rank +1); NIST CSF refs normalized to
 * subcategories (spec §19 items 25–26).
 */
export const TRUST_CONTROL_CATALOG_VERSION = '2026-10-17.1';

const cis = (ref: string) => ({ framework: 'cis_v8', ref }) as const;
const e8 = (ref: string) => ({ framework: 'essential_eight', ref }) as const;
const ce = (ref: string) => ({ framework: 'cyber_essentials', ref }) as const;
const nist = (ref: string) => ({ framework: 'nist_csf_2', ref }) as const;

export const TRUST_CONTROL_CATALOG: readonly TrustControlDefinition[] = [
  { id: 'mfa_enforced_m365', category: 'identity_access', source: 'telemetry', metric: 'boolean', unit: 'org', insurerRank: 1,
    title: 'MFA enforced (Microsoft 365 Conditional Access)',
    description: 'An enabled Conditional Access policy requires multi-factor authentication for all users on all cloud apps. Report-only policies do not count.',
    frameworkRefs: [cis('6.3'), cis('6.5'), e8('mfa'), ce('user_access_control'), nist('PR.AA-03')] },
  { id: 'mfa_registered_m365', category: 'identity_access', source: 'telemetry', metric: 'coverage_pct', unit: 'users', insurerRank: 2,
    title: 'MFA registered (Microsoft 365)',
    description: 'Share of Microsoft 365 users with a registered multi-factor authentication method. Registration is not enforcement; every admin account must also be registered.',
    frameworkRefs: [cis('6.3'), cis('6.5'), e8('mfa'), ce('user_access_control'), nist('PR.AA-03')],
    gate: { label: 'All admin accounts have MFA registered' } },
  { id: 'edr_coverage', category: 'endpoint_protection', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 3,
    title: 'Endpoint detection and response (EDR)',
    description: 'Share of assessed devices running a Breeze-managed EDR agent.',
    frameworkRefs: [cis('10.7'), cis('13.2'), ce('malware_protection'), nist('DE.CM-09')] },
  { id: 'backups_verified', category: 'data_protection', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 4,
    title: 'Backups verified restorable',
    description: 'Share of Breeze-backed-up devices with a passed integrity check or test restore inside the evidence window. Configured-but-unverified backups do not count.',
    frameworkRefs: [cis('11.2'), cis('11.3'), cis('11.5'), e8('backups'), nist('PR.DS-11')] },
  { id: 'os_patch_currency', category: 'patching_hardening', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 5,
    title: 'Operating-system patches current',
    description: 'Share of patch-scanned devices with no outstanding critical patch.',
    frameworkRefs: [cis('7.3'), e8('patch_os'), ce('security_update_management'), nist('PR.PS-02')] },
  { id: 'disk_encryption', category: 'data_protection', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 6,
    title: 'Disk encryption',
    description: 'Share of assessed devices reporting full-disk encryption (BitLocker, FileVault or LUKS).',
    frameworkRefs: [cis('3.6'), nist('PR.DS-01')] },
  { id: 'endpoint_protection', category: 'endpoint_protection', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 7,
    title: 'Endpoint protection active',
    description: 'Share of assessed devices with real-time anti-malware protection on, from any supported product.',
    frameworkRefs: [cis('10.1'), ce('malware_protection'), nist('DE.CM-09')] },
  { id: 'least_privilege', category: 'identity_access', source: 'telemetry', metric: 'exposure_pct', unit: 'devices', insurerRank: 8,
    title: 'Local administrator accounts limited',
    description: 'Share of assessed devices with more local administrator accounts than the policy allows (lower is better).',
    frameworkRefs: [cis('5.4'), e8('restrict_admin'), ce('user_access_control'), nist('PR.AA-05')] },
  { id: 'privileged_access', category: 'identity_access', source: 'telemetry', metric: 'boolean', unit: 'org', insurerRank: 9,
    title: 'Privileged access controlled',
    description: 'Elevation requests are governed by active privileged-access rules or require step-up MFA.',
    frameworkRefs: [cis('5.4'), cis('6.8'), e8('restrict_admin'), ce('user_access_control'), nist('PR.AA-05')] },
  { id: 'host_firewall', category: 'endpoint_protection', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 10,
    title: 'Host firewall enabled',
    description: 'Share of assessed devices with the operating-system firewall on.',
    frameworkRefs: [cis('4.5'), ce('firewalls'), nist('PR.IR-01')] },
  { id: 'definitions_current', category: 'endpoint_protection', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 11,
    title: 'Anti-malware definitions current',
    description: 'Share of devices with native anti-malware whose definitions are no older than the definitions window.',
    frameworkRefs: [cis('10.2'), ce('malware_protection'), nist('DE.CM-09')] },
  { id: 'password_policy', category: 'identity_access', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 12,
    title: 'Local password policy enforced',
    description: 'Share of assessed devices enforcing the minimum password length and account lockout.',
    frameworkRefs: [cis('5.2'), ce('secure_configuration'), nist('PR.AA-01')] },
  { id: 'identity_provider', category: 'identity_access', source: 'telemetry', metric: 'boolean', unit: 'org', insurerRank: 13,
    title: 'Central identity provider connected',
    description: 'Microsoft 365 or Google Workspace is connected to Breeze for identity visibility.',
    frameworkRefs: [cis('5.6'), cis('6.7'), ce('user_access_control'), nist('PR.AA-01')] },
  { id: 'hardening_baseline', category: 'patching_hardening', source: 'telemetry', metric: 'pass_rate', unit: 'devices', insurerRank: 14,
    title: 'Configuration hardening baseline',
    description: 'Mean pass rate of the latest CIS Benchmark configuration scan across assessed devices.',
    frameworkRefs: [cis('4.1'), cis('4.2'), e8('user_app_hardening'), ce('secure_configuration'), nist('PR.PS-01')] },
  { id: 'dns_filtering', category: 'monitoring', source: 'telemetry', metric: 'boolean', unit: 'org', insurerRank: 15,
    title: 'DNS filtering active',
    description: 'A DNS-filtering integration is connected and syncing without errors.',
    frameworkRefs: [cis('9.2'), nist('PR.IR-01')] },
  { id: 'continuous_monitoring', category: 'monitoring', source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: 16,
    title: 'Continuous monitoring',
    description: 'Share of managed devices that checked in with Breeze within the last 24 hours.',
    frameworkRefs: [cis('1.1'), cis('8.2'), nist('DE.CM-09')] },
];

const BY_ID = new Map(TRUST_CONTROL_CATALOG.map((c) => [c.id, c]));
export function trustControlById(id: TelemetryControlId): TrustControlDefinition | undefined {
  return BY_ID.get(id);
}
