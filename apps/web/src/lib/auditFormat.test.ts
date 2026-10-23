import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderHook } from '@testing-library/react';

import { applyLocale, i18n } from '@/lib/i18n';
import { formatAuditAction, useAuditActionFormatter } from './auditFormat';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../locales');

function auditActions(locale: string): Record<string, string> {
  const admin = JSON.parse(
    readFileSync(join(localesDir, locale, 'admin.json'), 'utf-8'),
  ) as { audit?: { actions?: Record<string, string> } };
  return admin.audit?.actions ?? {};
}

describe('formatAuditAction', () => {
  it('prefers the supplied (translated) catalog over the built-in English one', () => {
    expect(formatAuditAction('user.login', { 'user.login': 'Sessão iniciada' })).toBe(
      'Sessão iniciada',
    );
  });

  it('falls back to the built-in English catalog when no labels are supplied', () => {
    expect(formatAuditAction('user.login')).toBe('Signed in');
  });

  it('falls back to English for a code the translated catalog does not cover', () => {
    // A locale bundle only translates the common codes; the API emits hundreds.
    expect(formatAuditAction('user.login', { 'device.create': 'Dispositivo criado' })).toBe(
      'Signed in',
    );
  });

  it('prettifies an unmapped dotted code rather than leaking the raw enum', () => {
    expect(formatAuditAction('device_group.create')).toBe('Device group create');
  });

  // #3991: catch-all HTTP audit rows are named `api.<verb>.<path>`, with `:id`
  // / `:n` standing in for ids. They must read as an operation, not leak the
  // verb, the route template or the placeholder.
  it('renders fallback route codes as an operation without route-template leakage', () => {
    expect(formatAuditAction('api.patch.orgs.:id.billing-settings')).toBe(
      'Updated orgs \u203a billing settings',
    );
    expect(formatAuditAction('api.post.quotes.:id.send')).toBe('Submitted quotes \u203a send');
    expect(formatAuditAction('api.post.orgs.organizations')).toBe(
      'Submitted orgs \u203a organizations',
    );
    expect(formatAuditAction('api.delete.alerts.channels.:id')).toBe(
      'Deleted alerts \u203a channels',
    );
    expect(formatAuditAction('api.put.settings.:n')).toBe('Updated settings');
  });

  it('uses the translated fallback verb template when supplied', () => {
    expect(
      formatAuditAction('api.patch.orgs.:id.billing-settings', {
        'api.fallback.patch': 'Aktualisiert: {target}',
      }),
    ).toBe('Aktualisiert: orgs \u203a billing settings');
  });

  it('ships a {target} verb template for every locale', () => {
    for (const locale of ['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR']) {
      const actions = auditActions(locale);
      for (const verb of ['post', 'put', 'patch', 'delete']) {
        expect(actions[`api.fallback.${verb}`], `${locale} ${verb}`).toContain('{target}');
      }
    }
  });

  it('leaves non-mutating or unrecognised api.* codes to the prettifier', () => {
    expect(formatAuditAction('api.get.events.ws-ticket')).toBe('Api get events ws-ticket');
  });

  it('labels each remote-session consent outcome distinctly', () => {
    const labels = [
      'session_consent_granted',
      'session_consent_denied',
      'session_consent_blocked_unanswered',
      'session_consent_blocked_unavailable',
      'session_consent_bypassed',
    ].map((code) => formatAuditAction(code));
    expect(new Set(labels).size).toBe(labels.length);
    expect(formatAuditAction('session_consent_blocked_unavailable')).toBe(
      'Remote session blocked: consent prompt unavailable',
    );
    expect(formatAuditAction('session_consent_bypassed')).toBe(
      'Remote session started without an answer to the consent prompt',
    );
  });

  it('labels a refused screen capture or input control on a consent-required device', () => {
    expect(formatAuditAction('screen_access_consent_blocked')).toBe(
      'Screen access blocked: device requires user consent',
    );
  });

  // #9534: every AI tool call writes `ai.tool.<toolName>`; the Audit Trail
  // rendered "Ai tool remediate vulnerability" (lower-case i, raw tool name).
  it('labels ai.tool.<name> rows as an AI tool call with a readable tool name', () => {
    expect(formatAuditAction('ai.tool.remediate_vulnerability')).toBe('AI tool: Remediate vulnerability');
    expect(formatAuditAction('ai.tool.query_devices')).toBe('AI tool: Query devices');
    // A namespaced MCP tool id never leaks its server prefix.
    expect(formatAuditAction('ai.tool.mcp__breeze__manage_services')).toBe('AI tool: Manage services');
    expect(formatAuditAction('ai.tool.mcp__my_server__list_tickets')).toBe('AI tool: List tickets');
  });

  it('uses the translated ai.tool template when supplied', () => {
    expect(
      formatAuditAction('ai.tool.query_devices', { 'ai.tool.*': 'KI-Werkzeug: {tool}' }),
    ).toBe('KI-Werkzeug: Query devices');
  });

  it('ships a {tool} template for ai.tool rows in every locale', () => {
    for (const locale of ['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR']) {
      expect(auditActions(locale)['ai.tool.*'], locale).toContain('{tool}');
    }
  });

  // #9630: restore audit rows and the per-command-type `agent.command.<type>`
  // family rendered as prettified codes.
  it('labels backup restore audit actions', () => {
    expect(formatAuditAction('backup.restore.create')).toBe('Started a restore');
    expect(formatAuditAction('backup.restore.cancel')).toBe('Cancelled a restore');
    expect(formatAuditAction('backup.restore.unattested_override')).toBe(
      'Confirmed restore of an unverified snapshot',
    );
  });

  it('labels agent.command.<type> rows with a friendly command name', () => {
    expect(formatAuditAction('agent.command.backup_restore')).toBe('Queued command: Restore backup');
    expect(formatAuditAction('agent.command.install_patches')).toBe('Queued command: Install patches');
    expect(formatAuditAction('agent.command.reboot')).toBe('Queued command: Reboot');
  });

  it('falls back to the prettified type for an unmapped agent.command.<type>', () => {
    expect(formatAuditAction('agent.command.some_new_thing')).toBe('Queued command: Some new thing');
  });

  it('keeps agent.command.result.submit as its explicit entry', () => {
    expect(formatAuditAction('agent.command.result.submit')).toBe('Submitted command result');
  });

  it('uses the translated agent.command template when supplied', () => {
    expect(
      formatAuditAction('agent.command.reboot', { 'agent.command.*': 'Befehl: {command}' }),
    ).toBe('Befehl: Reboot');
  });

  it('ships restore labels and a {command} template in every locale', () => {
    for (const locale of ['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR']) {
      const a = auditActions(locale);
      expect(a['agent.command.*'], locale).toContain('{command}');
      for (const k of ['backup.restore.create', 'backup.restore.cancel', 'backup.restore.unattested_override']) {
        expect(a[k], `${locale} ${k}`).toBeTruthy();
      }
    }
  });

  it('never renders an unmapped ai.* or mcp.* code with a lower-case acronym', () => {
    expect(formatAuditAction('ai.script_lane.reset')).toBe('AI script lane reset');
    expect(formatAuditAction('ai.some_future.thing')).toBe('AI some future thing');
    expect(formatAuditAction('mcp.prompts.list')).toBe('MCP prompts list');
  });

  it('labels the common AI session and security events', () => {
    for (const code of [
      'ai.session.create',
      'ai.session.close',
      'ai.command.executed',
      'ai.script.executed',
      'ai.external_tool.call',
      'ai.security.prompt_injection_detected',
      'ai.plan_approval.update',
    ]) {
      expect(auditActions('en')[code], code).toBeTruthy();
    }
  });

  it('returns an empty string for a missing action', () => {
    expect(formatAuditAction(null)).toBe('');
    expect(formatAuditAction(undefined)).toBe('');
    expect(formatAuditAction('')).toBe('');
  });
});

