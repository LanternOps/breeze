import { describe, it, expect } from 'vitest';
import { canonicalizeArguments } from '../canonicalize/index';
import { buildCommsSendEffect } from './commsEffect';
import { COMMS_SEND_PLAN_VERSION, buildSendPlan } from './commsPlan';
import { computeCommsEnvelopeDigest, computeCommsPlanDigest } from './commsDigests';
import { COMMS_PLAN_VECTORS } from './commsPlanVectors';

const base = {
  actionVersion: 1,
  connectionId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  senderObjectId: '33333333-3333-4333-8333-333333333333',
  consentGeneration: 0,
};

const envelope = buildCommsSendEffect({
  ...base,
  to: ['to@example.com'],
  cc: ['cc@example.com'],
  bcc: ['bcc@example.com'],
  subject: 'Subject line',
  bodyText: 'Body text',
});

describe('buildSendPlan', () => {
  const plan = buildSendPlan(envelope);

  it('pins the version, method, and path', () => {
    expect(plan.planVersion).toBe(COMMS_SEND_PLAN_VERSION);
    expect(plan.method).toBe('POST');
    expect(plan.path).toBe('/me/sendMail');
  });

  it('emits the literal Graph body, so nothing is left to construct', () => {
    // The executor's send path is JSON.stringify(plan.body) and nothing else. If this shape
    // ever stops being the wire payload, a reshaping step reappears after digest
    // verification and the plan digest stops covering what is actually sent.
    expect(plan.body).toEqual({
      message: {
        subject: 'Subject line',
        body: { contentType: 'Text', content: 'Body text' },
        toRecipients: [{ emailAddress: { address: 'to@example.com' } }],
        ccRecipients: [{ emailAddress: { address: 'cc@example.com' } }],
        bccRecipients: [{ emailAddress: { address: 'bcc@example.com' } }],
      },
      saveToSentItems: true,
    });
  });

  it('routes bcc to bccRecipients and not to cc or to', () => {
    // A transposition here is invisible to the sender and to every recipient.
    expect(plan.body.message.bccRecipients).toEqual([{ emailAddress: { address: 'bcc@example.com' } }]);
    expect(plan.body.message.ccRecipients).not.toContainEqual({ emailAddress: { address: 'bcc@example.com' } });
    expect(plan.body.message.toRecipients).not.toContainEqual({ emailAddress: { address: 'bcc@example.com' } });
  });

  it('pins contentType to Text rather than inferring it', () => {
    // Inferring would let the same approved bytes be delivered as HTML — different
    // rendering, different link behaviour, different effect, identical envelope.
    const htmlish = buildCommsSendEffect({
      ...base,
      to: ['a@example.com'],
      subject: 's',
      bodyText: '<b>bold</b><script>alert(1)</script>',
    });
    expect(buildSendPlan(htmlish).body.message.body.contentType).toBe('Text');
  });

  it('always saves to sent items', () => {
    // The person whose identity was used must be able to see what was said in their name.
    expect(plan.body.saveToSentItems).toBe(true);
  });

  it('emits empty recipient arrays rather than omitting the keys', () => {
    const minimal = buildSendPlan(
      buildCommsSendEffect({ ...base, to: ['a@example.com'], subject: 's', bodyText: 'b' })
    );
    expect(minimal.body.message.ccRecipients).toEqual([]);
    expect(minimal.body.message.bccRecipients).toEqual([]);
  });

  it('is deterministic — the same envelope yields byte-identical canonical output', () => {
    expect(canonicalizeArguments(buildSendPlan(envelope))).toBe(canonicalizeArguments(buildSendPlan(envelope)));
  });

  it('does not mutate the envelope', () => {
    const before = canonicalizeArguments(envelope);
    buildSendPlan(envelope);
    expect(canonicalizeArguments(envelope)).toBe(before);
  });
});

describe('the two digests cover different things', () => {
  const generationBumped = buildCommsSendEffect({ ...base, consentGeneration: 1, to: ['to@example.com'], cc: ['cc@example.com'], bcc: ['bcc@example.com'], subject: 'Subject line', bodyText: 'Body text' });

  it('envelope digest changes when only the binding changes', () => {
    expect(computeCommsEnvelopeDigest(generationBumped)).not.toBe(computeCommsEnvelopeDigest(envelope));
  });

  it('plan digest does NOT change when only the binding changes', () => {
    // Pinned deliberately: the plan carries the Graph operation and none of the binding
    // fields, which is exactly why the envelope digest cannot be dropped in favour of it.
    expect(computeCommsPlanDigest(generationBumped)).toBe(computeCommsPlanDigest(envelope));
  });

  it('both digests change when the content changes', () => {
    const edited = buildCommsSendEffect({ ...base, to: ['to@example.com'], cc: ['cc@example.com'], bcc: ['bcc@example.com'], subject: 'Subject line', bodyText: 'Body text.' });
    expect(computeCommsEnvelopeDigest(edited)).not.toBe(computeCommsEnvelopeDigest(envelope));
    expect(computeCommsPlanDigest(edited)).not.toBe(computeCommsPlanDigest(envelope));
  });

  it('plan digest changes when a recipient moves between fields', () => {
    // The failure the plan digest exists for: same people, different Graph field.
    const moved = buildCommsSendEffect({ ...base, to: ['to@example.com'], cc: ['bcc@example.com'], bcc: ['cc@example.com'], subject: 'Subject line', bodyText: 'Body text' });
    expect(computeCommsPlanDigest(moved)).not.toBe(computeCommsPlanDigest(envelope));
  });
});

/**
 * The cross-package contract. The executor becomes the second consumer of this corpus at
 * task 8; expectations are frozen constants and are never recomputed here.
 */
describe('frozen plan vectors', () => {
  it.each(COMMS_PLAN_VECTORS.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    const built = buildCommsSendEffect(vector.input);
    expect(computeCommsEnvelopeDigest(built)).toBe(vector.envelopeDigest);
    expect(computeCommsPlanDigest(built)).toBe(vector.planDigest);
  });

  it('has unique names and well-formed digests', () => {
    expect(new Set(COMMS_PLAN_VECTORS.map((v) => v.name)).size).toBe(COMMS_PLAN_VECTORS.length);
    for (const v of COMMS_PLAN_VECTORS) {
      expect(v.planDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(v.envelopeDigest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('has a distinct envelope digest for every vector', () => {
    expect(new Set(COMMS_PLAN_VECTORS.map((v) => v.envelopeDigest)).size).toBe(COMMS_PLAN_VECTORS.length);
  });
});
