import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_CONFIGS, RBAC_MAPPINGS, TIER_DEFINITIONS } from './tierConfig';

/**
 * Disk Cleanup v2 W05, spec §9.3 item 12.
 *
 * tierConfig.ts is what an MSP SHOWS A CUSTOMER when asked "what can your AI do
 * to my machines without asking?". The cross-package guard
 * (apps/api/src/services/aiGuardrailsTierConfig.parity.test.ts) proves every
 * row's claimed tier is the tier checkGuardrails actually resolves — but it
 * cannot notice a tool that is simply ABSENT from the explainer. This suite is
 * the presence half.
 */
const LOCALES = ['en', 'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR'] as const;
const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');

function toolEntries(tier: number): string[] {
  return TIER_DEFINITIONS.find((t) => t.tier === tier)!.tools.map((entry) => entry.name);
}

describe('tierConfig lists system_cleanup', () => {
  it('shows list and status as auto-executing and run as approval-gated', () => {
    expect(toolEntries(1)).toContain('system_cleanup (list)');
    expect(toolEntries(1)).toContain('system_cleanup (status)');
    expect(toolEntries(3)).toContain('system_cleanup (run)');
  });

  it('advertises the real per-tool rate limit and permission', () => {
    const row = RATE_LIMIT_CONFIGS.find((c) => c.toolName === 'system_cleanup');
    expect(row).toEqual({
      toolName: 'system_cleanup',
      // Per TOOL, and `status` polling shares the counter with `run` — the
      // number mirrors TOOL_RATE_LIMITS.system_cleanup in aiGuardrails.ts.
      limit: 30,
      windowSeconds: 3600,
      tier: 3,
      permission: 'devices.execute',
      category: 'Files, Disk & Registry',
    });
  });

  it('maps RBAC per action', () => {
    expect(RBAC_MAPPINGS.system_cleanup).toEqual({ list: 'devices.read', run: 'devices.execute', status: 'devices.read' });
  });
});

describe('system_cleanup catalog labels exist in all 8 locales', () => {
  it.each(LOCALES)('%s carries the tool label and all three action labels', (locale) => {
    const catalog = JSON.parse(readFileSync(join(localesDir, locale, 'settings.json'), 'utf8'));
    const tools = catalog.aiAgentsPage.catalog.tools;
    const actions = catalog.aiAgentsPage.catalog.actions;

    expect(typeof tools.system_cleanup).toBe('string');
    expect(tools.system_cleanup.length).toBeGreaterThan(0);
    expect(typeof actions.system_cleanup?.list).toBe('string');
    expect(typeof actions.system_cleanup?.run).toBe('string');
    expect(typeof actions.system_cleanup?.status).toBe('string');

    if (locale !== 'en') {
      // translationCoverage.test.ts caps exact-English duplicates per namespace
      // and does not pin keys, so an untranslated string here silently eats
      // another string's headroom. Assert the translation happened.
      const en = JSON.parse(readFileSync(join(localesDir, 'en', 'settings.json'), 'utf8'));
      expect(tools.system_cleanup).not.toBe(en.aiAgentsPage.catalog.tools.system_cleanup);
      expect(actions.system_cleanup.list).not.toBe(en.aiAgentsPage.catalog.actions.system_cleanup.list);
      expect(actions.system_cleanup.run).not.toBe(en.aiAgentsPage.catalog.actions.system_cleanup.run);
      expect(actions.system_cleanup.status).not.toBe(en.aiAgentsPage.catalog.actions.system_cleanup.status);
    }
  });
});
