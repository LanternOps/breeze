import { expect, it } from 'vitest';
import { listChatSurfaceToolNames } from './aiAgentSdkTools';
import { renderAlwaysOnIndex, renderDomainBlock, renderPageContextToolBlocks } from './aiToolIndex';

it('W15 Pax8 vocabulary fits the +128 B lazy-index wave allowance and 7,040 B total cap', () => {
  const names = listChatSurfaceToolNames();
  const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
  const alwaysOn = renderAlwaysOnIndex(names);
  const B1 = bytes(alwaysOn);
  const B2 = bytes(renderDomainBlock('billing', names));
  const largestBlock = Math.max(...(['core', 'devices', 'scripts', 'patching', 'monitoring', 'network', 'security', 'backup', 'tickets', 'billing', 'accounts', 'integrations', 'admin', 'ai'] as const).map((d) => bytes(renderDomainBlock(d, names))));
  const B3 = B1 + bytes(renderPageContextToolBlocks({ type: 'alert', id: 'alert-fixture', title: 'Fixture' } as never, names));
  expect(alwaysOn).toContain('Pax8 orders');
  expect(B1 - 2494).toBeLessThanOrEqual(128);
  expect(B1).toBeLessThan(2560);
  expect(B2).toBeLessThan(2048);
  expect(largestBlock).toBeLessThan(2048);
  expect(B3).toBeLessThanOrEqual(7040);
});
