/**
 * Real-Postgres proof for evaluateHardDenies (Task 5.3 fix round 1).
 *
 * The unit suite (services/partnerTrustPromotion.test.ts) mocks db.execute
 * entirely, so it can't catch a bug in the raw SQL itself — which is exactly
 * where two CRITICAL issues were found in review: the suspended-partner joins
 * never excluded the target partner from matching itself, and the
 * email-domain corroboration axis treated a shared free-mail domain
 * (gmail.com, etc.) as identity. This suite runs the real query against a
 * real database to prove both fixes and pin the intended axis semantics.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { auditLogs, partners } from '../../db/schema';
import type { IpClass, PartnerTrustState } from '../../db/schema/orgs';
import { evaluateHardDenies } from '../../services/partnerTrustPromotion';
import { createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function setPartnerFields(partnerId: string, fields: {
  trustState?: PartnerTrustState;
  signupIp?: string;
  signupIpClass?: IpClass;
  billingCardFingerprint?: string | null;
}) {
  await withSystemDbAccessContext(() => db
    .update(partners)
    .set(fields)
    .where(eq(partners.id, partnerId)));
}

/** Records the audit-log row evaluateHardDenies looks for to identify a
 * partner as "suspended for abuse" within the last 90 days. */
async function markSuspendedForAbuse(partnerId: string, timestamp: Date = new Date()) {
  await withSystemDbAccessContext(() => db.insert(auditLogs).values({
    orgId: null,
    timestamp,
    actorType: 'system',
    actorId: randomUUID(),
    actorEmail: null,
    action: 'partner.suspended_for_abuse',
    resourceType: 'partner',
    resourceId: partnerId,
    result: 'success',
  }));
}

describe('evaluateHardDenies — real Postgres (Task 5.3 fix round 1)', () => {
  runDb('restricts a probation partner that signed up over Tor', async () => {
    const partner = await createPartner();
    await setPartnerFields(partner.id, { trustState: 'probation', signupIpClass: 'tor' });

    const decision = await evaluateHardDenies(partner.id);

    expect(decision).toEqual({
      restrict: true,
      reason: 'auto:tor_signup',
      evidence: { matchedAxes: ['signup_ip_class'], signupIpClass: 'tor' },
    });
  });

  runDb('does not restrict on a shared /24 with a suspended-for-abuse partner alone', async () => {
    const suspended = await createPartner({ status: 'suspended' });
    await setPartnerFields(suspended.id, { signupIp: '203.0.113.5' });
    await markSuspendedForAbuse(suspended.id);

    const target = await createPartner();
    await setPartnerFields(target.id, {
      trustState: 'probation',
      signupIpClass: 'residential',
      signupIp: '203.0.113.240', // same /24 as 203.0.113.5, no other axis
    });

    const decision = await evaluateHardDenies(target.id);

    expect(decision).toEqual({ restrict: false });
  });

  runDb('restricts on a shared /24 plus a shared non-free-mail domain, naming both axes', async () => {
    const suspended = await createPartner({ status: 'suspended' });
    await setPartnerFields(suspended.id, { signupIp: '203.0.113.5' });
    await markSuspendedForAbuse(suspended.id);
    await createUser({ partnerId: suspended.id, email: 'bob@corp-example.com' });

    const target = await createPartner();
    await setPartnerFields(target.id, {
      trustState: 'probation',
      signupIpClass: 'residential',
      signupIp: '203.0.113.240',
    });
    await createUser({ partnerId: target.id, email: 'alice@corp-example.com' });

    const decision = await evaluateHardDenies(target.id);

    expect(decision).toEqual({
      restrict: true,
      reason: 'auto:corroborated_suspended_network',
      evidence: {
        matchedAxes: ['network_prefix', 'email_domain'],
        matchedSuspendedPartnerId: suspended.id,
        network: {
          candidateIp: '203.0.113.240',
          suspendedIp: '203.0.113.5',
          prefixLength: 24,
        },
        corroboration: { type: 'email_domain', value: 'corp-example.com' },
      },
    });
  });

  runDb('does not restrict on a shared /24 plus both sides sharing gmail.com', async () => {
    const suspended = await createPartner({ status: 'suspended' });
    await setPartnerFields(suspended.id, { signupIp: '203.0.113.5' });
    await markSuspendedForAbuse(suspended.id);
    await createUser({ partnerId: suspended.id, email: 'bob@gmail.com' });

    const target = await createPartner();
    await setPartnerFields(target.id, {
      trustState: 'probation',
      signupIpClass: 'residential',
      signupIp: '203.0.113.240',
    });
    await createUser({ partnerId: target.id, email: 'alice@gmail.com' });

    const decision = await evaluateHardDenies(target.id);

    expect(decision).toEqual({ restrict: false });
  });

  runDb('restricts on a shared billing card fingerprint with a suspended-for-abuse partner', async () => {
    const suspended = await createPartner({ status: 'suspended' });
    await setPartnerFields(suspended.id, { billingCardFingerprint: 'fp_shared_card_1' });
    await markSuspendedForAbuse(suspended.id);

    const target = await createPartner();
    await setPartnerFields(target.id, {
      trustState: 'probation',
      billingCardFingerprint: 'fp_shared_card_1',
    });

    const decision = await evaluateHardDenies(target.id);

    expect(decision).toEqual({
      restrict: true,
      reason: 'auto:fraud_identity_match',
      evidence: {
        matchedAxes: ['billing_card_fingerprint', 'suspended_for_abuse'],
        matchedSuspendedPartnerId: suspended.id,
      },
    });
  });

  runDb('never treats a partner that suspended itself as its own corroborating match', async () => {
    // The target is, unusually, both trust_state='probation' and
    // status='suspended' with its own abuse audit-log row — every axis
    // (card fingerprint, network /24, email domain) trivially "matches"
    // itself unless the query explicitly excludes s.id = t.id.
    const target = await createPartner({ status: 'suspended' });
    await setPartnerFields(target.id, {
      trustState: 'probation',
      signupIpClass: 'residential',
      signupIp: '198.51.100.50',
      billingCardFingerprint: 'fp_self_match',
    });
    await markSuspendedForAbuse(target.id);
    await createUser({ partnerId: target.id, email: 'self@corp-example.com' });

    const decision = await evaluateHardDenies(target.id);

    expect(decision).toEqual({ restrict: false });
  });

  runDb('restricts on an IPv6 /64 match plus a shared non-free-mail domain', async () => {
    const suspended = await createPartner({ status: 'suspended' });
    await setPartnerFields(suspended.id, { signupIp: '2001:db8:1234:5678::99' });
    await markSuspendedForAbuse(suspended.id);
    await createUser({ partnerId: suspended.id, email: 'bob@corp-example.com' });

    const target = await createPartner();
    await setPartnerFields(target.id, {
      trustState: 'probation',
      signupIpClass: 'residential',
      signupIp: '2001:db8:1234:5678::10', // same /64 as suspended's IPv6
    });
    await createUser({ partnerId: target.id, email: 'alice@corp-example.com' });

    const decision = await evaluateHardDenies(target.id);

    expect(decision).toEqual({
      restrict: true,
      reason: 'auto:corroborated_suspended_network',
      evidence: {
        matchedAxes: ['network_prefix', 'email_domain'],
        matchedSuspendedPartnerId: suspended.id,
        network: {
          candidateIp: '2001:db8:1234:5678::10',
          suspendedIp: '2001:db8:1234:5678::99',
          prefixLength: 64,
        },
        corroboration: { type: 'email_domain', value: 'corp-example.com' },
      },
    });
  });
});
