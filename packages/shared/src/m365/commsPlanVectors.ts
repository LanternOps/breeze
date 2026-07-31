import type { BuildCommsSendEffectInput } from './commsEffect';

/**
 * Frozen conformance vectors for `buildCommsSendEffect` → `buildSendPlan` → digest.
 *
 * Companion to `@breeze/shared/canonicalize/vectors`. That corpus pins the *bytes* of
 * canonicalization; this one pins the *transformation* — recipient normalization, the
 * pinned `contentType`/`saveToSentItems`, and the Graph body shape. Both are needed: an
 * executor could canonicalize identically and still build a different plan.
 *
 * Same rule as the canonicalizer corpus: `planDigest` values were computed once and pasted
 * in. They must NEVER be derived at test time, or the suite passes against any
 * implementation including a wrong one.
 *
 * CHANGING A DIGEST HERE IS A BREAKING CHANGE — it invalidates every approved-but-unreleased
 * comms intent, which must then be re-requested and re-approved. That is the correct
 * behaviour for a genuine plan change, and the reason a plan change needs a `planVersion`
 * bump and a deliberate decision rather than an edited constant.
 */

export type CommsPlanVector = {
  name: string;
  /** What this pins, and how it would break unnoticed otherwise. */
  why: string;
  input: BuildCommsSendEffectInput;
  /** sha256(canonicalize(buildSendPlan(buildCommsSendEffect(input)))) — frozen. */
  planDigest: string;
  /** sha256(canonicalize(buildCommsSendEffect(input))) — frozen. */
  envelopeDigest: string;
};

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const SENDER_OID = '33333333-3333-4333-8333-333333333333';

/** The fields every vector shares, so each vector shows only what it is actually varying. */
const base = {
  actionVersion: 1,
  connectionId: CONNECTION_ID,
  tenantId: TENANT_ID,
  senderObjectId: SENDER_OID,
  consentGeneration: 0,
} as const;

