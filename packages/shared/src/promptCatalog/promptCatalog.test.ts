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
  substitutePromptParams,
  type PromptLocale,
} from './index';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = join(__dirname, 'catalog');
// go:embed cannot leave the agent module, so the catalog ships twice; the two
// copies are compared byte-for-byte from BOTH sides (cleanupRules precedent).
const AGENT_CATALOG_DIR = join(__dirname, '../../../../agent/internal/promptcatalog/catalog');

/** Problems with one catalog row; empty means the row is valid. */
function catalogRowProblems(byLocale: Record<string, string>): string[] {
  const problems: string[] = [];
  if (JSON.stringify(Object.keys(byLocale).sort()) !== JSON.stringify([...PROMPT_LOCALES].sort())) {
    problems.push('locales');
  }
  const enPlaceholders = JSON.stringify(promptMessagePlaceholders(byLocale.en ?? ''));
  for (const locale of PROMPT_LOCALES) {
    const text = byLocale[locale];
    if (text === undefined) continue;
    if (text.trim() === '' || text !== text.trim()) problems.push(`${locale}: empty or untrimmed`);
    if (/[<>]/.test(text)) problems.push(`${locale}: markup`);
    if (JSON.stringify(promptMessagePlaceholders(text)) !== enPlaceholders) problems.push(`${locale}: placeholders`);
  }
  return problems;
}

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

  it.each(rows)('$ns/$key passes the row check (8 locales, non-empty, no markup, en placeholders)', ({ byLocale }) => {
    expect(catalogRowProblems(byLocale)).toEqual([]);
  });

  it('the row check fails on a missing locale, an empty string, markup and a placeholder mismatch', () => {
    expect(catalogRowProblems({ en: 'Hide', 'de-DE': 'Ausblenden' })).toContain('locales');
    const full = Object.fromEntries(PROMPT_LOCALES.map((l) => [l, 'Hide {count}']));
    expect(catalogRowProblems(full)).toEqual([]);
    expect(catalogRowProblems({ ...full, 'tr-TR': ' ' })).toContain('tr-TR: empty or untrimmed');
    expect(catalogRowProblems({ ...full, 'it-IT': '<b>{count}</b>' })).toContain('it-IT: markup');
    expect(catalogRowProblems({ ...full, 'pt-BR': 'Ocultar {n}' })).toContain('pt-BR: placeholders');
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
    ['an extra key on set (producer typo)', { ...valid, partner_name: 'Northwind IT' }],
    ['a 3-digit colour', { ...valid, primaryColor: '#abc' }],
    ['an 8-digit colour', { ...valid, primaryColor: '#11223344' }],
    ['a short logo sha256', { ...valid, logo: { sha256: 'a'.repeat(63), mime: 'image/png', bytes: 10 } }],
    ['a zero-byte logo', { ...valid, logo: { sha256: 'a'.repeat(64), mime: 'image/png', bytes: 0 } }],
    ['logo bytes inline (the heartbeat carries metadata only)', { ...valid, logo: { sha256: 'a'.repeat(64), mime: 'image/png', bytes: 1, data: 'AA==' } }],
    ['a name that is not NFKC-folded', { ...valid, partnerName: '\uff2dicrosoft' }],
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

  function catalogError(fn: () => unknown): PromptCatalogError {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(PromptCatalogError);
      return err as PromptCatalogError;
    }
    throw new Error('expected a PromptCatalogError');
  }

  it('errors on a missing parameter with code missing_param', () => {
    expect(catalogError(() => renderPromptMessage('common', 'native.windowTitle', 'en', {})).code).toBe('missing_param');
  });

  it('errors on an unknown key or namespace with code unknown_key', () => {
    expect(catalogError(() => renderPromptMessage('common', 'nope', 'en')).code).toBe('unknown_key');
    expect(catalogError(() => renderPromptMessage('nope' as never, 'chrome.hide', 'en')).code).toBe('unknown_key');
    // Prototype keys are not namespaces or keys.
    expect(catalogError(() => renderPromptMessage('toString' as never, 'chrome.hide', 'en')).code).toBe('unknown_key');
    expect(catalogError(() => renderPromptMessage('common', 'constructor', 'en')).code).toBe('unknown_key');
  });

  // #10190 W06: Assist pre-fills Request Support with this, in the session
  // prompt's locale, after "Report a problem" on the remote-session pill.
  it('renders the Report-a-problem draft with the session id in every locale', () => {
    expect(renderPromptMessage('common', 'chrome.remoteReportDraft', 'en', { sessionId: 's-1' })).toBe(
      'Problem with remote session s-1:',
    );
    expect(renderPromptMessage('common', 'chrome.remoteReportDraft', 'de-DE', { sessionId: 's-1' })).toBe(
      'Problem mit der Remotesitzung s-1:',
    );
    for (const locale of ['en', 'de-DE', 'es-419', 'fr-FR', 'fr-CA', 'it-IT', 'pt-BR', 'tr-TR'] as const) {
      expect(renderPromptMessage('common', 'chrome.remoteReportDraft', locale, { sessionId: 's-1' })).toContain('s-1');
    }
    expect(catalogError(() => renderPromptMessage('common', 'chrome.remoteReportDraft', 'en', {})).code).toBe(
      'missing_param',
    );
  });

  it('renders fr-CA distinctly from fr-FR', () => {
    expect(renderPromptMessage('common', 'identity.generic', 'fr-CA')).toBe('Votre équipe de soutien informatique');
    expect(renderPromptMessage('common', 'identity.generic', 'fr-FR')).toBe("Votre équipe d'assistance informatique");
  });

  it('substitutePromptParams leaves {time:<ms>} and {remaining} for the renderer', () => {
    expect(substitutePromptParams('At {time:1767225600000} in {remaining} for {partner}', { partner: 'N' })).toBe(
      'At {time:1767225600000} in {remaining} for N',
    );
    expect(catalogError(() => substitutePromptParams('{time:1} {count}', {})).code).toBe('missing_param');
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

// W04 (#10190): the notice.info copy the agent renders (agent/internal/promptkinds).
describe('notice namespace', () => {
  const NOTICE_KEYS = [
    'action.ok',
    'action.openSettings',
    'safeMode.title',
    'safeMode.body',
    'safeMode.bodyNow',
    'sessionEnded.title',
    'sessionEnded.body',
    'sessionEnded.bodyNoTechnician',
    'sessionEnded.durationLabel',
    'sessionEnded.durationMinutes',
    'sessionEnded.durationUnderMinute',
    'tcc.title',
    'tcc.bodyFullDiskAccess',
    'tcc.bodyOthers',
    'tcc.missingLabel',
    'tcc.permission.fullDiskAccess',
    'tcc.permission.screenRecording',
    'tcc.permission.accessibility',
  ];

  it('is registered and carries exactly the keys the agent renders', () => {
    expect(Object.keys(PROMPT_CATALOG)).toContain('notice');
    const ns = (PROMPT_CATALOG as Record<string, { messages: Record<string, unknown> }>).notice;
    expect(Object.keys(ns?.messages ?? {}).sort()).toEqual([...NOTICE_KEYS].sort());
  });

  it('leaves the safe-mode time to the renderer', () => {
    expect(renderPromptMessage('notice', 'safeMode.body', 'en', { at: '{time:1767225600000}' })).toContain(
      '{time:1767225600000}',
    );
  });

  it('renders in the session locale', () => {
    expect(renderPromptMessage('notice', 'action.ok', 'tr-TR')).toBe('Tamam');
    expect(renderPromptMessage('notice', 'action.openSettings', 'de-DE')).toBe('Einstellungen öffnen');
    expect(renderPromptMessage('notice', 'sessionEnded.body', 'fr-CA', { technician: 'Dana' })).toContain('Dana');
  });

  it('needs the technician parameter', () => {
    expect(() => renderPromptMessage('notice', 'sessionEnded.body', 'en', {})).toThrow(/needs parameter "technician"/);
  });
});

// W06 (#10190): the remote.consent and remote.session copy the agent renders
// (agent/internal/promptkinds/remote.go).
describe('remote namespace', () => {
  const REMOTE_KEYS = [
    'action.allow',
    'action.deny',
    'action.endSession',
    'action.keepSession',
    'action.reportProblem',
    'consent.title',
    'consent.body',
    'consent.bodyFrom',
    'consent.bodyOrganization',
    'consent.bodyGeneric',
    'consent.expiryProceed',
    'consent.expiryBlock',
    'fact.technician',
    'fact.email',
    'fact.organization',
    'fact.started',
    'session.title',
    'session.titleFrom',
    'session.titleOrganization',
    'session.titleGeneric',
    'session.body',
    'session.confirmEnd',
    'session.endFailed',
  ];

  it('is registered and carries exactly the keys the agent renders', () => {
    expect(Object.keys(PROMPT_CATALOG)).toContain('remote');
    const ns = (PROMPT_CATALOG as Record<string, { messages: Record<string, unknown> }>).remote;
    expect(Object.keys(ns?.messages ?? {}).sort()).toEqual([...REMOTE_KEYS].sort());
  });

  it('leaves the consent countdown to the renderer and states the policy consequence', () => {
    expect(renderPromptMessage('remote', 'consent.expiryProceed', 'en')).toBe('If no one answers, the session starts in {remaining}.');
    expect(renderPromptMessage('remote', 'consent.expiryBlock', 'en')).toBe('If no one answers, the session is declined in {remaining}.');
    for (const locale of PROMPT_LOCALES) {
      expect(renderPromptMessage('remote', 'consent.expiryProceed', locale)).toContain('{remaining}');
      expect(renderPromptMessage('remote', 'consent.expiryBlock', locale)).toContain('{remaining}');
    }
  });

  it('renders the decision labels in the session locale', () => {
    expect(renderPromptMessage('remote', 'action.deny', 'de-DE')).toBe('Ablehnen');
    expect(renderPromptMessage('remote', 'action.allow', 'fr-CA')).toBe('Autoriser');
    expect(renderPromptMessage('remote', 'session.titleFrom', 'pt-BR', { technician: 'Dana', organization: 'Northwind IT' })).toContain('Northwind IT');
  });

  it('needs its parameters', () => {
    expect(() => renderPromptMessage('remote', 'session.titleFrom', 'en', { technician: 'Dana' })).toThrow(/needs parameter "organization"/);
  });
});
