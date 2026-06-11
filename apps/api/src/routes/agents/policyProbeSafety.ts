const REDACTED_POLICY_CONFIG_VALUE = '[redacted]';

const ALLOWED_CONFIG_KEYS_BY_PATH = new Map<string, Set<string>>([
  ['/etc/ssh/sshd_config', new Set([
    'allowtcpforwarding',
    'challengeresponseauthentication',
    'clientalivecountmax',
    'clientaliveinterval',
    'kbdinteractiveauthentication',
    'logingracetime',
    'maxauthtries',
    'passwordauthentication',
    'permitrootlogin',
    'protocol',
    'pubkeyauthentication',
    'usepam',
    'x11forwarding',
  ])],
  ['/etc/login.defs', new Set([
    'encrypt_method',
    'pass_max_days',
    'pass_min_days',
    'pass_warn_age',
    'uid_max',
    'uid_min',
    'umask',
  ])],
  ['/etc/audit/auditd.conf', new Set([
    'admin_space_left_action',
    'disk_error_action',
    'disk_full_action',
    'max_log_file',
    'max_log_file_action',
    'space_left_action',
  ])],
]);

const ALLOWED_SYSCTL_CONFIG_KEYS = new Set([
  'fs.protected_hardlinks',
  'fs.protected_symlinks',
  'kernel.dmesg_restrict',
  'kernel.kptr_restrict',
  'kernel.randomize_va_space',
  'net.ipv4.conf.all.accept_redirects',
  'net.ipv4.conf.all.log_martians',
  'net.ipv4.conf.all.rp_filter',
  'net.ipv4.conf.all.secure_redirects',
  'net.ipv4.conf.default.accept_redirects',
  'net.ipv4.conf.default.log_martians',
  'net.ipv4.conf.default.rp_filter',
  'net.ipv4.conf.default.secure_redirects',
  'net.ipv4.ip_forward',
  'net.ipv4.tcp_syncookies',
  'net.ipv6.conf.all.accept_redirects',
  'net.ipv6.conf.all.disable_ipv6',
  'net.ipv6.conf.default.accept_redirects',
  'net.ipv6.conf.default.disable_ipv6',
]);

function normalizePolicyConfigPath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!trimmed.startsWith('/')) return '';
  const parts: string[] = [];
  for (const part of trimmed.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return '';
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function normalizePolicyConfigKey(value: string): string {
  return value.trim().toLowerCase();
}

export function isSensitivePolicyConfigKey(configKey: string): boolean {
  const normalized = normalizePolicyConfigKey(configKey).replace(/[\s.-]+/g, '_');
  if (['password', 'passwd', 'pwd', 'secret', 'token', 'bearer', 'credential'].includes(normalized)) {
    return true;
  }
  return normalized.includes('api_key')
    || normalized.includes('apikey')
    || normalized.includes('access_key')
    || normalized.includes('private_key')
    || normalized.includes('client_secret')
    || normalized.includes('auth_token')
    || normalized.endsWith('token')
    || normalized.endsWith('secret');
}

export function isAllowedPolicyConfigProbe(filePath: string, configKey: string): boolean {
  const normalizedPath = normalizePolicyConfigPath(filePath);
  const normalizedKey = normalizePolicyConfigKey(configKey);
  if (!normalizedPath || !normalizedKey || isSensitivePolicyConfigKey(normalizedKey)) {
    return false;
  }

  const exactKeys = ALLOWED_CONFIG_KEYS_BY_PATH.get(normalizedPath);
  if (exactKeys?.has(normalizedKey)) {
    return true;
  }

  const sysctlPathAllowed = normalizedPath === '/etc/sysctl.conf'
    || (normalizedPath.startsWith('/etc/sysctl.d/') && normalizedPath.endsWith('.conf'));
  return sysctlPathAllowed && ALLOWED_SYSCTL_CONFIG_KEYS.has(normalizedKey);
}

export function redactSensitivePolicyConfigValue(
  configKey: string,
  value: IncomingPolicyConfigStateEntry['configValue']
): IncomingPolicyConfigStateEntry['configValue'] {
  return isSensitivePolicyConfigKey(configKey) ? REDACTED_POLICY_CONFIG_VALUE : value;
}

export type IncomingPolicyConfigStateEntry = {
  filePath: string;
  configKey: string;
  configValue?: string | number | boolean | null;
  collectedAt?: string;
};

export function sanitizePolicyConfigStateEntries<T extends IncomingPolicyConfigStateEntry>(entries: T[]): T[] {
  return entries.flatMap((entry) => {
    const filePath = normalizePolicyConfigPath(entry.filePath);
    const configKey = entry.configKey.trim();
    if (!isAllowedPolicyConfigProbe(filePath, configKey)) {
      return [];
    }

    return [{
      ...entry,
      filePath,
      configKey,
      configValue: redactSensitivePolicyConfigValue(configKey, entry.configValue),
    } as T];
  });
}
