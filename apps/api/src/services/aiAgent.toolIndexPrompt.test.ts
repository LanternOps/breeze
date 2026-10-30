import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import './aiTools';
import { buildSystemPrompt } from './aiAgent';
import { listChatSurfaceToolNames } from './aiAgentSdkTools';
import { renderAlwaysOnIndex, renderDomainBlock, renderPageContextToolBlocks, renderToolIndexByDomain } from './aiToolIndex';

// W19 (#10065), unmocked: the real buildSystemPrompt with the real index.
// Page ids are not UUIDs, so the device-row/memory lookup never reaches a DB.
const auth = { user: { id: 'u-1', name: 'Tess Tech' }, scope: 'organization' } as unknown as AuthContext;
const device = { type: 'device', id: 'device-fixture', hostname: 'FS-01' } as const;
const PAGE_HEADING = '### Tools for this page';

afterEach(() => vi.unstubAllEnvs());

describe('buildSystemPrompt tool index (W19, unmocked)', () => {
  const names = listChatSurfaceToolNames();

  it('defaults to the always-on index with AI_TOOL_INDEX unset', async () => {
    const prompt = await buildSystemPrompt(auth);
    expect(prompt).toContain(renderAlwaysOnIndex(names));
    expect(prompt).not.toContain(renderToolIndexByDomain(names));
    expect(prompt).not.toContain(PAGE_HEADING);
  });

  it('a device page appends its Devices and Scripts tool lines after the page lines', async () => {
    const prompt = await buildSystemPrompt(auth, device);
    const blocks = renderPageContextToolBlocks(device, names);
    expect(blocks).toContain(renderDomainBlock('devices', names));
    expect(prompt).toContain(blocks);
    expect(prompt.indexOf(blocks)).toBeGreaterThan(prompt.indexOf('The user is viewing device "FS-01"'));
  });

  it('AI_TOOL_INDEX=full: the legacy whole index and no page block, re-read on each build', async () => {
    vi.stubEnv('AI_TOOL_INDEX', 'full');
    const full = await buildSystemPrompt(auth, device);
    expect(full).toContain(renderToolIndexByDomain(names));
    expect(full).not.toContain(PAGE_HEADING);
    vi.unstubAllEnvs();
    expect(await buildSystemPrompt(auth, device)).toContain(PAGE_HEADING);
  });

  it.each([
    ['dashboard', { type: 'dashboard' }],
    ['custom', { type: 'custom', label: 'devices scripts backup', data: { domain: 'backup' } }],
    ['topology', { type: 'topology', siteId: 's-1', subject: { kind: 'device', id: 'd-1' }, view: 'map', graphRevision: 1 }],
  ] as const)('a %s page adds no tool block (client strings never pick a domain)', async (_page, ctx) => {
    const prompt = await buildSystemPrompt(auth, ctx as never);
    expect(prompt).not.toContain(PAGE_HEADING);
  });

  it('keeps the topology pin to topology read tools', async () => {
    const prompt = await buildSystemPrompt(auth, { type: 'topology', siteId: 's-1', subject: { kind: 'device', id: 'd-1' }, view: 'map', graphRevision: 1 } as never);
    expect(prompt).toContain('Use only the topology read tools');
  });

  it('an unknown page type renders no block instead of throwing', () => {
    expect(renderPageContextToolBlocks({ type: 'not_a_page' } as never, names)).toBe('');
    expect(renderPageContextToolBlocks({ type: 'constructor' } as never, names)).toBe('');
  });
});
