/**
 * #11395 (W03 T8): the constrained chat prompt for small-context models.
 * `AI_SYSTEM_PROMPT_COMPACT` replaces BASE + TAIL + DIAGNOSIS under a
 * constrained tool exposure; the `full` prompt is pinned byte-for-byte by
 * aiAgent.toolIndexPrompt.test.ts and must not move.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_TOOL_DOMAINS } from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import './aiTools';
import { buildSystemPrompt } from './aiAgent';
import { chatToolDomain, listChatSurfaceToolNames } from './aiAgentSdkTools';
import { AI_SYSTEM_PROMPT_BASE, AI_SYSTEM_PROMPT_COMPACT, AI_SYSTEM_PROMPT_TAIL, UNTRUSTED_TOOL_OUTPUT_RULE } from './aiAgentSystemPrompt';
import { AI_SYSTEM_PROMPT_DIAGNOSIS } from './aiAgentDiagnosisPrompt';
import { composeConstrainedSystemPrompt, DOMAIN_VOCABULARY } from './aiToolIndex';
import { getToolDomain } from './aiTools';
import { chatPromptExposure } from './aiModels/sessionToolExposure';
import { DEFAULT_TOOL_PROFILE_FACTS, type ToolProfileFacts } from './aiModels/toolExposure';
import { CHAT_MINIMAL_TOOLS } from './aiModels/toolProfiles';

const auth = { user: { id: 'u-1', name: 'Tess Tech' }, scope: 'organization' } as unknown as AuthContext;
const device = { type: 'device', id: 'device-fixture', hostname: 'FS-01' } as const;
const facts = (over: Partial<ToolProfileFacts>): ToolProfileFacts => ({ ...DEFAULT_TOOL_PROFILE_FACTS, ...over });
const MINIMAL = facts({ toolProfile: 'minimal', transport: 'gateway' });
const STANDARD = facts({ toolProfile: 'standard', transport: 'gateway' });
const exposureFor = (f: ToolProfileFacts) => chatPromptExposure(f, { registryNames: listChatSurfaceToolNames, domainOf: chatToolDomain });

afterEach(() => vi.unstubAllEnvs());

describe('AI_SYSTEM_PROMPT_COMPACT', () => {
  it('is at most 2,048 bytes', () => {
    expect(Buffer.byteLength(AI_SYSTEM_PROMPT_COMPACT, 'utf8')).toBeLessThanOrEqual(2048);
  });

  it('keeps the rules that matter: approvals, never claim, the tenant boundary, and "cannot"', () => {
    expect(AI_SYSTEM_PROMPT_COMPACT).toMatch(/approv/i);
    expect(AI_SYSTEM_PROMPT_COMPACT).toMatch(/Approve\/Deny/);
    expect(AI_SYSTEM_PROMPT_COMPACT).toMatch(/never claim/i);
    expect(AI_SYSTEM_PROMPT_COMPACT).toMatch(/organization/i);
    expect(AI_SYSTEM_PROMPT_COMPACT).toMatch(/tenant/i);
    expect(AI_SYSTEM_PROMPT_COMPACT).toMatch(/cannot/i);
  });

  it('ships the untrusted-tool-output rule verbatim', () => {
    expect(AI_SYSTEM_PROMPT_COMPACT).toContain(UNTRUSTED_TOOL_OUTPUT_RULE);
  });

  it('names no tool (no snake_case token): the tool lines come only from the exposure', () => {
    expect(AI_SYSTEM_PROMPT_COMPACT.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []).toEqual([]);
  });

  it('is not the full prompt (BASE / TAIL / DIAGNOSIS are not inside it)', () => {
    expect(AI_SYSTEM_PROMPT_COMPACT).not.toContain(AI_SYSTEM_PROMPT_BASE.slice(0, 200));
    expect(AI_SYSTEM_PROMPT_COMPACT).not.toContain(AI_SYSTEM_PROMPT_TAIL.slice(0, 200));
  });
});

describe('composeConstrainedSystemPrompt', () => {
  const names = [...CHAT_MINIMAL_TOOLS, 'set_device_context'];
  const prompt = composeConstrainedSystemPrompt(names);

  it('is the compact prompt followed by tool lines for exactly the exposed names', () => {
    expect(prompt.startsWith(AI_SYSTEM_PROMPT_COMPACT)).toBe(true);
    for (const name of names) expect(prompt).toContain(name);
    for (const absent of ['execute_command', 'manage_alerts', 'run_script', 'list_playbooks', 'manage_configuration_policy']) {
      expect(prompt).not.toContain(absent);
    }
  });

  it('has no diagnosis section and no tool-search guidance', () => {
    expect(prompt).not.toContain(AI_SYSTEM_PROMPT_DIAGNOSIS.slice(0, 120));
    expect(prompt).not.toContain('ToolSearch');
  });

  it('carries no domain vocabulary at all, so none for an absent domain', () => {
    const present = new Set(names.map((n) => getToolDomain(n)));
    for (const domain of AI_TOOL_DOMAINS) {
      expect(prompt, domain).not.toContain(DOMAIN_VOCABULARY[domain]);
    }
    expect(present.has('billing')).toBe(false);
    expect(prompt).not.toContain('**Billing**');
  });

  it('is deterministic and order-independent (a stable cache prefix)', () => {
    expect(composeConstrainedSystemPrompt([...names].reverse())).toBe(prompt);
  });
});

describe('buildSystemPrompt under a constrained exposure', () => {
  it('a device-page prompt carries the same tool lines as the no-page prompt (no page expansion)', async () => {
    const exposure = exposureFor(MINIMAL);
    const noPage = await buildSystemPrompt(auth, undefined, undefined, undefined, exposure);
    const page = await buildSystemPrompt(auth, device, undefined, undefined, exposure);
    const staticPart = composeConstrainedSystemPrompt(exposure.names!);
    expect(noPage.startsWith(staticPart)).toBe(true);
    expect(page.startsWith(staticPart)).toBe(true);
    expect(page).not.toContain('### Tools for this page');
    expect(page).toContain('The user is viewing device "FS-01"');
  });

  it('the static prefix is byte-stable across turns and pages (prompt-cache prefix pin)', async () => {
    const exposure = exposureFor(STANDARD);
    const prompts = await Promise.all([
      buildSystemPrompt(auth, undefined, undefined, undefined, exposure),
      buildSystemPrompt(auth, device, undefined, undefined, exposure),
      buildSystemPrompt(auth, { type: 'dashboard' }, undefined, undefined, exposure),
    ]);
    const prefix = composeConstrainedSystemPrompt(exposure.names!);
    for (const p of prompts) expect(p.slice(0, prefix.length)).toBe(prefix);
  });

  it('is far smaller than the full prompt', async () => {
    const full = await buildSystemPrompt(auth);
    const minimal = await buildSystemPrompt(auth, undefined, undefined, undefined, exposureFor(MINIMAL));
    expect(Buffer.byteLength(minimal)).toBeLessThan(Buffer.byteLength(full) / 2);
  });

  it('an identity exposure (full) leaves the prompt byte-identical', async () => {
    const identity = exposureFor(DEFAULT_TOOL_PROFILE_FACTS);
    expect(identity.promptMode).toBe('standard');
    expect(await buildSystemPrompt(auth, device, undefined, undefined, identity)).toBe(await buildSystemPrompt(auth, device));
  });

  it('full → minimal → full: the third prompt equals the first byte-for-byte', async () => {
    const first = await buildSystemPrompt(auth, device, undefined, undefined, exposureFor(DEFAULT_TOOL_PROFILE_FACTS));
    const second = await buildSystemPrompt(auth, device, undefined, undefined, exposureFor(MINIMAL));
    const third = await buildSystemPrompt(auth, device, undefined, undefined, exposureFor(DEFAULT_TOOL_PROFILE_FACTS));
    expect(second).not.toBe(first);
    expect(third).toBe(first);
  });
});
