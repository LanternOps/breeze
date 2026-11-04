import { expect, it } from 'vitest';
import { listChatSurfaceToolNames } from './aiAgentSdkTools';
import { renderAlwaysOnIndex, renderDomainBlock, renderPageContextToolBlocks } from './aiToolIndex';

it('W15 PR B stays within +128 B of PR A and the existing 7,040 B total cap', () => {
  const names = listChatSurfaceToolNames();
  const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
  const alwaysOn = renderAlwaysOnIndex(names);
  const B1 = bytes(alwaysOn);
  const B2 = bytes(renderDomainBlock('billing', names));
  const largestBlock = Math.max(...(['core', 'devices', 'scripts', 'patching', 'monitoring', 'network', 'security', 'backup', 'tickets', 'billing', 'accounts', 'integrations', 'admin', 'ai'] as const).map((d) => bytes(renderDomainBlock(d, names))));
  const B3 = B1 + bytes(renderPageContextToolBlocks({ type: 'alert', id: 'alert-fixture', title: 'Fixture' } as never, names));
  expect(alwaysOn).toContain('Pax8 orders');
  expect(B1 - 2507).toBeLessThanOrEqual(128);
  expect(B1).toBeLessThan(2560);
  expect(B2).toBeLessThan(2048);
  expect(largestBlock).toBeLessThan(2048);
  expect(B3 - 5270).toBeLessThanOrEqual(128);
  expect(B3).toBeLessThanOrEqual(7040);
  process.stdout.write(`W15 PR B index bytes ${JSON.stringify({ B1, B2, largestBlock, B3, deltaB1: B1 - 2507, deltaB2: B2 - 737, deltaB3: B3 - 5270 })}\n`);
});
