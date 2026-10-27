import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import localeFixture from '../fixtures/prompt-catalog/locale-negotiation.json';
import sanitizeFixture from '../fixtures/prompt-catalog/identity-name-sanitize.json';
import {
  PROMPT_IDENTITY_PROTOCOL_VERSION,
  promptIdentityBlockSchema,
  PROMPT_CATALOG,
  PROMPT_LOCALES,
  PromptCatalogError,
  negotiatePromptLocale,
  promptMessagePlaceholders,
  renderPromptMessage,
  sanitizePromptPartnerName,
  type PromptLocale,
} from './index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = join(__dirname, 'catalog');
// go:embed cannot leave the agent module, so the catalog ships twice; the two
// copies are compared byte-for-byte from BOTH sides (cleanupRules precedent).
const AGENT_CATALOG_DIR = join(__dirname, '../../../../agent/internal/promptcatalog/catalog');

const catalogFiles = readdirSync(CATALOG_DIR).filter((f) => f.endsWith('.json')).sort();

describe('prompt catalog files', () => {
  it('registers every catalog file under its namespace', () => {
    expect(catalogFiles.map((f) => f.replace(/\.json$/, ''))).toEqual(Object.keys(PROMPT_CATALOG).sort());
    for (const file of catalogFiles) {
      const raw = JSON.parse(readFileSync(join(CATALOG_DIR, file), 'utf8'));
      expect(raw.namespace).toBe(file.replace(/\.json$/, ''));
    }
  });

  it('the agent embed copy is byte-identical (fix: cp packages/shared/src/promptCatalog/catalog/*.json agent/internal/promptcatalog/catalog/)', () => {
    const agentFiles = readdirSync(AGENT_CATALOG_DIR).filter((f) => f.endsWith('.json')).sort();
    expect(agentFiles).toEqual(catalogFiles);
    for (const file of catalogFiles) {
      expect(readFileSync(join(AGENT_CATALOG_DIR, file))).toEqual(readFileSync(join(CATALOG_DIR, file)));
    }
  });

  it('pins the eight locales', () => {
    expect([...PROMPT_LOCALES]).toEqual(['en', 'de-DE', 'es-419', 'fr-FR', 'fr-CA', 'it-IT', 'pt-BR', 'tr-TR']);
  });

  const rows = Object.entries(PROMPT_CATALOG).flatMap(([ns, file]) =>
    Object.entries(file.messages).map(([key, byLocale]) => ({ ns, key, byLocale: byLocale as Record<string, string> })),
  );

  it('has messages to check (a vacuous parity test is worse than none)', () => {
    expect(rows.length).toBeGreaterThanOrEqual(10);
  });

  it.each(rows)('$ns/$key has exactly the eight locales', ({ byLocale }) => {
    expect(Object.keys(byLocale).sort()).toEqual([...PROMPT_LOCALES].sort());
  });

  it.each(rows)('$ns/$key: every locale non-empty, no markup, same placeholders as en', ({ byLocale }) => {
    const enPlaceholders = promptMessagePlaceholders(byLocale.en!);
    for (const locale of PROMPT_LOCALES) {
      const text = byLocale[locale]!;
      expect(text.trim(), locale).not.toBe('');
      expect(text, locale).not.toMatch(/[<>]/);
      expect(text, locale).toBe(text.trim());
      expect(promptMessagePlaceholders(text), locale).toEqual(enPlaceholders);
    }
  });

  it('the parity check fails on a missing locale', () => {
    const broken = { en: 'Hide', 'de-DE': 'Ausblenden' };
    expect(Object.keys(broken).sort()).not.toEqual([...PROMPT_LOCALES].sort());
  });
});

describe('negotiatePromptLocale (shared fixture with the Go agent)', () => {
  it('has a meaningful fixture', () => {
    const inputs = localeFixture.cases.map((c) => c.input);
    for (const required of ['en-GB', 'pt-PT', 'es-ES', 'fr-BE', 'zh-CN', '', 'fr_CA.UTF-8']) {
      expect(inputs).toContain(required);
    }
  });

  it.each(localeFixture.cases)('$input -> $expected', ({ input, expected }) => {
    expect(negotiatePromptLocale(input)).toBe(expected);
  });

  it('is total over non-strings', () => {
    expect(negotiatePromptLocale(undefined as unknown as string)).toBe('en');
  });
});

