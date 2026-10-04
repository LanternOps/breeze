/**
 * Diagnostic read grants — path form, default restriction and sensitive-store
 * classification.
 *
 * The agent carries an identical classifier
 * (agent/internal/remote/tools/diagaccess_classify.go); both are pinned by the
 * shared fixture agent/internal/remote/tools/testdata/diagnostic_path_classes.json.
 * Change one, change both, extend the fixture.
 */
import { isBlockedPath } from '../aiToolSchemas';

export const SENSITIVE_CLASSES = ['browser_secrets', 'credential_store', 'private_keys', 'session_tokens'] as const;
export type SensitiveClass = (typeof SENSITIVE_CLASSES)[number];

export const SENSITIVE_CLASS_LABELS: Record<SensitiveClass, string> = {
  browser_secrets: 'Browser passwords, cookies and their encryption keys',
  credential_store:
    'Operating-system credential stores (registry hives, DPAPI keys, Credential Manager, Windows Hello, keychains and keyrings, /etc/shadow, Kerberos keytabs, local directory password hashes, unattend files, Group Policy preference files)',
  private_keys: 'Private keys (SSH user and host keys, GnuPG, TLS key files, Windows key containers)',
  session_tokens:
    'Stored session tokens and cloud credentials (.aws, .kube, .env, git credentials, Kerberos ticket caches, browser web storage, shell and PowerShell command history)',
};

const HARD_DENIED_FRAGMENTS = [
  '/programdata/breeze',
  '/etc/breeze',
  '/library/application support/breeze',
  // Linux agent state and runtime sockets live outside /etc/breeze.
  '/var/lib/breeze',
  '/var/run/breeze',
  '/run/breeze',
];

const CLASS_FRAGMENTS: Record<SensitiveClass, string[]> = {
  credential_store: [
    '/windows/system32/config',
    '/windows/ntds',
    '/windows/system32/microsoft/protect',
    '/appdata/roaming/microsoft/credentials',
    '/appdata/local/microsoft/credentials',
    '/appdata/roaming/microsoft/protect',
    '/appdata/roaming/microsoft/vault',
    '/appdata/local/microsoft/vault',
    '/programdata/microsoft/crypto',
    '/etc/shadow',
    '/etc/gshadow',
    '/etc/sudoers',
    '/etc/sudoers.d',
    '/etc/master.passwd',
    '/etc/krb5.keytab',
    '/library/keychains',
    // macOS local directory: user records with password hashes.
    '/var/db/dslocal',
    // GNOME keyring / KWallet.
    '/.local/share/keyrings',
    '/.local/share/kwalletd',
    // Windows Hello (NGC) key and PIN containers.
    '/appdata/local/microsoft/ngc',
    // Setup answer files can carry the local administrator password.
    '/windows/panther',
    '/windows/system32/sysprep',
    // Group Policy preferences (Groups.xml cpassword): SYSVOL on a domain
    // controller and the client-side history cache.
    '/windows/sysvol',
    '/programdata/microsoft/group policy/history',
  ],
  private_keys: [
    '/.ssh',
    '/.gnupg',
    '/etc/ssl/private',
    // Windows per-user key containers (CAPI RSA/DSS, CNG) and the personal
    // certificate store that points at them.
    '/appdata/roaming/microsoft/crypto',
    '/appdata/local/microsoft/crypto',
    '/appdata/roaming/microsoft/systemcertificates',
  ],
  session_tokens: [
    '/.aws',
    '/.kube',
    '/.docker/config.json',
    '/.azure',
    '/.config/gcloud',
    // Browser and Electron-app web storage (Chromium, Edge, Teams, Slack, ...;
    // Firefox profile storage): sites keep session and refresh tokens here.
    '/local storage',
    '/session storage',
    '/indexeddb',
    '/service worker',
    '/storage/default',
    // Windows account token caches (WAM / AAD broker).
    '/appdata/local/microsoft/tokenbroker',
    '/appdata/local/microsoft/identitycache',
    '/appdata/local/packages/microsoft.aad.brokerplugin_cw5n1h2txyewy',
    // PowerShell command history (typed secrets, connection strings).
    '/appdata/roaming/microsoft/windows/powershell/psreadline',
  ],
  // macOS: ~/Library/Cookies and the Safari container's Library/Cookies.
  browser_secrets: ['/library/cookies'],
};

const CLASS_BASENAMES: Record<string, SensitiveClass> = {
  'login data': 'browser_secrets',
  'login data for account': 'browser_secrets',
  cookies: 'browser_secrets',
  'local state': 'browser_secrets',
  'web data': 'browser_secrets',
  'key4.db': 'browser_secrets',
  'logins.json': 'browser_secrets',
  'signons.sqlite': 'browser_secrets',
  'cookies.sqlite': 'browser_secrets',
  // Legacy IE / Edge (EdgeHTML) cache and cookie store (ESE).
  'webcachev01.dat': 'browser_secrets',
  'webappsstore.sqlite': 'session_tokens',
  '.git-credentials': 'session_tokens',
  '.env': 'session_tokens',
  '.netrc': 'session_tokens',
  '.bash_history': 'session_tokens',
  '.zsh_history': 'session_tokens',
  '.sh_history': 'session_tokens',
  '.psql_history': 'session_tokens',
  '.mysql_history': 'session_tokens',
  'consolehost_history.txt': 'session_tokens',
  'unattend.xml': 'credential_store',
  'autounattend.xml': 'credential_store',
  'sysprep.inf': 'credential_store',
  // Group Policy preference file carrying cpassword, wherever it was copied.
  'groups.xml': 'credential_store',
};

