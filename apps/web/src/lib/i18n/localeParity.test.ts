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
  'breeze-backup bmr-recover --token &lt;token&gt; --server &lt;api-server&gt;',
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
      expect.arrayContaining(['en', 'pt-BR', 'es-419', 'fr-FR', 'fr-CA', 'de-DE', 'it-IT']),
    );
  });

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
