import { expect, it } from 'vitest';
import { listChatSurfaceToolNames } from './aiAgentSdkTools';
import { renderAlwaysOnIndex, renderDomainBlock, renderPageContextToolBlocks, renderToolIndexByDomain } from './aiToolIndex';

const DOMAINS = ['core', 'devices', 'scripts', 'patching', 'monitoring', 'network', 'security', 'backup', 'tickets', 'billing', 'accounts', 'integrations', 'admin', 'ai'] as const;

it('W18 PR A (#6789) stays inside every lazy-index bound with no +128 B step', () => {
  const names = listChatSurfaceToolNames();
  const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
  const alwaysOn = renderAlwaysOnIndex(names);
  const B1 = bytes(alwaysOn);
  const accounts = bytes(renderDomainBlock('accounts', names));
  const admin = bytes(renderDomainBlock('admin', names));
  const security = bytes(renderDomainBlock('security', names));
  const largestBlock = Math.max(...DOMAINS.map((d) => bytes(renderDomainBlock(d, names))));
  const alertTurn = B1 + bytes(renderPageContextToolBlocks({ type: 'alert', id: 'alert-fixture', title: 'Fixture' } as never, names));
  const orgTurn = B1 + bytes(renderPageContextToolBlocks({ type: 'record', kind: 'organization', id: 'org-fixture', title: 'Fixture' } as never, names));
  const full = bytes(renderToolIndexByDomain(names));

  // Every W18 PR A tool reaches its domain block, and the vocabulary names the new subjects.
  for (const tool of ['get_org_summary', 'get_account_readiness', 'list_portal_users']) expect(renderDomainBlock('accounts', names)).toContain(tool);
  for (const tool of ['list_users', 'get_user', 'list_roles']) expect(renderDomainBlock('admin', names)).toContain(tool);
  expect(renderDomainBlock('security', names)).toContain('get_audit_retention');
  expect(alwaysOn).toContain('users and roles');
  expect(alwaysOn).toContain('key dates, portal');

  expect(B1).toBeLessThan(2560);
  expect(largestBlock).toBeLessThan(2048);
  expect(alertTurn).toBeLessThan(7040);
  expect(orgTurn).toBeLessThan(7040);
  process.stdout.write(`W18 PR A index bytes ${JSON.stringify({ B1, accounts, admin, security, largestBlock, alertTurn, orgTurn, full })}\n`);
});

it('W18 PR B (#6789): the two writers land in lazy blocks; the always-on index is byte-identical to PR A + W17', () => {
  const names = listChatSurfaceToolNames();
  const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
  const B1 = bytes(renderAlwaysOnIndex(names));
  const accounts = bytes(renderDomainBlock('accounts', names));
  const admin = bytes(renderDomainBlock('admin', names));
  const largestBlock = Math.max(...DOMAINS.map((d) => bytes(renderDomainBlock(d, names))));
  const alertTurn = B1 + bytes(renderPageContextToolBlocks({ type: 'alert', id: 'alert-fixture', title: 'Fixture' } as never, names));
  const orgTurn = B1 + bytes(renderPageContextToolBlocks({ type: 'record', kind: 'organization', id: 'org-fixture', title: 'Fixture' } as never, names));
  const full = bytes(renderToolIndexByDomain(names));

  expect(renderDomainBlock('accounts', names)).toContain('manage_org_portal_settings (get/update/set_sensitive_access)');
  expect(renderDomainBlock('admin', names)).toContain('manage_report_recipients (list/add/remove/convert)');
  // No vocabulary change: PR B adds tools to domains that already have some, so B1 cannot move (W19-D1).
  expect(B1).toBe(2551);
  expect(largestBlock).toBeLessThan(2048);
  expect(alertTurn).toBeLessThan(7040);
  expect(orgTurn).toBeLessThan(7040);
  process.stdout.write(`W18 PR B index bytes ${JSON.stringify({ B1, accounts, admin, largestBlock, alertTurn, orgTurn, full })}\n`);
});
