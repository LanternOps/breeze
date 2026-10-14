// Sources (verify at implementation time, record the version you checked):
//   cis_v8          — CIS Critical Security Controls v8.1 (cisecurity.org/controls). Licensed CC BY-NC-ND 4.0;
//                     identifiers + Breeze's own labels only, attribution rendered (spec §5.5, §18.13).
//   essential_eight — ACSC Essential Eight (cyber.gov.au), CC BY 4.0.
//   cyber_essentials— NCSC Cyber Essentials requirements v3.2, Open Government Licence; name is a trademark.
//   nist_csf_2      — NIST CSF 2.0 (nist.gov), public domain.
import type { TrustFramework } from './types';
export { TRUST_FRAMEWORKS } from './types';

export interface CrosswalkEntry { label: string; ig?: 1 | 2 | 3 }

export const FRAMEWORK_META: Record<TrustFramework, {
  name: string; shortName: string; sourceUrl: string; safeguardTotal: number; attribution: string;
}> = {
  cis_v8: {
    name: 'CIS Critical Security Controls v8', shortName: 'CIS v8',
    sourceUrl: 'https://www.cisecurity.org/controls', safeguardTotal: 153,
    attribution: 'CIS Controls® are a registered trademark of the Center for Internet Security, Inc. Safeguard identifiers are referenced with Breeze\'s own descriptions; see cisecurity.org/controls for the current text.',
  },
  essential_eight: {
    name: 'ACSC Essential Eight', shortName: 'Essential Eight',
    sourceUrl: 'https://www.cyber.gov.au/resources-business-and-government/essential-cyber-security/essential-eight',
    safeguardTotal: 8, attribution: 'Essential Eight © Commonwealth of Australia (ACSC), CC BY 4.0.',
  },
  cyber_essentials: {
    name: 'NCSC Cyber Essentials', shortName: 'Cyber Essentials',
    sourceUrl: 'https://www.ncsc.gov.uk/cyberessentials/overview', safeguardTotal: 5,
    attribution: 'Cyber Essentials is a UK Government scheme operated by the NCSC. Referenced by control name only.',
  },
  nist_csf_2: {
    name: 'NIST Cybersecurity Framework 2.0', shortName: 'NIST CSF 2.0',
    sourceUrl: 'https://www.nist.gov/cyberframework', safeguardTotal: 106,
    attribution: 'NIST CSF 2.0 is a work of the U.S. Government (public domain).',
  },
};

export const FRAMEWORK_CROSSWALK: Record<TrustFramework, Record<string, CrosswalkEntry>> = {
  cis_v8: {
    '1.1': { label: 'Maintain a detailed asset inventory', ig: 1 },
    '3.6': { label: 'Encrypt data on end-user devices', ig: 1 },
    '4.1': { label: 'Maintain a secure configuration process', ig: 1 },
    '4.2': { label: 'Secure configuration for network infrastructure', ig: 1 },
    '4.5': { label: 'Host-based firewall on end-user devices', ig: 1 },
    '5.2': { label: 'Unique, strong passwords', ig: 1 },
    '5.4': { label: 'Restrict admin rights to dedicated accounts', ig: 1 },
    '5.6': { label: 'Centralized account management', ig: 2 },
    '6.3': { label: 'MFA for externally exposed applications', ig: 1 },
    '6.5': { label: 'MFA for administrative access', ig: 1 },
    '6.7': { label: 'Centralized access control', ig: 2 },
    '6.8': { label: 'Role-based access control', ig: 3 },
    '7.3': { label: 'Automated operating-system patching', ig: 1 },
    '8.2': { label: 'Collect audit logs', ig: 1 },
    '9.2': { label: 'DNS filtering', ig: 1 },
    '10.1': { label: 'Anti-malware deployed and maintained', ig: 1 },
    '10.2': { label: 'Automatic anti-malware signature updates', ig: 1 },
    '10.7': { label: 'Behavior-based anti-malware', ig: 2 },
    '11.2': { label: 'Automated backups', ig: 1 },
    '11.3': { label: 'Protect recovery data', ig: 1 },
    '11.5': { label: 'Test data recovery', ig: 2 },
    '13.2': { label: 'Host-based intrusion detection', ig: 2 },
  },
  essential_eight: {
    patch_os: { label: 'Patch operating systems' },
    user_app_hardening: { label: 'User application hardening' },
    restrict_admin: { label: 'Restrict administrative privileges' },
    mfa: { label: 'Multi-factor authentication' },
    backups: { label: 'Regular backups' },
  },
  cyber_essentials: {
    firewalls: { label: 'Firewalls' },
    secure_configuration: { label: 'Secure configuration' },
    security_update_management: { label: 'Security update management' },
    user_access_control: { label: 'User access control' },
    malware_protection: { label: 'Malware protection' },
  },
  nist_csf_2: {
    'PR.PS': { label: 'Platform security' },
    'PR.PS-01': { label: 'Configuration management practices' },
    'PR.PS-02': { label: 'Software maintained and patched' },
    'PR.IR': { label: 'Technology infrastructure resilience' },
    'PR.AA': { label: 'Identity management and access control' },
    'PR.AA-01': { label: 'Identities and credentials managed' },
    'PR.AA-03': { label: 'Users and services authenticated' },
    'PR.AA-05': { label: 'Least-privilege access' },
    'PR.DS-01': { label: 'Data-at-rest protected' },
    'RC.RP': { label: 'Incident recovery plan execution' },
    'DE.CM': { label: 'Continuous monitoring' },
  },
};
