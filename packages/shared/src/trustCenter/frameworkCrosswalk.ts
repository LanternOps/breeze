// Sources — version cited and date recorded (header written in the final fix wave, 2026-10-14;
// "recorded" = transcribed at implementation, not independently re-verified since):
//   cis_v8          — CIS Critical Security Controls v8.1 (cisecurity.org/controls), as cited by spec §5.5.
//                     Licensed CC BY-NC-ND 4.0; identifiers + Breeze's own labels only, attribution
//                     rendered (spec §5.5, §18.13). Safeguard refs and IG tiers were transcribed at
//                     implementation (2026-10-13) and cross-checked in review the same day against the
//                     v8 safeguard numbering; NOT yet re-verified line-by-line against the published
//                     v8.1 PDF — that confirmation is the W2 GA licensing step.
//   essential_eight — ACSC Essential Eight (cyber.gov.au), CC BY 4.0. Strategy names, recorded 2026-10-13.
//   cyber_essentials— NCSC Cyber Essentials requirements v3.2, Open Government Licence; name is a
//                     trademark. Five technical control themes, recorded 2026-10-13.
//   nist_csf_2      — NIST CSF 2.0 (nist.gov, Feb 2024), public domain. Subcategory ids, recorded 2026-10-13.
//
// W2 (catalog 2026-10-17.1, recorded 2026-10-16):
//   nist_csf_2      — every ref is now a subcategory (spec §19 item 26). Each id below was checked on 2026-10-16
//                     against NIST's CSF 2.0 reference-tool export (csrc.nist.gov CSF 2.0 core, the CSWP 29
//                     subcategory set): DE.CM-09, PR.IR-01, PR.AA-01/-03/-05, PR.DS-01/-11, PR.PS-01/-02,
//                     PR.AT-01, RS.MA-01, ID.IM-04, GV.SC-04, ID.AM-07, RC.RP-01, ID.RA-01 all exist with the
//                     meaning the Breeze label paraphrases. Category-level ids (PR.PS, PR.IR, PR.AA, RC.RP, DE.CM)
//                     were removed.
//   cis_v8          — the declared-control safeguards (3.1, 3.2, 5.1, 5.3, 6.1, 6.2, 11.1, 11.4, 14.1, 14.2, 15.1,
//                     15.2, 17.1–17.3, 18.1, 18.2) and their IG tiers were transcribed from the v8.1 safeguard
//                     numbering on 2026-10-16. The CIS PDF sits behind a registration wall and was NOT fetched in
//                     this session: the line-by-line v8.1 confirmation stays the §18.13 licensing gate, and the
//                     CIS framework view stays behind BREEZE_TRUST_CIS_FRAMEWORK_VIEW (default off) until then.
//   essential_eight — completed to all eight mitigation strategies (application control, patch applications,
//                     Microsoft Office macro settings added), recorded 2026-10-16.
import type { TrustFramework } from './types';
export { TRUST_FRAMEWORKS } from './types';

export interface CrosswalkEntry { label: string; ig?: 1 | 2 | 3 }

export const FRAMEWORK_META: Record<TrustFramework, {
  name: string; shortName: string; sourceUrl: string; safeguardTotal: number; attribution: string;
}> = {
  cis_v8: {
    name: 'CIS Critical Security Controls v8.1', shortName: 'CIS v8',
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
    '3.1': { label: 'Data management process', ig: 1 },
    '3.2': { label: 'Data inventory', ig: 1 },
    '3.6': { label: 'Encrypt data on end-user devices', ig: 1 },
    '4.1': { label: 'Maintain a secure configuration process', ig: 1 },
    '4.2': { label: 'Secure configuration for network infrastructure', ig: 1 },
    '4.5': { label: 'Host-based firewall on end-user devices', ig: 1 },
    '5.1': { label: 'Inventory of accounts', ig: 1 },
    '5.2': { label: 'Unique, strong passwords', ig: 1 },
    '5.3': { label: 'Disable dormant accounts', ig: 1 },
    '5.4': { label: 'Restrict admin rights to dedicated accounts', ig: 1 },
    '5.6': { label: 'Centralized account management', ig: 2 },
    '6.1': { label: 'Process for granting access', ig: 1 },
    '6.2': { label: 'Process for revoking access', ig: 1 },
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
    '11.1': { label: 'Data recovery process', ig: 1 },
    '11.2': { label: 'Automated backups', ig: 1 },
    '11.3': { label: 'Protect recovery data', ig: 1 },
    '11.4': { label: 'Isolated copy of recovery data', ig: 1 },
    '11.5': { label: 'Test data recovery', ig: 2 },
    '13.2': { label: 'Host-based intrusion detection', ig: 2 },
    '14.1': { label: 'Security awareness program', ig: 1 },
    '14.2': { label: 'Social-engineering awareness training', ig: 1 },
    '15.1': { label: 'Inventory of service providers', ig: 1 },
    '15.2': { label: 'Service provider management policy', ig: 2 },
    '17.1': { label: 'Named incident-handling personnel', ig: 1 },
    '17.2': { label: 'Incident reporting contacts kept current', ig: 1 },
    '17.3': { label: 'Process for reporting incidents', ig: 1 },
    '18.1': { label: 'Penetration testing program', ig: 2 },
    '18.2': { label: 'Periodic external penetration tests', ig: 2 },
  },
  essential_eight: {
    // framework completeness; no Breeze control maps here yet
    application_control: { label: 'Application control' },
    // framework completeness; no Breeze control maps here yet
    patch_applications: { label: 'Patch applications' },
    // framework completeness; no Breeze control maps here yet
    macro_settings: { label: 'Configure Microsoft Office macro settings' },
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
    'GV.SC-04': { label: 'Suppliers known and prioritized by criticality' },
    'ID.AM-07': { label: 'Data inventories maintained' },
    'ID.RA-01': { label: 'Asset vulnerabilities identified and recorded' },
    'ID.IM-04': { label: 'Incident response plans maintained' },
    'PR.AA-01': { label: 'Identities and credentials managed' },
    'PR.AA-03': { label: 'Users and services authenticated' },
    'PR.AA-05': { label: 'Least-privilege access' },
    'PR.AT-01': { label: 'Personnel given security awareness training' },
    'PR.DS-01': { label: 'Data-at-rest protected' },
    'PR.DS-11': { label: 'Backups created, protected and tested' },
    'PR.IR-01': { label: 'Networks protected from unauthorized access' },
    'PR.PS-01': { label: 'Configuration management practices' },
    'PR.PS-02': { label: 'Software maintained and patched' },
    'DE.CM-09': { label: 'Computing hardware and software monitored' },
    'RS.MA-01': { label: 'Incident response plan executed' },
    'RC.RP-01': { label: 'Recovery plan executed' },
  },
};
