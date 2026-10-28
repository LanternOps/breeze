/**
 * Lower-case word -> display form, for words that read wrong when a code key
 * is humanized word by word ("Slack webhook url", "Sync Edr Data"). Matched
 * against whole words only, so "drive" never becomes "DRive".
 *
 * Shared by `humanizeFieldPath` (apiError.ts, zod field paths) and
 * `formatToolName` (utils.ts, AI tool keys). Add a word here rather than
 * growing a private acronym list next to another formatter.
 */
export const DISPLAY_ACRONYMS: Readonly<Record<string, string>> = {
  ai: 'AI', api: 'API', c2c: 'C2C', cidr: 'CIDR', cis: 'CIS', cve: 'CVE', dns: 'DNS', dr: 'DR',
  edr: 'EDR', html: 'HTML', http: 'HTTP', https: 'HTTPS', hyperv: 'Hyper-V', id: 'ID', ids: 'IDs',
  ioc: 'IOC', iocs: 'IOCs', ip: 'IP', ips: 'IPs', json: 'JSON', m365: 'M365', mfa: 'MFA',
  mssql: 'MSSQL', os: 'OS', pam: 'PAM', psa: 'PSA', rpo: 'RPO', rto: 'RTO', sla: 'SLA', sms: 'SMS',
  smtp: 'SMTP', snmp: 'SNMP', ssh: 'SSH', ssl: 'SSL', sso: 'SSO', tls: 'TLS', totp: 'TOTP',
  ttl: 'TTL', unifi: 'UniFi', uri: 'URI', url: 'URL', urls: 'URLs', vm: 'VM', vms: 'VMs', vpn: 'VPN',
};