/** Names that are credential material by prefix (host keys, ticket caches). */
const CLASS_BASENAME_PREFIXES: Record<string, SensitiveClass> = {
  ssh_host_: 'private_keys',
  krb5cc_: 'session_tokens',
};

const CLASS_EXTENSIONS: Record<string, SensitiveClass> = {
  '.pem': 'private_keys',
  '.key': 'private_keys',
  '.pfx': 'private_keys',
  '.p12': 'private_keys',
  '.ppk': 'private_keys',
  '.keychain': 'credential_store',
  '.keychain-db': 'credential_store',
  '.binarycookies': 'browser_secrets',
};

/** Separator/case fold used for classification (and the agent's copy). */
export function normalizeDiagnosticPath(p: string): string {
  let norm = p.replace(/\\/g, '/').toLowerCase();
  if (norm.length >= 2 && norm[1] === ':') norm = norm.slice(2);
  while (norm.includes('//')) norm = norm.replace(/\/\//g, '/');
  if (norm.length > 1 && norm.endsWith('/')) norm = norm.slice(0, -1);
  return norm === '' ? '/' : norm;
}

function matchesFragment(norm: string, frag: string): boolean {
  return norm === frag || norm.endsWith(frag) || norm.includes(`${frag}/`);
}

export type DiagnosticPathClassification = {
  /** Never grantable (the agent's own configuration and credentials). */
  hardDenied: boolean;
  /** Sensitive classes this location falls in (sorted). */
  classes: SensitiveClass[];
  /** Refused by the default AI path restriction without a grant. */
  restricted: boolean;
};

export function classifyDiagnosticPath(p: string): DiagnosticPathClassification {
  const norm = normalizeDiagnosticPath(p);
  const restricted = isBlockedPath(p);
  if (HARD_DENIED_FRAGMENTS.some((f) => matchesFragment(norm, f))) {
    return { hardDenied: true, classes: [], restricted };
  }
  const found = new Set<SensitiveClass>();
  for (const cls of SENSITIVE_CLASSES) {
    if (CLASS_FRAGMENTS[cls].some((f) => matchesFragment(norm, f))) found.add(cls);
  }
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  // SQLite/ESE sidecars (Cookies-journal, Login Data-wal, ...) hold the same
  // pages as the database they belong to.
  const byName = CLASS_BASENAMES[base] ?? CLASS_BASENAMES[base.replace(/-(journal|wal|shm)$/, '')];
  if (byName) found.add(byName);
  for (const [prefix, cls] of Object.entries(CLASS_BASENAME_PREFIXES)) {
    if (base.startsWith(prefix)) found.add(cls);
  }
  for (const [ext, cls] of Object.entries(CLASS_EXTENSIONS)) {
    if (base.endsWith(ext) && base.length > ext.length) found.add(cls);
  }
  return { hardDenied: false, classes: SENSITIVE_CLASSES.filter((c) => found.has(c)), restricted };
}

/**
 * Structural path check shared by the grant request and the file tools:
 * absolute, no `.`/`..` segments, no control characters, no UNC / device /
 * namespace prefix, no NTFS stream syntax, no trailing dot/space component.
 * Returns an error message, or null when the path is well formed. This is
 * about the SHAPE of the string only; whether it is allowed is separate.
 */
export function diagnosticPathFormError(p: string): string | null {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return 'path must be 1-4096 characters';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return 'path contains a control character';
  const norm = p.replace(/\\/g, '/');
  if (norm.split('/').some((seg) => seg === '..' || seg === '.')) return 'path may not contain . or .. segments';
  if (norm.startsWith('//')) return 'UNC, device and namespace paths are not accepted';
  if (/^[A-Za-z]:/.test(p)) {
    if (!/^[A-Za-z]:[\\/]/.test(p)) return 'Windows paths must be absolute (X:\\...)';
    if (p.slice(2).includes(':')) return 'NTFS stream syntax is not accepted';
    if (norm.slice(3).split('/').some((seg) => seg !== '' && /[. ]$/.test(seg))) {
      return 'path components may not end in a dot or space';
    }
    return null;
  }
  if (!p.startsWith('/')) return 'path must be absolute';
  return null;
}

/**
 * Grant roots must name a folder at least this many levels below the volume
 * root: `C:\`, `/`, `C:\Users` and `/home` are too broad to review.
 */
export const MIN_DIAGNOSTIC_SCOPE_DEPTH = 2;

/** Number of path components below the volume root (`C:\A\B` and `/a/b` are 2). */
export function diagnosticPathDepth(p: string): number {
  const rest = /^[A-Za-z]:/.test(p) ? p.slice(2) : p;
  return rest.split(/[\\/]/).filter((seg) => seg !== '').length;
}

/** Comparison key: separators to '/', case folded, trailing '/' dropped. */
export function diagnosticPathKey(p: string, caseInsensitive: boolean): string {
  let k = p.replace(/\\/g, '/');
  while (k.includes('//')) k = k.replace(/\/\//g, '/');
  if (caseInsensitive) k = k.toLowerCase();
  if (k.length > 1 && k.endsWith('/')) k = k.slice(0, -1);
  return k;
}

/** Whether target is the root itself / below it, and whether it is a direct child. */
export function diagnosticPathWithin(rootKey: string, targetKey: string): { within: boolean; directChild: boolean } {
  if (targetKey === rootKey) return { within: true, directChild: true };
  const prefix = rootKey.endsWith('/') ? rootKey : `${rootKey}/`;
  if (!targetKey.startsWith(prefix)) return { within: false, directChild: false };
  return { within: true, directChild: !targetKey.slice(prefix.length).includes('/') };
}
