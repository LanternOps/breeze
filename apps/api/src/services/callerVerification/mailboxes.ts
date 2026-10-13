/**
 * The target's canonical mailbox set (#6354 W03, spec "Same-mailbox rule").
 *
 * An email challenge delivered to an address the TARGET itself receives
 * proves nothing (the attacker driving a password reset may already read that
 * mailbox), so the gate refuses an email candidate whose destination is in
 * this set. The set comes from the target's pinned Entra object id: UPN,
 * primary mail and every SMTP proxy address, lower-cased. Non-SMTP proxies
 * (X500/SIP/…) are not mailboxes and are ignored.
 *
 * Fails closed: incomplete data (no alias list, a null alias, a different
 * object id) or any backend failure throws — it never becomes an empty set.
 */
import { z } from 'zod';
import type { EntraSubject } from './types';
import { fetchMailboxResourceByOrg } from './mailboxBackends';

const mailboxResource = z.object({
  id: z.string().guid(),
  userPrincipalName: z.string().min(1),
  mail: z.string().nullable(),
  proxyAddresses: z.array(z.string()),
});

export async function fetchTargetMailboxes(orgId: string, subject: EntraSubject): Promise<Set<string>> {
  const row = mailboxResource.parse(await fetchMailboxResourceByOrg(orgId, subject));
  if (row.id.toLowerCase() !== subject.entraOid.toLowerCase()) throw new Error('subject_mailboxes_unknown');
  const set = new Set([
    row.userPrincipalName,
    ...(row.mail === null ? [] : [row.mail]),
    ...row.proxyAddresses.filter((value) => /^smtp:/i.test(value)).map((value) => value.slice(5)),
  ].map((value) => value.trim().toLowerCase()).filter(Boolean));
  // A real Entra user always has a UPN; an empty set would read as "no
  // mailbox in common" and let a same-mailbox email grant through.
  if (set.size === 0 || !row.userPrincipalName.trim()) throw new Error('subject_mailboxes_unknown');
  return set;
}
