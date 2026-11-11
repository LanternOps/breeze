/**
 * Contract test (#10194): every tool and operation the agent tool catalog
 * serves has picker copy in the web `settings` namespace.
 *
 * The agent wizard (`apps/web/src/components/settings/aiAgents/CapabilityPicker.tsx`)
 * labels each catalog row with `aiAgentsPage.catalog.tools.<tool>`, each
 * operation of a multi-action tool with `aiAgentsPage.catalog.actions.<tool>.<action>`,
 * and each capability group with `aiAgentsPage.catalog.capabilities.<id>.label`.
 * A missing key renders a humanized fallback AND fires the i18n missing-key
 * handler, which in production is one Sentry message per key per session.
 * Tool waves kept landing in `TOOL_CAPABILITY` without copy (200 tool and 337
 * action labels behind by 2026-10-28), so this test makes "a new agent-reachable tool" and "its label"
 * land in the same commit.
 *
 * Only English is checked here; `apps/web/src/lib/i18n/localeParity.test.ts`
 * holds the other seven locales to the English key set.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import '../aiTools'; // populates the registry

import { buildAgentToolCatalog, resetAgentToolCatalogMemo } from './agentToolCatalog';
import { POLICY_DECIDABLE_TIER3 } from '../actionIntents/policyDecidableKeys';

const enSettingsPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../web/src/locales/en/settings.json',
);

interface CatalogCopy {
  tools: Record<string, unknown>;
  actions: Record<string, Record<string, unknown> | undefined>;
  capabilities: Record<string, { label?: unknown; description?: unknown } | undefined>;
}

function loadCatalogCopy(): CatalogCopy {
  const settings = JSON.parse(readFileSync(enSettingsPath, 'utf8'));
  const catalog = settings?.aiAgentsPage?.catalog;
  if (!catalog || typeof catalog !== 'object') {
    throw new Error(`aiAgentsPage.catalog is missing from ${enSettingsPath}`);
  }
  return {
    tools: catalog.tools ?? {},
    actions: catalog.actions ?? {},
    capabilities: catalog.capabilities ?? {},
  };
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

describe('agent tool catalog picker labels (en settings.json)', () => {
  resetAgentToolCatalogMemo();
  const catalog = buildAgentToolCatalog();
  const copy = loadCatalogCopy();

  it('the catalog is not empty (guards a vacuous pass)', () => {
    expect(catalog.tools.length).toBeGreaterThan(100);
    expect(catalog.tools.some((tool) => tool.operations.some((op) => op.action !== null))).toBe(true);
  });

  it('every catalog tool has aiAgentsPage.catalog.tools.<tool>', () => {
    const missing = catalog.tools
      .map((tool) => tool.name)
      .filter((name) => !isNonEmptyString(copy.tools[name]));
    expect(missing, 'add these to apps/web/src/locales/*/settings.json under aiAgentsPage.catalog.tools').toEqual([]);
  });

  it('every catalog operation with an action has aiAgentsPage.catalog.actions.<tool>.<action>', () => {
    const missing: string[] = [];
    for (const tool of catalog.tools) {
      for (const op of tool.operations) {
        if (op.action === null) continue;
        if (!isNonEmptyString(copy.actions[tool.name]?.[op.action])) missing.push(`${tool.name}.${op.action}`);
      }
    }
    expect(missing, 'add these to apps/web/src/locales/*/settings.json under aiAgentsPage.catalog.actions').toEqual([]);
  });

  it('every catalog capability has aiAgentsPage.catalog.capabilities.<id>.{label,description}', () => {
    const missing: string[] = [];
    for (const { id } of catalog.capabilities) {
      if (!isNonEmptyString(copy.capabilities[id]?.label)) missing.push(`${id}.label`);
      if (!isNonEmptyString(copy.capabilities[id]?.description)) missing.push(`${id}.description`);
    }
    expect(missing, 'add these to apps/web/src/locales/*/settings.json under aiAgentsPage.catalog.capabilities').toEqual([]);
  });
});

/**
 * The wizard's Safety step (`PolicyKeysCheckboxes.tsx`) labels each
 * policy-decidable key from a sibling namespace,
 * `aiAgentsPage.policyKeys.{tools,actions}`, so the same drift applies there.
 */
describe('policy-decidable key labels (en settings.json)', () => {
  const settings = JSON.parse(readFileSync(enSettingsPath, 'utf8'));
  const policyKeys = settings?.aiAgentsPage?.policyKeys ?? {};
  const tools: Record<string, unknown> = policyKeys.tools ?? {};
  const actions: Record<string, Record<string, unknown> | undefined> = policyKeys.actions ?? {};

  it('every POLICY_DECIDABLE_TIER3 entry has a tool label and, when multiplexed, an action label', () => {
    expect(POLICY_DECIDABLE_TIER3.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const entry of POLICY_DECIDABLE_TIER3) {
      if (!isNonEmptyString(tools[entry.toolName])) missing.push(`tools.${entry.toolName}`);
      if (entry.action !== null && !isNonEmptyString(actions[entry.toolName]?.[entry.action])) {
        missing.push(`actions.${entry.toolName}.${entry.action}`);
      }
    }
    expect([...new Set(missing)], 'add these to apps/web/src/locales/*/settings.json under aiAgentsPage.policyKeys').toEqual([]);
  });
});
