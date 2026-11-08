/**
 * Contract: every action a multiplexed AI tool's schema offers must resolve in
 * the RBAC map. `resolveToolPermissionRequirements` fails closed with
 * `Unknown action "x" for tool "y"` for any action absent from a per-action
 * `TOOL_PERMISSIONS` entry, so an implemented-but-unmapped action is refused
 * before the tool runs (#11431: manage_monitor_definitions `describe`).
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { aiTools } from './aiToolNames';
import { buildBreezeSdkTools } from './aiAgentSdkTools';
import { resolveToolPermissionRequirements } from './aiGuardrails';

interface Descriptor { name: string; input_schema: unknown }

function actionEnum(tool: Descriptor): string[] {
  const p = (tool.input_schema as { properties?: { action?: { enum?: unknown[] } } }).properties?.action?.enum;
  return Array.isArray(p) ? p.filter((v): v is string => typeof v === 'string') : [];
}

/** tool -> reason. Only tools whose permission is intentionally not per-action. */
const ALLOWLIST: Record<string, string> = {};

function collectDescriptors(): Descriptor[] {
  const descriptors: Descriptor[] = [...aiTools.values()].map((t) => t.definition);
  for (const config of [
    { M365_ENABLED: 'false', GOOGLE_WORKSPACE_ENABLED: 'false', BREEZE_AI_SCRIPT_AUTHORING_ENABLED: 'false', DELEGANT_BASE_URL: '' },
    { M365_ENABLED: 'true', GOOGLE_WORKSPACE_ENABLED: 'true', BREEZE_AI_SCRIPT_AUTHORING_ENABLED: 'true', DELEGANT_BASE_URL: '' },
  ]) {
    for (const [k, v] of Object.entries(config)) vi.stubEnv(k, v);
    try {
      descriptors.push(...buildBreezeSdkTools(() => { throw new Error('handlers must not run'); }).map((t) => ({
        name: t.name,
        input_schema: z.toJSONSchema(z.object(t.inputSchema), { io: 'input', unrepresentable: 'any' }),
      })));
    } finally { vi.unstubAllEnvs(); }
  }
  return descriptors;
}

describe('AI tool action enum ⊆ TOOL_PERMISSIONS', () => {
  it('manage_monitor_definitions describe resolves to alerts:read (#11431)', () => {
    expect(resolveToolPermissionRequirements('manage_monitor_definitions', { action: 'describe' }))
      .toEqual({ ok: true, requirements: [{ resource: 'alerts', action: 'read' }] });
  });

  it('every schema action enum value resolves (no "Unknown action" denial)', () => {
    const offenders = new Set<string>();
    for (const tool of collectDescriptors()) {
      if (ALLOWLIST[tool.name]) continue;
      for (const action of actionEnum(tool)) {
        const r = resolveToolPermissionRequirements(tool.name, { action });
        if (!r.ok && r.denial.startsWith('Unknown action')) offenders.add(`${tool.name}.${action}`);
      }
    }
    expect([...offenders].sort()).toEqual([]);
  });
});
