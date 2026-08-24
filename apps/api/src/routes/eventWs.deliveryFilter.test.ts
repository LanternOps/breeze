/**
 * Delivery filter — audience targeting composed with site scope.
 *
 * THE LEAK THIS GUARDS. EventDispatcher fans out per ORGANIZATION: every
 * connected client of an org sees every event published to that org, and the
 * per-client `filter` predicate is the only thing that narrows it
 * (services/eventDispatcher.ts). So a notification event addressed to one user
 * reaches every other user's socket in that org unless this filter drops it.
 *
 * The second rule is subtler and was nearly a silent outage: `buildSiteFilter`
 * FAILS CLOSED on any event it cannot attribute to an allowed site, and a
 * notification has no siteId. Composing the two with AND would have meant every
 * site-restricted user quietly stopped receiving notifications — a bug that
 * shows up as "I never get notified" from a subset of users, with nothing in
 * the logs.
 */
import { describe, expect, it } from 'vitest';
import { buildDeliveryFilter } from './eventWs';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const SITE_A = 'site-a';

const addressed = (to: string) => ({
  type: 'notification.created',
  orgId: 'org-1',
  audienceUserId: to,
  payload: { notificationId: 'n1' },
});

const siteEvent = (siteId: string) => ({
  type: 'device.online',
  orgId: 'org-1',
  siteId,
  payload: {},
});

describe('buildDeliveryFilter — audience targeting', () => {
  it('delivers an addressed event to its recipient', () => {
    const filter = buildDeliveryFilter(ALICE, null)!;
    expect(filter(addressed(ALICE))).toBe(true);
  });

  it('THE LEAK GUARD: drops an addressed event for every other user in the org', () => {
    // Without this the dispatcher's org-wide fan-out puts Alice's notification
    // on Bob's socket.
    const unrestricted = buildDeliveryFilter(BOB, null)!;
    expect(unrestricted(addressed(ALICE))).toBe(false);

    const siteRestricted = buildDeliveryFilter(BOB, [SITE_A])!;
    expect(siteRestricted(addressed(ALICE))).toBe(false);
  });

  it('a site-restricted user still receives their OWN notifications', () => {
    // The near-miss: buildSiteFilter fails closed on an event with no siteId,
    // so ANDing the two would drop every notification for these users.
    const filter = buildDeliveryFilter(ALICE, [SITE_A])!;
    expect(filter(addressed(ALICE))).toBe(true);
  });

  it('a user restricted to ZERO sites still receives their own notifications', () => {
    const filter = buildDeliveryFilter(ALICE, [])!;
    expect(filter(addressed(ALICE))).toBe(true);
  });
});

describe('buildDeliveryFilter — unaddressed events keep prior behaviour', () => {
  it('an unrestricted user receives ordinary events', () => {
    const filter = buildDeliveryFilter(ALICE, null)!;
    expect(filter(siteEvent(SITE_A))).toBe(true);
    expect(filter({ type: 'device.online', orgId: 'org-1', payload: {} })).toBe(true);
  });

  it('site scope still applies to unaddressed events', () => {
    const filter = buildDeliveryFilter(ALICE, [SITE_A])!;
    expect(filter(siteEvent(SITE_A))).toBe(true);
    expect(filter(siteEvent('site-other'))).toBe(false);
    // Fails closed when the event cannot be attributed to a site at all.
    expect(filter({ type: 'device.online', orgId: 'org-1', payload: {} })).toBe(false);
  });
});

describe('buildDeliveryFilter — malformed audience values', () => {
  it('treats a non-string audienceUserId as unaddressed rather than as a match', () => {
    // Fail towards the EXISTING rules, never towards "deliver to everyone".
    const restricted = buildDeliveryFilter(ALICE, [SITE_A])!;
    for (const bad of [null, 42, {}, [], true]) {
      const event = { type: 'notification.created', orgId: 'org-1', audienceUserId: bad };
      // Unaddressed => site rules apply => no siteId => dropped.
      expect(restricted(event as Record<string, unknown>)).toBe(false);
    }
  });

  it('an empty-string audience matches nobody', () => {
    const filter = buildDeliveryFilter(ALICE, null)!;
    expect(filter({ type: 'notification.created', orgId: 'org-1', audienceUserId: '' })).toBe(false);
  });
});