describe('sanitizePromptPartnerName (shared fixture with the Go agent and Assist)', () => {
  it('covers every spoofing class the plan names', () => {
    const names = sanitizeFixture.cases.map((c) => c.name).join('\n');
    for (const cls of [/override/, /zero-width|ZWJ/, /Microsoft/, /Windows/, /control/, /over-long/]) {
      expect(names).toMatch(cls);
    }
  });

  it.each(sanitizeFixture.cases)('$name', ({ input, expected }) => {
    expect(sanitizePromptPartnerName(input)).toBe(expected);
  });

  it('is total over non-strings', () => {
    expect(sanitizePromptPartnerName(null as unknown as string)).toBeNull();
  });

  // Not in the shared fixture: Go and Rust JSON decoders cannot carry a lone
  // surrogate (Go turns it into U+FFFD, which the fixture covers).
  it('strips a lone surrogate', () => {
    expect(sanitizePromptPartnerName('North\ud800wind')).toBe('Northwind');
  });
});

describe('promptIdentityBlockSchema (heartbeat contract with the Go agent)', () => {
  const FIXTURE_DIR = join(__dirname, '../fixtures/prompt-catalog');
  const blockFixtures = readdirSync(FIXTURE_DIR).filter((f) => f.startsWith('heartbeat-identity.')).sort();

  it('ships the set, minimal and cleared fixtures the agent decodes', () => {
    expect(blockFixtures).toEqual([
      'heartbeat-identity.cleared.json',
      'heartbeat-identity.minimal.json',
      'heartbeat-identity.set.json',
    ]);
  });

  it.each(blockFixtures)('%s parses', (file) => {
    const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8'));
    const result = promptIdentityBlockSchema.safeParse(raw);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(result.data).toEqual(raw);
  });

  const valid = {
    state: 'set',
    scopeId: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
    partnerName: 'Northwind IT',
  } as const;

  it.each([
    ['an unsanitized partner name', { ...valid, partnerName: 'North‮wind' }],
    ['a partner name over 120 code points', { ...valid, partnerName: 'A'.repeat(121) }],
    ['an empty partner name', { ...valid, partnerName: '' }],
    ['a short scopeId', { ...valid, scopeId: 'abc' }],
    ['an upper-case scopeId', { ...valid, scopeId: '0F1E2D3C4B5A69788796A5B4C3D2E1F0' }],
    ['a named colour', { ...valid, primaryColor: 'red' }],
    ['an svg logo', { ...valid, logo: { sha256: 'a'.repeat(64), mime: 'image/svg+xml', bytes: 10 } }],
    ['a logo over 256 KB', { ...valid, logo: { sha256: 'a'.repeat(64), mime: 'image/png', bytes: 262_145 } }],
    ['extra keys on cleared', { state: 'cleared', scopeId: valid.scopeId }],
    ['an unknown state', { state: 'unset' }],
  ])('refuses %s', (_label, block) => {
    expect(promptIdentityBlockSchema.safeParse(block).success).toBe(false);
  });

  it('accepts a 120-code-point astral name', () => {
    expect(promptIdentityBlockSchema.safeParse({ ...valid, partnerName: '\u{1F680}'.repeat(120) }).success).toBe(true);
  });

  it('pins the capability version the agent advertises', () => {
    expect(PROMPT_IDENTITY_PROTOCOL_VERSION).toBe(1);
  });
});

describe('renderPromptMessage', () => {
  it('renders a key in a locale', () => {
    expect(renderPromptMessage('common', 'chrome.hide', 'de-DE')).toBe('Ausblenden');
  });

  it('substitutes named parameters', () => {
    expect(renderPromptMessage('common', 'chrome.notificationsCount', 'en', { count: '3' })).toBe('Notifications (3)');
  });

  it('never re-interprets a parameter value as a placeholder', () => {
    expect(renderPromptMessage('common', 'native.windowTitle', 'en', { partner: '{partner} {remaining}' })).toBe(
      '{partner} {remaining} · Message',
    );
  });

  it('errors on a missing parameter', () => {
    expect(() => renderPromptMessage('common', 'native.windowTitle', 'en', {})).toThrow(PromptCatalogError);
  });

  it('errors on an unknown key or namespace', () => {
    expect(() => renderPromptMessage('common', 'nope', 'en')).toThrow(PromptCatalogError);
    expect(() => renderPromptMessage('nope' as never, 'chrome.hide', 'en')).toThrow(PromptCatalogError);
  });

  it('falls back to en for a locale outside the eight', () => {
    expect(renderPromptMessage('common', 'chrome.hide', 'xx' as PromptLocale)).toBe('Hide');
  });

  it('passes the renderer-owned placeholders through untouched', () => {
    expect(promptMessagePlaceholders('Restart in {remaining} at {time:1767225600000} for {partner}')).toEqual([
      'partner',
    ]);
  });
});
