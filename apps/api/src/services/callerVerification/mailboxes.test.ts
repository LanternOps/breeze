import { beforeEach, expect, it, vi } from 'vitest';

const read = vi.hoisted(() => vi.fn());
vi.mock('./mailboxBackends', () => ({ fetchMailboxResourceByOrg: read }));

import { fetchTargetMailboxes } from './mailboxes';
import { callerVerificationPorts } from './ports';

const subject = { entraTenantId: '11111111-1111-4111-8111-111111111111', entraOid: '22222222-2222-4222-8222-222222222222' };
beforeEach(() => vi.clearAllMocks());

it('normalizes target UPN, mail, and SMTP aliases only', async () => {
  read.mockResolvedValue({ id: subject.entraOid.toUpperCase(), userPrincipalName: 'Alex@Example.com', mail: 'Primary@Example.com',
    proxyAddresses: ['SMTP:Primary@Example.com', 'smtp:Alias@Example.com', 'X500:/o=legacy', 'SIP:alex@example.com'] });
  expect(await fetchTargetMailboxes('org-A', subject)).toEqual(new Set(['alex@example.com', 'primary@example.com', 'alias@example.com']));
  expect(read).toHaveBeenCalledWith('org-A', subject);
});

it('keeps a null mail and an explicitly empty alias list', async () => {
  read.mockResolvedValue({ id: subject.entraOid, userPrincipalName: 'alex@example.com', mail: null, proxyAddresses: [] });
  expect(await fetchTargetMailboxes('org-A', subject)).toEqual(new Set(['alex@example.com']));
});

it.each([
  ['missing aliases', { id: subject.entraOid, userPrincipalName: 'alex@example.com', mail: null }],
  ['a rebound object', { id: '33333333-3333-4333-8333-333333333333', userPrincipalName: 'alex@example.com', mail: null, proxyAddresses: [] }],
  ['a null alias', { id: subject.entraOid, userPrincipalName: 'alex@example.com', mail: null, proxyAddresses: [null] }],
  ['no UPN', { id: subject.entraOid, mail: null, proxyAddresses: [] }],
  ['a non-object', ['alex@example.com']],
])('fails closed for %s', async (_label, resource) => {
  read.mockResolvedValue(resource);
  await expect(fetchTargetMailboxes('org-A', subject)).rejects.toThrow();
});

it('propagates backend failure instead of returning an empty set', async () => {
  read.mockRejectedValue(new Error('executor unavailable'));
  await expect(fetchTargetMailboxes('org-A', subject)).rejects.toThrow('executor unavailable');
});

it('is the default mailbox port', async () => {
  read.mockResolvedValue({ id: subject.entraOid, userPrincipalName: 'alex@example.com', mail: null, proxyAddresses: ['smtp:a@example.com'] });
  expect((await callerVerificationPorts.mailboxes({ orgId: 'org-A', target: subject })).sort()).toEqual(['a@example.com', 'alex@example.com']);
});
