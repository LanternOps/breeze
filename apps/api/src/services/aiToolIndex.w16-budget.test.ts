import { expect, it } from 'vitest';
import { listChatSurfaceToolNames } from './aiAgentSdkTools';
import { renderAlwaysOnIndex, renderDomainBlock, renderPageContextToolBlocks, renderToolIndexByDomain } from './aiToolIndex';

const DOMAINS = ['core', 'devices', 'scripts', 'patching', 'monitoring', 'network', 'security', 'backup', 'tickets', 'billing', 'accounts', 'integrations', 'admin', 'ai'] as const;

it('W16 PR A (#6786): both launch tools land in the lazy ai block; the always-on index is byte-identical', () => {
  const names = listChatSurfaceToolNames();
  const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
  const B1 = bytes(renderAlwaysOnIndex(names));
  const aiBlock = renderDomainBlock('ai', names);
  const largestBlock = Math.max(...DOMAINS.map((d) => bytes(renderDomainBlock(d, names))));
  const alertTurn = B1 + bytes(renderPageContextToolBlocks({ type: 'alert', id: 'alert-fixture', title: 'Fixture' } as never, names));
  const orgTurn = B1 + bytes(renderPageContextToolBlocks({ type: 'record', kind: 'organization', id: 'org-fixture', title: 'Fixture' } as never, names));
  const deviceTurn = B1 + bytes(renderPageContextToolBlocks({ type: 'device', id: 'device-fixture', hostname: 'Fixture' } as never, names));
  const full = bytes(renderToolIndexByDomain(names));

  for (const tool of ['run_patch_plan', 'create_operator_task']) {
    expect(names, tool).toContain(tool);
    expect(aiBlock, tool).toContain(tool);
  }
  // `patching` stays about patches, not agents (plan Budget: the alternative was measured and rejected).
  expect(renderDomainBlock('patching', names)).not.toContain('run_patch_plan');
  // No vocabulary change: PR A adds tools to a domain that already has some, so B1 cannot move (W19-D1).
  expect(B1).toBe(2551);
  expect(bytes(aiBlock)).toBeLessThan(2048);
  expect(largestBlock).toBeLessThan(2048);
  for (const turn of [alertTurn, orgTurn, deviceTurn]) expect(turn).toBeLessThan(7040);
  process.stdout.write(`W16 PR A index bytes ${JSON.stringify({ B1, ai: bytes(aiBlock), largestBlock, alertTurn, orgTurn, deviceTurn, full })}\n`);
});
