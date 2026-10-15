import { createHash } from 'node:crypto';
import type { EndpointMessageSendInput } from '@breeze/shared';

const sortedIds = (ids: readonly string[] | undefined): string[] => [...(ids ?? [])].sort();

/**
 * SHA-256 of a canonical JSON of everything that decides WHAT is sent and to
 * WHOM. Binds an idempotency key to its request so a reused messageId with a
 * different payload is a conflict, not a silent replay of the old response.
 * `confirmedCount` and `messageId` are deliberately excluded: the 409-confirm
 * resend reuses the id with the count added.
 */
export function computeSendFingerprint(input: EndpointMessageSendInput): string {
  const t = input.targets ?? {};
  const canonical = JSON.stringify({
    targets: {
      deviceIds: sortedIds(t.deviceIds),
      siteIds: sortedIds(t.siteIds),
      deviceGroupIds: sortedIds(t.deviceGroupIds),
      orgId: t.orgId ?? null,
    },
    title: input.title,
    body: input.body,
    severity: input.severity,
    requiresAck: input.requiresAck,
    expiresInMinutes: input.expiresInMinutes ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
