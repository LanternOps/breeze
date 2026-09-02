import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === 'object'
      ? flattenKeys(value as Record<string, unknown>, path)
      : [path];
  });
}

type LeafValues = Map<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function flattenValues(
  obj: Record<string, unknown>,
  prefix = '',
  result: LeafValues = new Map(),
): LeafValues {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value)) {
      flattenValues(value, path, result);
    } else {
      result.set(path, value);
    }
  }
  return result;
}

function interpolationTokens(value: string): string[] {
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)]
    .map((match) => match[1])
    .sort();
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function leafTypeErrors(reference: LeafValues, target: LeafValues): string[] {
  const errors: string[] = [];
  for (const [key, english] of reference) {
    const translated = target.get(key);
    if (typeof english !== 'string') {
      errors.push(
        `${key}: English leaf must be a string; received ${valueType(english)}`,
      );
    }
    if (typeof translated !== 'string') {
      errors.push(
        `${key}: target leaf must be a string; received ${valueType(translated)}`,
      );
    } else if (typeof english !== typeof translated) {
      errors.push(
        `${key}: target leaf type ${valueType(translated)} differs from English ${valueType(english)}`,
      );
    }
  }
  return errors;
}

function richTextTags(value: string): string[] {
  return [...value.matchAll(/<(\/?)(([A-Za-z][A-Za-z0-9_-]*)|\d+)(?:\s[^<>]*?)?(\/?)>/g)]
    .map((match) => {
      const kind = match[1] ? 'close' : match[4] ? 'self' : 'open';
      return `${kind}:${match[2]}`;
    })
    .sort();
}

function richTextContractErrors(reference: LeafValues, target: LeafValues): string[] {
  const errors: string[] = [];
  for (const [key, english] of reference) {
    const translated = target.get(key);
    if (typeof english !== 'string' || typeof translated !== 'string') continue;
    const expected = richTextTags(english);
    const received = richTextTags(translated);
    if (expected.join('\0') !== received.join('\0')) {
      errors.push(
        `${key}: rich-text tags differ (expected ${expected.join(', ')}; received ${received.join(', ')})`,
      );
    }
  }
  return errors;
}

// Reviewed product/vendor/technology names that are intentionally identical in
// every locale. Longer names coexist with their shorter brand name on purpose:
// both the complete product name and the underlying brand casing are guarded.
const protectedNames = [
  'AdGuard Home',
  'AnyDesk',
  'Apple',
  'AppleCare',
  'AWS OpenSearch Service',
  'Azure AD',
  'BitLocker',
  'Breeze AI for Office',
  'Breeze Portal',
  'Breeze RMM',
  'Breeze',
  'Cisco Umbrella',
  'CIS Benchmarks',
  'Cloudflare Gateway',
  'CrowdStrike Falcon',
  'Discord',
  'DNSFilter',
  'Elasticsearch',
  'Entra ID',
  'FileVault',
  'Gatekeeper',
  'Google Chrome',
  'Google Workspace',
  'Gmail',
  'Homebrew',
  'Huntress',
  'Microsoft 365',
  'Microsoft Edge',
  'Microsoft Entra ID',
  'Microsoft Graph',
  'Microsoft Intune',
  'Microsoft Teams',
  'Microsoft-Windows-Security-Auditing',
  'OneDrive',
  'OpenDNS',
  'OpenSearch',
  'Pi-hole',
  'PowerShell',
  'Pushover',
  'Python',
  'Quad9',
  'RustDesk',
  'ScreenConnect',
  'SharePoint',
  'Slack',
  'Sentry',
  'Stripe',
  'TeamViewer',
  'Thunderbolt',
  'UniFi',
  'Wazuh',
  'WebRTC',
  'Windows Defender',
  'Windows Firewall',
  'Windows Hello',
  'Windows Sandbox',
  'Windows Security',
  'Windows Server',
  'Windows Update',
  'Windows',
  'XProtect',
  'macOS',
  'winget',
  'Auth0',
  'Plus Jakarta Sans',
  'API',
  'DNS',
  'IP',
  'MSP',
  'RMM',
  'SLA',
  'SNMP',
] as const;