export const COMMS_PLAN_VECTORS: readonly CommsPlanVector[] = [
  {
    name: 'minimal-single-recipient',
    why: 'Baseline. Pins the plan skeleton: method, path, pinned contentType and saveToSentItems, and empty cc/bcc arrays present rather than omitted.',
    input: { ...base, to: ['a@example.com'], subject: 'Hello', bodyText: 'Hi there.' },
    planDigest: 'a7d1594f8a9b7f0189af34d489c207d43063b52fbf6c2ccce8dc752380effd0e',
    envelopeDigest: '222fa2b6c8da4026f8ee30f0ddb078708b85ffc92e784a1732c4f4825089f509',
  },
  {
    name: 'recipient-case-and-order-normalized',
    why: 'Two callers writing the same recipients in different case and order must produce the SAME digest. If this ever differs, an approved send could be re-derived into a different digest and refuse to release.',
    input: {
      ...base,
      to: ['B@Example.COM', 'a@example.com'],
      cc: ['C@example.com'],
      subject: 'Case test',
      bodyText: 'body',
    },
    planDigest: 'c30952d2b7dcb4e0be066da26bc5026bb500b0fc6906b9131a21805000ec7ce5',
    envelopeDigest: 'd9084c45082d669b1b4a234bcdf2b3863483fdbf998133c451dbf3af068ea9e2',
  },
  {
    name: 'recipient-duplicates-collapsed',
    why: 'Within-list dedup. A duplicate must not produce a second Graph recipient entry.',
    input: {
      ...base,
      to: ['dup@example.com', 'DUP@example.com', 'other@example.com'],
      subject: 'Dedupe',
      bodyText: 'body',
    },
    planDigest: 'cb95588d2115d3d76af59c70f34996ec051887b1983c01714abd519782f4fb9d',
    envelopeDigest: '0045f6208bc2ac1f6bb3d14006d2691a142637ef18b19e8ea6060ac5d4208052',
  },
  {
    name: 'cross-list-overlap-preserved',
    why: 'The companion to dedup: an address in BOTH to and bcc stays in both. Silently dropping the bcc copy would change who is blind-copied — a modification of an approved effect.',
    input: {
      ...base,
      to: ['both@example.com'],
      bcc: ['both@example.com'],
      subject: 'Overlap',
      bodyText: 'body',
    },
    planDigest: '3a2f74b6f7dde6674931222657724da76ff1db170cb780fab38933409b1e36ec',
    envelopeDigest: '635fd67ae8e008a704af9b79bcad955f50f7cf5300834b941187da6ad3274736',
  },
  {
    name: 'bcc-populated',
    why: 'Pins that bcc reaches bccRecipients and not ccRecipients. A transposition here is invisible to the sender and to every recipient — the exact failure the plan digest exists to catch.',
    input: {
      ...base,
      to: ['to@example.com'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      subject: 'Three fields',
      bodyText: 'body',
    },
    planDigest: '0ffd79cfd67e36309010e68da20c6ed485afe776d77cce574d26145ff11e7c66',
    envelopeDigest: 'e46b2964871d7def7b862e26727a9bc07cd9132108d0715e4f449ac4fe1a74d0',
  },
  {
    name: 'crlf-body-preserved',
    why: 'Mail bodies carry CRLF. Nothing between approval and Graph may rewrite line endings.',
    input: {
      ...base,
      to: ['a@example.com'],
      subject: 'Multi-line',
      bodyText: 'Line one\r\nLine two\r\n\r\nRegards,\r\nThe team\r\n',
    },
    planDigest: 'f073e07cddde33e6c52c782214e396fb5603adf766dd9dc81a4da4a629fd0f43',
    envelopeDigest: '6e83a350254c37a2bb821c48b3a52de234e4c804a5427698e3289c7f77537155',
  },
  {
    name: 'astral-subject-and-body',
    why: 'Non-BMP characters survive the envelope and the plan unchanged.',
    input: {
      ...base,
      to: ['a@example.com'],
      subject: 'Deploy \u{1F680} complete',
      bodyText: 'Status: \u{1F600}\u{1D11E}\u{20BB7}',
    },
    planDigest: '39865d578c8e39a4c3714d0837d4732023d55fafe4416d016a9eb55191a8fe03',
    envelopeDigest: '13a47f44252b26071f26d25fac0e4620cad32e351f52cd51d5b59163546cd7bb',
  },
  {
    name: 'non-normalized-unicode-subject',
    why: 'A decomposed é must not be folded into a precomposed one anywhere in the envelope or plan — the approver read one of these, and only that one may be sent.',
    input: {
      ...base,
      to: ['a@example.com'],
      subject: 'Résumé attached',
      bodyText: 'See attached.',
    },
    planDigest: '0be18b101fd1652d8e01512b692885155fbfada1672a1967554fabfbba1e5d46',
    envelopeDigest: '301342f8b3ea8b9002e3c29b7a30b4b9237182cc1ec2b24c8df3728d20b779e8',
  },
  {
    name: 'consent-generation-changes-envelope-digest-only',
    why:
      'Same content as `minimal-single-recipient`, generation 1 instead of 0. It changes the ' +
      'envelope digest and leaves the plan digest BYTE-IDENTICAL, because the plan carries only ' +
      'the Graph operation and none of the binding fields. Resolved 2026-07-29 (design §5.3(b)): ' +
      'the signed JWT carries BOTH digests — effectDigest = the stored intent.argumentDigest ' +
      '(envelope), planDigest persisted at creation — and the executor recomputes both from the ' +
      'received envelope. Neither subsumes the other, which is exactly the asymmetry this vector ' +
      'pins: it fails loudly if the plan starts or stops covering the binding.',
    input: {
      ...base,
      consentGeneration: 1,
      to: ['a@example.com'],
      subject: 'Hello',
      bodyText: 'Hi there.',
    },
    planDigest: 'a7d1594f8a9b7f0189af34d489c207d43063b52fbf6c2ccce8dc752380effd0e',
    envelopeDigest: 'd8d0f8153286cddffa0b7f379b544274afbac222e85f168ea31c81a8cd11608e',
  },
  {
    name: 'max-recipients-at-cap',
    why: 'Exactly 20 recipients — the cap boundary, which an off-by-one in either direction would move.',
    input: {
      ...base,
      to: Array.from({ length: 12 }, (_, i) => `to${String(i).padStart(2, '0')}@example.com`),
      cc: Array.from({ length: 5 }, (_, i) => `cc${i}@example.com`),
      bcc: Array.from({ length: 3 }, (_, i) => `bcc${i}@example.com`),
      subject: 'Wide distribution',
      bodyText: 'body',
    },
    planDigest: 'acdce6defa6b229c351191301a5e348b6740ae153eb265e15486366a29d96daa',
    envelopeDigest: '4c8eed320d2b1bef996fbcfe2f42e245ac76961865953a7b1922e8245ba15570',
  },
] as const;