describe('recovery key audit labels (#9609)', () => {
  it('labels reveal and rotate instead of prettifying the code', () => {
    expect(formatAuditAction('device.recovery_key.reveal')).toBe('Revealed a recovery key');
    expect(formatAuditAction('device.recovery_key.rotate')).toBe('Rotated a recovery key');
  });
});

// The English fallback map in auditFormat.ts and the `admin:audit.actions`
// locale catalog are two copies of the same vocabulary. If they drift, a code
// renders translated for some operators and prettified for others — the exact
// inconsistency #3432 was about. Locale parity only compares locales against
// English, so nothing else would catch English drifting from the code.
describe('audit action catalog stays in sync with the English fallback map', () => {
  it('covers every code in the built-in map, with identical English wording', () => {
    const en = auditActions('en');
    expect(Object.keys(en).length).toBeGreaterThan(0);

    for (const [code, english] of Object.entries(en)) {
      expect(formatAuditAction(code), `en catalog drifted for "${code}"`).toBe(english);
    }
  });

  it('translates the catalog away from English in pt-BR', () => {
    const en = auditActions('en');
    const ptBr = auditActions('pt-BR');

    expect(Object.keys(ptBr).sort()).toEqual(Object.keys(en).sort());
    // Guard against a copy-paste of the English file: the reported bug was that
    // pt-BR showed English action names.
    const translated = Object.keys(en).filter((code) => ptBr[code] !== en[code]);
    expect(translated.length).toBeGreaterThan(Object.keys(en).length / 2);
  });
});

// The hook reads the whole `audit.actions` node via i18next `returnObjects`
// rather than key-by-key, because action codes contain dots that i18next would
// otherwise treat as key separators. This locks that mechanism in.
describe('useAuditActionFormatter', () => {
  afterEach(async () => {
    await applyLocale('en');
  });

  it('resolves codes through the locale catalog, dots and all', () => {
    const { result } = renderHook(() => useAuditActionFormatter());

    expect(result.current('user.login')).toBe('Signed in');
    expect(result.current('agent.command.result.submit')).toBe('Submitted command result');
    // Unmapped codes still degrade to the prettifier, not the raw enum.
    expect(result.current('device_group.create')).toBe('Device group create');
    expect(result.current(null)).toBe('');
  });

  // The regression itself: under pt-BR the Audit Trail used to render English
  // action names, because the catalog was a hardcoded map in this module rather
  // than locale data. English can never prove that — the fallback masks it.
  it('renders pt-BR action names once that bundle is loaded', async () => {
    await applyLocale('pt-BR');
    expect(i18n.language).toBe('pt-BR');

    const { result } = renderHook(() => useAuditActionFormatter());

    const ptBr = auditActions('pt-BR');
    expect(result.current('user.login')).toBe(ptBr['user.login']);
    expect(result.current('user.login')).not.toBe('Signed in');
    // A dotted, multi-segment code resolves too — the returnObjects read is
    // what makes that work.
    expect(result.current('agent.command.result.submit')).toBe(
      ptBr['agent.command.result.submit'],
    );
  });
});