const protectedCommands = [
  'breeze-backup bmr-recover --token <token> --server <api-server>',
  'breeze-agent enroll',
  'msiexec /i "{file}" /qn /norestart',
  'msiexec /x "{file}" /qn /norestart',
  'systemctl restart nginx',
] as const;

function matches(value: string, pattern: RegExp): string[] {
  return [...value.matchAll(pattern)].map((match) => match[0]);
}

function nameOccurrences(value: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const leadingBoundary = /^\w/.test(name) ? '(?<![A-Za-z0-9_])' : '';
  const trailingBoundary = /\w$/.test(name) ? '(?![A-Za-z0-9_])' : '';
  return matches(
    value,
    new RegExp(`${leadingBoundary}${escaped}${trailingBoundary}`, 'g'),
  ).length;
}

function technicalLiteralOccurrences(value: string, literal: string): number {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return matches(
    value,
    new RegExp(
      `(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_.-])`,
      'g',
    ),
  ).length;
}

function protectedTokens(value: string): string[] {
  const tokens: string[] = [];
  const addMatches = (category: string, pattern: RegExp) => {
    for (const match of matches(value, pattern)) tokens.push(`${category}:${match}`);
  };

  addMatches('inline-code', /`[^`\n]+`/g);
  addMatches('code-tag', /(?<=<code>)[\s\S]*?(?=<\/code>)/g);
  addMatches('url', /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi);
  addMatches('cli-flag', /(?<![\w-])--[a-z][a-z0-9-]*/gi);
  addMatches('env', /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g);
  addMatches('http-method', /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g);
  addMatches(
    'payload-literal',
    /\b(?:undefined|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g,
  );
  addMatches('architecture', /\b(?:amd64|arm64|x86|x86_64|x64)\b/g);
  addMatches(
    'region',
    /\b(?:af|ap|ca|eu|me|sa|us)-(?:central|east|north|northeast|northwest|south|southeast|southwest|west)-\d\b/g,
  );
  addMatches('registry', /\b(?:HKLM|HKCU|HKEY_[A-Z_]+)\\[^\s,;)'"}]+/g);
  addMatches(
    'registry',
    /\b(?:SOFTWARE|SYSTEM)\\+[A-Za-z0-9_.-]+(?:\\+[A-Za-z0-9_.-]+)+/g,
  );
  addMatches(
    'windows-path',
    /\b[A-Za-z]:\\+(?:(?:[^\\\r\n,;()'"}]+\\+)+(?:[^\s\\,;()'"}]+)?|[^\s\\,;()'"}]+)/g,
  );
  addMatches(
    'unc-path',
    /(?<![A-Za-z0-9:\\])\\\\[A-Za-z0-9_.-]+\\[^\s,;)'"}]+/g,
  );
  addMatches('unix-path', /\/(?:etc|var|home|opt|usr|tmp|Library|Applications)\/[^\s,;)'"}]*/g);
  addMatches(
    'relative-endpoint',
    /\/[A-Za-z0-9][A-Za-z0-9/_-]*\?[A-Za-z0-9_{}%=&.-]+/g,
  );
  addMatches(
    'filename',
    /\b[\w.-]+\.(?:conf|config|crt|db|deb|dll|dmg|exe|json|key|log|msi|pem|pkg|png|jpe?g|ps1|sh|svg|ya?ml|zip)(?![\w.-])/gi,
  );
  addMatches('template-token', /(?<!\{)\{[A-Za-z_][\w.-]*\}(?!\})/g);
  for (const name of protectedNames) {
    for (let index = 0; index < nameOccurrences(value, name); index += 1) {
      tokens.push(`name:${name}`);
    }
  }
  for (const command of protectedCommands) {
    for (
      let index = 0;
      index < technicalLiteralOccurrences(value, command);
      index += 1
    ) {
      tokens.push(`command:${command}`);
    }
  }
  return tokens.sort();
}

function protectedLiteralContractErrors(
  reference: LeafValues,
  target: LeafValues,
): string[] {
  const errors: string[] = [];
  for (const [key, english] of reference) {
    const translated = target.get(key);
    if (typeof english !== 'string' || typeof translated !== 'string') continue;
    const countTokens = (value: string) => {
      const counts = new Map<string, number>();
      for (const token of protectedTokens(value)) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
      return counts;
    };
    const expectedCounts = countTokens(english);
    const receivedCounts = countTokens(translated);
    const mismatches = [...expectedCounts].flatMap(([token, expectedCount]) => {
      const receivedCount = receivedCounts.get(token) ?? 0;
      return receivedCount === expectedCount
        ? []
        : [`${token} expected ${expectedCount}, received ${receivedCount}`];
    });
    if (mismatches.length > 0) {
      errors.push(
        `${key}: protected literal occurrence mismatch (${mismatches.join('; ')})`,
      );
    }
  }
  return errors;
}

// Values that are *entirely* one slash-prefixed token are almost always a URL
// path, an API endpoint, or a filesystem path that the code depends on
// verbatim. Shipping one as a translatable string means a single translator
// edit silently breaks the feature in that locale only, at runtime, with no
// type or test error (issue #3426). Inline such a value as a literal in the
// component instead.
//
// The exceptions are genuine display copy that happens to start with a slash:
// the per-unit price suffixes and one separator glyph. They are exempted by
// KEY rather than by value, because those values are themselves localized
// (`/mo` → `/mois` → `/ay`) — a value allowlist could only ever hold for `en`.
// Keeping the exemption list short and explicit means a new route path cannot
// sneak in under a permissive regex.
const pathLikeValueExemptKeys = new Set([
  'billing.json:billingUi.units.perMonth',
  'billing.json:billingUi.units.perYear',
  'billing.json:quotes.editor.units.perMonth',
  'billing.json:quotes.editor.units.perYear',
]);

function isBarePathValue(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) return false;
  // Anything containing whitespace is prose that mentions a path, not a bare
  // path value; the protected-literal contract above already pins those.
  return !/\s/.test(trimmed);
}

function routePathValueErrors(values: LeafValues, namespace: string): string[] {
  const errors: string[] = [];
  for (const [key, value] of values) {
    if (pathLikeValueExemptKeys.has(`${namespace}:${key}`)) continue;
    // `flattenValues` stops at arrays, so an array leaf must be scanned
    // element-wise or a bare path hidden in a list slips through untouched.
    const candidates: [string, unknown][] = Array.isArray(value)
      ? value.map((entry, index) => [`${key}[${index}]`, entry])
      : [[key, value]];
    for (const [label, candidate] of candidates) {
      if (!isBarePathValue(candidate)) continue;
      errors.push(
        `${label}: value ${JSON.stringify(candidate.trim())} looks like a route or filesystem path; ` +
          'inline it as a literal in the component instead of translating it',
      );
    }
  }
  return errors;
}

// A locale value reaches the DOM either as a React text node (plain `t()`) or
// through <Trans>'s markup parser. React text-escapes the leading `&`, and
// react-i18next does NOT decode entities inside <Trans> either — so an HTML
// entity written into a JSON value can never decode in *any* render path (Trans
// unescapes only under `shouldUnescape`, which this app never enables — see
// `index.ts`). It always reaches the user as the literal source text
// ("&ldquo;", "&times;").
// Author the character itself instead: “ ” × — a real \n, U+00A0 for &nbsp;.
// Regression guard for #3964.
const htmlEntityPattern = /&(?:[a-zA-Z][a-zA-Z0-9]{1,9}|#(?:[0-9]{2,5}|[xX][0-9a-fA-F]{2,4}));/;

function htmlEntityValueErrors(values: LeafValues, namespace: string): string[] {
  const errors: string[] = [];
  // `flattenValues` stops at arrays, so a container leaf has to be walked here
  // or an entity nested inside one is never scanned. Recurse rather than only
  // mapping array elements: an array of objects hides its strings a level down.
  const visit = (label: string, node: unknown): void => {
    if (typeof node === 'string') {
      const match = node.match(htmlEntityPattern);
      if (match) {
        errors.push(
          `${label}: value contains the HTML entity ${JSON.stringify(match[0])}, ` +
            'which renders literally; use the character itself instead',
        );
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(`${label}[${index}]`, entry));
      return;
    }
    if (isRecord(node)) {
      for (const [key, entry] of Object.entries(node)) visit(`${label}.${key}`, entry);
    }
  };

  for (const [key, value] of values) visit(key, value);
  return errors;
}

function readNamespaces(locale: string): Map<string, string[]> {
  const dir = join(localesDir, locale);
  return new Map(
    readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => [
        file,
        flattenKeys(JSON.parse(readFileSync(join(dir, file), 'utf8'))).sort(),
      ])
  );
}

function readNamespaceValues(locale: string): Map<string, LeafValues> {
  const dir = join(localesDir, locale);
  return new Map(
    readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => [
        file,
        flattenValues(JSON.parse(readFileSync(join(dir, file), 'utf8'))),
      ]),
  );
}

describe('locale parity', () => {
  const locales = readdirSync(localesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const reference = readNamespaces('en');
  const referenceValues = readNamespaceValues('en');

  it('contains every supported locale catalog', () => {
    expect(locales).toEqual(
      expect.arrayContaining(['en', 'pt-BR', 'es-419', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT', 'tr-TR']),
    );
  });

  for (const locale of locales) {
    it(`${locale} spells characters out instead of leaving HTML entities`, () => {
      const values = locale === 'en' ? referenceValues : readNamespaceValues(locale);
      const errors: string[] = [];
      for (const [namespace, leaves] of values) {
        errors.push(
          ...htmlEntityValueErrors(leaves, namespace).map(
            (error) => `${namespace}:${error}`,
          ),
        );
      }
      expect(errors, errors.join('\n')).toEqual([]);
    });

    it(`${locale} carries no route or filesystem path as a translatable value`, () => {
      const values = locale === 'en' ? referenceValues : readNamespaceValues(locale);
      const errors: string[] = [];
      for (const [namespace, leaves] of values) {
        errors.push(
          ...routePathValueErrors(leaves, namespace).map(
            (error) => `${namespace}:${error}`,
          ),
        );
      }
      expect(errors, errors.join('\n')).toEqual([]);
    });
  }

  for (const locale of locales.filter((value) => value !== 'en')) {
    it(`${locale} matches en namespace files and keys exactly`, () => {
      const target = readNamespaces(locale);
      expect([...target.keys()].sort()).toEqual([...reference.keys()].sort());
      for (const [namespace, keys] of reference) {
        expect(target.get(namespace), `namespace ${namespace}`).toEqual(keys);
      }
    });

    it(`${locale} preserves interpolation variables`, () => {
      const targetValues = readNamespaceValues(locale);
      for (const [namespace, values] of referenceValues) {
        for (const [key, english] of values) {
          if (typeof english !== 'string') continue;
          const translated = targetValues.get(namespace)?.get(key);
          expect(
            interpolationTokens(typeof translated === 'string' ? translated : ''),
            `${namespace}:${key}`,
          ).toEqual(interpolationTokens(english));
        }
      }
    });

    it(`${locale} contains only string leaves matching English leaf types`, () => {
      const targetValues = readNamespaceValues(locale);
      const errors: string[] = [];
      for (const [namespace, values] of referenceValues) {
        errors.push(
          ...leafTypeErrors(values, targetValues.get(namespace) ?? new Map()).map(
            (error) => `${namespace}:${error}`,
          ),
        );
      }
      expect(errors, errors.join('\n')).toEqual([]);
    });

    it(`${locale} preserves rich-text placeholder tag multisets`, () => {
      const targetValues = readNamespaceValues(locale);
      const errors: string[] = [];
      for (const [namespace, values] of referenceValues) {
        errors.push(
          ...richTextContractErrors(
            values,
            targetValues.get(namespace) ?? new Map(),
          ).map((error) => `${namespace}:${error}`),
        );
      }
      expect(errors, errors.join('\n')).toEqual([]);
    });

    // pt-BR predates the reviewed literal baseline introduced with these three
    // catalogs; extend this check there after its next native/literal audit.
    if (locale !== 'pt-BR') {
      // This check brute-forces ~70 protected-name regexes over every leaf in
      // every namespace (~1.3s locally); a loaded CI runner can push it past
      // Vitest's 5s default and time out. Give it explicit headroom — the
      // assertion is unchanged, it just needs more wall-clock.
      it(`${locale} preserves source-aligned technical literals and names`, () => {
        const targetValues = readNamespaceValues(locale);
        const errors: string[] = [];
        for (const [namespace, values] of referenceValues) {
          errors.push(
            ...protectedLiteralContractErrors(
              values,
              targetValues.get(namespace) ?? new Map(),
            ).map((error) => `${namespace}:${error}`),
          );
        }
        expect(errors, errors.join('\n')).toEqual([]);
      }, 30000);
    }
  }
});

describe('locale parity guard helpers', () => {
  it('rejects a translated leaf whose type differs from English', () => {
    expect(
      leafTypeErrors(
        new Map([['actions.save', 'Save']]),
        new Map([['actions.save', false]]),
      ),
    ).toEqual([
      'actions.save: target leaf must be a string; received boolean',
    ]);
  });

  it('rejects a leaf carrying an HTML entity', () => {
    expect(
      htmlEntityValueErrors(
        new Map([
          ['suppress.howLong', 'How long should &ldquo;'],
          ['patch.close', '&times;'],
          ['scan.placeholder', 'device-uuid-1&#10;device-uuid-2'],
        ]),
        'alerts.json',
      ),
    ).toEqual([
      'suppress.howLong: value contains the HTML entity "&ldquo;", which renders literally; use the character itself instead',
      'patch.close: value contains the HTML entity "&times;", which renders literally; use the character itself instead',
      'scan.placeholder: value contains the HTML entity "&#10;", which renders literally; use the character itself instead',
    ]);
  });

  it('finds an entity nested inside a container leaf', () => {
    expect(
      htmlEntityValueErrors(
        new Map([['wizard.steps', [{ label: 'Pick a device' }, { label: 'Confirm &amp; run' }]]]),
        'devices.json',
      ),
    ).toEqual([
      'wizard.steps[1].label: value contains the HTML entity "&amp;", which renders literally; use the character itself instead',
    ]);
  });

  it('accepts an ampersand that is not an entity', () => {
    expect(
      htmlEntityValueErrors(
        new Map([
          ['reports.title', 'Research & Development'],
          ['filters.andOr', 'AND / OR'],
          ['suppress.howLong', 'How long should \u201c'],
        ]),
        'reports.json',
      ),
    ).toEqual([]);
  });

  it('rejects changed rich-text placeholder tags', () => {
    expect(
      richTextContractErrors(
        new Map([['delete.confirm', 'Delete <strong>{{name}}</strong>?']]),
        new Map([['delete.confirm', 'Supprimer <b>{{name}}</b> ?']]),
      ),
    ).toEqual([
      'delete.confirm: rich-text tags differ (expected close:strong, open:strong; received close:b, open:b)',
    ]);
  });

  it('rejects bare route, endpoint, and filesystem path values', () => {
    expect(
      routePathValueErrors(
        new Map([
          ['page.route', '/configuration-policies'],
          ['tab.endpoint', '/scripts?limit=200'],
          ['field.example', '/etc/ssh/sshd_config'],
        ]),
        'policies.json',
      ),
    ).toEqual([
      'page.route: value "/configuration-policies" looks like a route or filesystem path; inline it as a literal in the component instead of translating it',
      'tab.endpoint: value "/scripts?limit=200" looks like a route or filesystem path; inline it as a literal in the component instead of translating it',
      'field.example: value "/etc/ssh/sshd_config" looks like a route or filesystem path; inline it as a literal in the component instead of translating it',
    ]);
  });

  it('exempts reviewed unit-suffix keys in every locale, not just English', () => {
    for (const localized of ['/mo', '/mois', '/ay', '/Jahr']) {
      expect(
        routePathValueErrors(
          new Map([['billingUi.units.perMonth', localized]]),
          'billing.json',
        ),
      ).toEqual([]);
    }
  });

  it('allows prose that mentions a path and non-path leaves', () => {
    expect(
      routePathValueErrors(
        new Map<string, unknown>([
          ['backup.desc', '/home and /etc with caches excluded.'],
          ['branding.css', '/* Custom CSS */'],
          ['actions.save', 'Save'],
          ['count.total', 12],
        ]),
        'backup.json',
      ),
    ).toEqual([]);
  });

  it('scans array leaves element-wise so a listed path cannot hide', () => {
    expect(
      routePathValueErrors(
        new Map<string, unknown>([
          ['tab.examples', ['Pick a page', '/configuration-policies']],
        ]),
        'policies.json',
      ),
    ).toEqual([
      'tab.examples[1]: value "/configuration-policies" looks like a route or filesystem path; inline it as a literal in the component instead of translating it',
    ]);
  });

  it('does not exempt an unreviewed key that borrows an exempt name', () => {
    expect(
      routePathValueErrors(
        new Map([['billingUi.units.perMonth', '/mo']]),
        'policies.json',
      ),
    ).toHaveLength(1);
  });

  it('extracts reviewed names and operational literals source-aligned', () => {
    expect(
      protectedTokens(
        'Run `python task.py` with Python, AppleCare, and Microsoft Teams at https://example.com using --dry-run.',
      ),
    ).toEqual(
      expect.arrayContaining([
        'cli-flag:--dry-run',
        'inline-code:`python task.py`',
        'name:AppleCare',
        'name:Microsoft Teams',
        'name:Python',
        'url:https://example.com',
      ]),
    );
  });

  it.each([
    ['repeated product name', 'Python and Python', 'Python', 'name:Python', 2, 1],
    [
      'spaced Windows path',
      'C:\\Program Files\\Vendor\\App\\app.exe',
      'C:\\Program Files\\Fournisseur\\App\\app.exe',
      'windows-path:C:\\Program Files\\Vendor\\App\\app.exe',
      1,
      0,
    ],
    [
      'hive-less registry path',
      'SOFTWARE\\Vendor\\App',
      'SOFTWARE\\Fournisseur\\App',
      'registry:SOFTWARE\\Vendor\\App',
      1,
      0,
    ],
    ['architecture casing', 'arm64', 'ARM64', 'architecture:arm64', 1, 0],
    ['Azure AD product name', 'Azure AD', 'Azure Active Directory', 'name:Azure AD', 1, 0],
    ['Entra ID product name', 'Entra ID', 'ID Entra', 'name:Entra ID', 1, 0],
    ['official AppleCare product name', 'AppleCare', 'Apple Care', 'name:AppleCare', 1, 0],
    [
      'command',
      'systemctl restart nginx',
      'systemctl redémarrer nginx',
      'command:systemctl restart nginx',
      1,
      0,
    ],
    [
      'URL',
      'https://api.example.com/alerts',
      'https://api.exemple.fr/alertes',
      'url:https://api.example.com/alerts',
      1,
      0,
    ],
    ['payload literal', 'rustdesk_id', 'id_rustdesk', 'payload-literal:rustdesk_id', 1, 0],
    ['filename', 'Thumbs.db', 'Miniatures.db', 'filename:Thumbs.db', 1, 0],
    [
      'URL suffix',
      'https://api.example.com/alerts',
      'https://api.example.com/alerts-old',
      'url:https://api.example.com/alerts',
      1,
      0,
    ],
    ['CLI flag suffix', '--dry-run', '--dry-runner', 'cli-flag:--dry-run', 1, 0],
    [
      'environment variable suffix',
      'CLIENT_AI_ENTRA_CLIENT_ID',
      'CLIENT_AI_ENTRA_CLIENT_ID_OLD',
      'env:CLIENT_AI_ENTRA_CLIENT_ID',
      1,
      0,
    ],
    [
      'command suffix',
      'systemctl restart nginx',
      'systemctl restart nginx-old',
      'command:systemctl restart nginx',
      1,
      0,
    ],
    [
      'Windows path suffix',
      'C:\\Program Files\\Vendor\\App\\app.exe',
      'C:\\Program Files\\Vendor\\App\\app.exe.bak',
      'filename:app.exe',
      1,
      0,
      'windows-path:C:\\Program Files\\Vendor\\App\\app.exe expected 1, received 0',
    ],
    [
      'registry suffix',
      'SOFTWARE\\Vendor\\App',
      'SOFTWARE\\Vendor\\App_Old',
      'registry:SOFTWARE\\Vendor\\App',
      1,
      0,
    ],
  ])('rejects a changed %s', (_label, english, translated, token, expected, received, additionalMismatch = undefined) => {
    const errors = protectedLiteralContractErrors(
      new Map([['example', english]]),
      new Map([['example', translated]]),
    );

    expect(errors).toEqual([
      `example: protected literal occurrence mismatch (${token} expected ${expected}, received ${received}${additionalMismatch ? `; ${additionalMismatch}` : ''})`,
    ]);
  });
});
