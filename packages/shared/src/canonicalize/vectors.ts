/**
 * Frozen conformance vectors for the canonicalizer.
 *
 * WHY THESE ARE HARD-CODED: every `digest` below was computed once and pasted in. They
 * must NEVER be derived at test time by calling `computeArgumentDigest`, because the
 * whole point is to catch a *second* implementation drifting from this one. A test that
 * computes its own expectation passes against any implementation, including a wrong one,
 * and that is precisely the failure this corpus exists to prevent (design risk #4:
 * "if the executor ever reimplements canonicalization, every digest check silently
 * becomes a self-consistency check").
 *
 * Consumers: `@breeze/shared` itself, `apps/api` (via `services/actionIntents/canonicalize`),
 * and — once it exists — the M365 communications executor. Each runs the same corpus
 * through its own import path.
 *
 * CHANGING A DIGEST HERE IS A BREAKING CHANGE. A stored `argument_digest` in
 * `action_intents` was computed under these bytes; altering canonicalization invalidates
 * every approved-but-unreleased intent. If a change is genuinely required it needs a
 * versioned canonicalizer and a migration story, not an edited constant.
 */

/** Deterministic filler of a given length, built from a repeating non-trivial pattern. */
function filler(length: number, pattern: string): string {
  return pattern.repeat(Math.ceil(length / pattern.length)).slice(0, length);
}

/** 32 KiB of mixed ASCII — the mail-body size ceiling the comms catalog allows. */
export const BODY_32KIB_ASCII = filler(32 * 1024, 'The quick brown fox jumps over the lazy dog. 0123456789 ');

/**
 * 32 KiB of astral-plane characters. Length is in UTF-16 code units, so this is
 * 16384 code points, each a surrogate pair — the case where a byte-oriented and a
 * code-unit-oriented implementation diverge.
 */
export const BODY_32KIB_ASTRAL = filler(32 * 1024, '\u{1F600}\u{1D11E}\u{20BB7}');

export interface CanonicalizationVector {
  /** Stable identifier; used in test names on both sides. */
  name: string;
  /** What this vector pins, and why it would be missed without it. */
  why: string;
  input: Record<string, unknown>;
  /**
   * Frozen canonical JSON. Omitted only for the oversized vectors, where inlining
   * 32 KiB of expected output would bury the corpus — those pin the digest alone.
   */
  canonical?: string;
  /** Frozen SHA-256 hex of the canonical form. Never recompute. */
  digest: string;
}

export const CANONICALIZATION_VECTORS: readonly CanonicalizationVector[] = [
  {
    name: 'empty-object',
    why: 'Degenerate input; pins that an empty envelope still digests rather than throwing.',
    input: {},
    canonical: '{}',
    digest: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  },
  {
    name: 'key-order-independent',
    why: 'The core property: an approver and an executor may serialize the same object with different key insertion order.',
    input: { subject: 'Re: ticket', to: ['a@example.com'], from: 'tech@msp.example' },
    canonical: '{"from":"tech@msp.example","subject":"Re: ticket","to":["a@example.com"]}',
    digest: '1c47931a5550bfa6d540c3b4ae5b9d8b2bbabeae0f23361295e190c9944f55c3',
  },
  {
    name: 'nested-key-order-independent',
    why: 'Sorting must recurse; a shallow sort passes the previous vector and fails this one.',
    input: { z: { b: 1, a: 2 }, a: 3 },
    canonical: '{"a":3,"z":{"a":2,"b":1}}',
    digest: 'c2438635795c82ca61e79ff7d3296a32531ab55ea2e02178ecb8a9ec064f538f',
  },
  {
    name: 'array-order-significant',
    why: 'Recipient order must NOT be sorted away — [a,b] and [b,a] are different sends.',
    input: { to: ['b@example.com', 'a@example.com'] },
    canonical: '{"to":["b@example.com","a@example.com"]}',
    digest: 'b18c71dcd35a973cd779defb472df7d69fba8fd6490ec0aa93c03cc4e13f3524',
  },
  {
    name: 'undefined-dropped-at-keys',
    why: 'An absent optional field and an explicitly-undefined one must digest identically.',
    input: { a: 1, b: undefined, c: 2 },
    canonical: '{"a":1,"c":2}',
    digest: 'fe4fe01ca204b3f3408bd6c7c2b039500701c124753442eeaab96c1dd08257e9',
  },
  {
    name: 'undefined-becomes-null-in-arrays',
    why: 'Array holes are not dropped, they null out; pins the asymmetry with object keys.',
    input: { arr: [1, undefined, 3] },
    canonical: '{"arr":[1,null,3]}',
    digest: '15b01a2d5507678e45ab33bd75df4b9d03b2dc04fd8f1afd883d7588d1d83ae0',
  },
  {
    name: 'null-and-primitives',
    why: 'Pins primitive rendering (no number reformatting, no boolean coercion).',
    input: { nullish: null, str: 'test', num: 42, negZero: -0, bool: true },
    canonical: '{"bool":true,"negZero":0,"nullish":null,"num":42,"str":"test"}',
    digest: 'c3f4ad963118114e6bc19fa2de70db45867e3e9b441c4cd44c33baf095df76e1',
  },
  {
    name: 'unicode-non-bmp',
    why: 'Astral characters in a subject line; a UCS-2-assuming implementation mangles these.',
    input: { subject: 'Deploy \u{1F680} to \u{1D400}\u{1D401}', body: '\u{20BB7}\u{1F1FA}\u{1F1F8}' },
    canonical: '{"body":"\u{20BB7}\u{1F1FA}\u{1F1F8}","subject":"Deploy \u{1F680} to \u{1D400}\u{1D401}"}',
    digest: '0041d9a508f0ca5592cbc5c850168967ebc4138b22520a3f785f120b231e923e',
  },
  {
    name: 'lone-surrogate-escaped',
    why: 'Well-formed JSON.stringify (ES2019) escapes lone surrogates rather than emitting invalid UTF-8. Pins that behaviour, which differs across languages and older runtimes.',
    input: { body: 'before\uD800after' },
    canonical: '{"body":"before\\ud800after"}',
    digest: 'cdc46fb83cd76b1aef4c9bbd4430070545a122bff2d2186018aa8c5bb2c82a7c',
  },
  {
    name: 'surrogate-adjacent-pair-intact',
    why: 'A valid pair adjacent to a lone surrogate must not be recombined or split by the escaping path.',
    input: { body: '😀\uD800😀' },
    digest: 'b835763094337e2912f14bef1fa8b3e593cc13c92f85a7af2f7d4d9899ec9cb1',
  },
  {
    name: 'crlf-preserved',
    why: 'Mail bodies carry CRLF. Nothing may normalize line endings — the sent bytes are what was approved.',
    input: { body: 'line one\r\nline two\r\n' },
    canonical: '{"body":"line one\\r\\nline two\\r\\n"}',
    digest: '386c36d8f996ddcb3f85957ead5be1f8f2140c39f7762f5c8ef4b265a06b6f71',
  },
  {
    name: 'lf-only-differs-from-crlf',
    why: 'Companion to the previous vector: proves the CRLF pin is falsifiable rather than incidentally equal.',
    input: { body: 'line one\nline two\n' },
    canonical: '{"body":"line one\\nline two\\n"}',
    digest: 'ea425c3bf4eed990939c42cd65eb30bdc3b9e75031997c6dcf5f9c7b1c9d1509',
  },
  {
    name: 'no-unicode-normalization',
    why: 'Precomposed U+00E9 and decomposed e+U+0301 render identically to a human and MUST digest differently — an executor that NFC-normalizes would send content the approver never saw.',
    input: { subject: 'café', alt: 'café' },
    canonical: '{"alt":"café","subject":"café"}',
    digest: 'e4623a12890972c9521acb92692f6ed8ca90b1ad9d95f354b97bc4a026c4682d',
  },
  {
    name: 'invisible-controls-survive',
    why: 'Zero-width and bidi-override characters are a display-spoofing vector (§5.4 neutralizes them at render time). Canonicalization must carry them verbatim so the digest covers what is actually sent.',
    input: { subject: 'Invoice​‮fdp.exe', body: 'ok﻿' },
    digest: 'a504d657bdb8dfb0ed69cce96f32c175686ffa852c50e1e0c32e9fa250e8c1ed',
  },
  {
    name: 'deeply-nested',
    why: 'Recursion depth; a stack-limited reimplementation fails here rather than in production.',
    input: { a: { b: { c: { d: { e: { f: { g: { h: 'deep' } } } } } } } },
    canonical: '{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":"deep"}}}}}}}}',
    digest: '76e2f0ef7d04c206559d0de4c39f5129f21d35159d1ececae54f2c6e638c1456',
  },
  {
    name: 'body-32kib-ascii',
    why: 'The catalog size ceiling. Pins that nothing truncates, chunks, or streams differently at scale.',
    input: { body: BODY_32KIB_ASCII },
    digest: 'e77253d2e1742fb0d290f22b573cddb2c7df7d2952e918efb77e645a752862ee',
  },
  {
    name: 'body-32kib-astral',
    why: '32 KiB of surrogate pairs — the worst case for any implementation that conflates code units with characters or bytes.',
    input: { body: BODY_32KIB_ASTRAL },
    digest: '3c31c834553a2428273235f5e33d2a715729bc2ed4afb1a23f91309983029173',
  },
  {
    name: 'realistic-send-envelope',
    why: 'End-to-end shape resembling an actual comms send, so the corpus is not purely synthetic.',
    input: {
      action: 'm365.mail.send',
      version: 1,
      sender: { upn: 'tech@msp.example', objectId: '00000000-0000-0000-0000-000000000001' },
      to: ['first@customer.example', 'second@customer.example'],
      cc: [],
      bcc: ['archive@msp.example'],
      subject: 'Maintenance window — Saturday 02:00 UTC',
      body: 'Hello,\r\n\r\nWe will patch your servers.\r\n\r\nRegards,\r\nThe team\r\n',
    },
    digest: 'c139cba98de004ba20a424501a58ec4b89460b3b02503907968d6994fd294c0d',
  },
] as const;

/**
 * Frozen conformance vectors for the EFFECT-SET envelope (Recipe Library spec
 * §6.4), the second consumer of this canonicalizer.
 *
 * Same rule as the corpus above, and for the same reason: every `digest` was
 * computed once and pasted in. NEVER derive one at test time by calling
 * `computeEffectSetDigest` — a test that computes its own expectation passes
 * against any implementation, including a wrong one. CHANGING A DIGEST HERE IS
 * A BREAKING CHANGE: a stored `ai_operator_plan_approvals.effect_set_digest`
 * was computed under these bytes, and altering them invalidates every approved
 * plan that has not finished dispatching.
 */
export interface EffectSetVector {
  name: string;
  why: string;
  input: {
    taskId: string;
    planRevision: number;
    effects: readonly {
      ordinal: number;
      toolName: string;
      provider: 'breeze' | 'm365' | 'google';
      targetId: string | null;
      accountExternalId: string | null;
      argumentDigest: string;
    }[];
  };
  /** Frozen canonical JSON of the envelope. */
  canonical: string;
  /** Frozen SHA-256 hex. Never recompute. */
  digest: string;
}

export const EFFECT_SET_VECTORS: readonly EffectSetVector[] = [
  {
    name: 'single-breeze-effect',
    why: 'The degenerate one-effect plan, and the only vector with a null accountExternalId — a device command names a target row, not a provider account (spec §6.4).',
    input: {
      taskId: '00000000-0000-4000-8000-0000000000a1',
      planRevision: 1,
      effects: [{
        ordinal: 0, toolName: 'manage_services', provider: 'breeze',
        targetId: '00000000-0000-4000-8000-0000000000d1',
        accountExternalId: null,
        argumentDigest: '7c044ad146cc63e339066911c6547410c1f0f5a574ddd0f538c98cbf0fbe3873',
      }],
    },
    canonical: '{"effects":[{"accountExternalId":null,"argumentDigest":"7c044ad146cc63e339066911c6547410c1f0f5a574ddd0f538c98cbf0fbe3873","ordinal":0,"provider":"breeze","targetId":"00000000-0000-4000-8000-0000000000d1","toolName":"manage_services"}],"planRevision":1,"taskId":"00000000-0000-4000-8000-0000000000a1","v":1}',
    digest: 'b198a2963722363eb6ce25f5acd71056dc6b7cf5f186dd859cf8f841a6cd726c',
  },
  {
    name: 'two-provider-ordered-plan',
    why: 'Order is the §6.3 safety contract (mailbox effects while the account is live, suspend last). This vector and the next differ ONLY in order, so a hasher that sorted the array would produce one digest for both and fail here.',
    input: {
      taskId: '00000000-0000-4000-8000-0000000000a1',
      planRevision: 3,
      effects: [
        {
          ordinal: 0, toolName: 'google_set_forwarding', provider: 'google',
          targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101234567890',
          argumentDigest: 'ed494649a3386b6651086803aa17d4a798b4fa971d6bde76cf033f980cb65f0e',
        },
        {
          ordinal: 1, toolName: 'google_suspend_user', provider: 'google',
          targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101234567890',
          argumentDigest: 'e891df249108b76dd72d21b6441550c1cdc87aa1ab6d06611e94ed2d18734b03',
        },
      ],
    },
    canonical: '{"effects":[{"accountExternalId":"101234567890","argumentDigest":"ed494649a3386b6651086803aa17d4a798b4fa971d6bde76cf033f980cb65f0e","ordinal":0,"provider":"google","targetId":"00000000-0000-4000-8000-0000000000c1","toolName":"google_set_forwarding"},{"accountExternalId":"101234567890","argumentDigest":"e891df249108b76dd72d21b6441550c1cdc87aa1ab6d06611e94ed2d18734b03","ordinal":1,"provider":"google","targetId":"00000000-0000-4000-8000-0000000000c1","toolName":"google_suspend_user"}],"planRevision":3,"taskId":"00000000-0000-4000-8000-0000000000a1","v":1}',
    digest: 'a8278b73b311e19d9cc70df5f3418c3403d095d8a15801f846a13523321adf81',
  },
  {
    name: 'two-provider-plan-reordered',
    why: 'Identical members to the previous vector, swapped. Pins that the two digests differ — the single property that makes "disable last" enforceable by a hash.',
    input: {
      taskId: '00000000-0000-4000-8000-0000000000a1',
      planRevision: 3,
      effects: [
        {
          ordinal: 0, toolName: 'google_suspend_user', provider: 'google',
          targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101234567890',
          argumentDigest: 'e891df249108b76dd72d21b6441550c1cdc87aa1ab6d06611e94ed2d18734b03',
        },
        {
          ordinal: 1, toolName: 'google_set_forwarding', provider: 'google',
          targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101234567890',
          argumentDigest: 'ed494649a3386b6651086803aa17d4a798b4fa971d6bde76cf033f980cb65f0e',
        },
      ],
    },
    canonical: '{"effects":[{"accountExternalId":"101234567890","argumentDigest":"e891df249108b76dd72d21b6441550c1cdc87aa1ab6d06611e94ed2d18734b03","ordinal":0,"provider":"google","targetId":"00000000-0000-4000-8000-0000000000c1","toolName":"google_suspend_user"},{"accountExternalId":"101234567890","argumentDigest":"ed494649a3386b6651086803aa17d4a798b4fa971d6bde76cf033f980cb65f0e","ordinal":1,"provider":"google","targetId":"00000000-0000-4000-8000-0000000000c1","toolName":"google_set_forwarding"}],"planRevision":3,"taskId":"00000000-0000-4000-8000-0000000000a1","v":1}',
    digest: 'c2b1cd4e8647634ec6c3bf6d9cd75250cae3edf4cf635b2b8249a107c31a66af',
  },
  {
    name: 'cross-provider-nine-effect-offboarding',
    why: 'The realistic shape §6.3 describes: both providers in one plan, so the corpus is not purely synthetic and a provider-field regression is caught.',
    input: {
      taskId: '00000000-0000-4000-8000-0000000000a1',
      planRevision: 2,
      effects: [
        { ordinal: 0, toolName: 'm365_set_auto_reply', provider: 'm365', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: 'aaaaaaaa-1111-4000-8000-000000000001', argumentDigest: 'f96765ad1f5b67b7963269d3fe1b9bbbaa317d422b1c00819261ab5437ef2ee8' },
        { ordinal: 1, toolName: 'google_set_vacation', provider: 'google', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101234567890', argumentDigest: 'f464b7e0c5630a47a2013f6d6975211342a74e55710eb6db6f4491c41662dec8' },
        { ordinal: 2, toolName: 'google_set_forwarding', provider: 'google', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101234567890', argumentDigest: 'ed494649a3386b6651086803aa17d4a798b4fa971d6bde76cf033f980cb65f0e' },
        { ordinal: 3, toolName: 'google_add_mail_delegate', provider: 'google', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101234567890', argumentDigest: 'dfc9b1a088570d96f0f01cffdb147f61e392b4cfa3372a89dc9975f4bc97a817' },
        { ordinal: 4, toolName: 'm365_remove_from_group', provider: 'm365', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: 'aaaaaaaa-1111-4000-8000-000000000001', argumentDigest: '3466e8f27356e74e07817aa6e9165638bbf0d7ce8ee704f712c1db69f545ea4c' },
        { ordinal: 5, toolName: 'm365_remove_license', provider: 'm365', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: 'aaaaaaaa-1111-4000-8000-000000000001', argumentDigest: '9728badb9c0db0519174d4c9305f82eadd635c0f2cef168f6ecdf3def64aea18' },
        { ordinal: 6, toolName: 'm365_retire_intune_device', provider: 'm365', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: 'aaaaaaaa-1111-4000-8000-000000000001', argumentDigest: 'dd189424d1e94bab8b0391e6a35db9545ca049ed72e495460e3230651cc231e5' },
        { ordinal: 7, toolName: 'm365_revoke_sessions', provider: 'm365', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: 'aaaaaaaa-1111-4000-8000-000000000001', argumentDigest: 'a5cfb1468964c8cff2b9023294688cdb1408e6eaa13c8614a9a21a5c761b2fc7' },
        { ordinal: 8, toolName: 'google_suspend_user', provider: 'google', targetId: '00000000-0000-4000-8000-0000000000c1', accountExternalId: '101234567890', argumentDigest: 'e891df249108b76dd72d21b6441550c1cdc87aa1ab6d06611e94ed2d18734b03' },
      ],
    },
    canonical: '{"effects":[{"accountExternalId":"aaaaaaaa-1111-4000-8000-000000000001","argumentDigest":"f96765ad1f5b67b7963269d3fe1b9bbbaa317d422b1c00819261ab5437ef2ee8","ordinal":0,"provider":"m365","targetId":"00000000-0000-4000-8000-0000000000c1","toolName":"m365_set_auto_reply"},{"accountExternalId":"101234567890","argumentDigest":"f464b7e0c5630a47a2013f6d6975211342a74e55710eb6db6f4491c41662dec8","ordinal":1,"provider":"google","targetId":"00000000-0000-4000-8000-0000000000c1","toolName":"google_set_vacation"},{"accountExternalId":"101234567890","argumentDigest":"ed494649a3386b6651086803aa17d4a798b4fa971d6bde76cf033f980cb65f0e","ordinal":2,"provider":"google","targetId":"00000000-0000-4000-8000-0000000000c1","toolName":"google_set_forwarding"},{"accountExternalId":"101234567890","argumentDigest":"dfc9b1a088570d96f0f01cffdb147f61e392b4cfa3372a89dc9975f4bc97a817","ordinal":3,"provider":"google","targetId":"00000000-0000-4000-8000-0000000000c1","toolName":"google_add_mail_delegate"},{"accountExternalId":"aaaaaaaa-1111-4000-8000-000000000001","argumentDigest":"3466e8f27356e74e07817aa6e9165638bbf0d7ce8ee704f712c1db69f545ea4c","ordinal":4,"provider":"m365","targetId":"00000000-0000-4000-8000-0000000000c1","toolName":"m365_remove_from_group"},{"accountExternalId":"aaaaaaaa-1111-4000-8000-000000000001","argumentDigest":"9728badb9c0db0519174d4c9305f82eadd635c0f2cef168f6ecdf3def64aea18","ordinal":5,"provider":"m365","targetId":"00000000-0000-4000-8000-0000000000c1","toolName":"m365_remove_license"},{"accountExternalId":"aaaaaaaa-1111-4000-8000-000000000001","argumentDigest":"dd189424d1e94bab8b0391e6a35db9545ca049ed72e495460e3230651cc231e5","ordinal":6,"provider":"m365","targetId":"00000000-0000-4000-8000-0000000000c1","toolName":"m365_retire_intune_device"},{"accountExternalId":"aaaaaaaa-1111-4000-8000-000000000001","argumentDigest":"a5cfb1468964c8cff2b9023294688cdb1408e6eaa13c8614a9a21a5c761b2fc7","ordinal":7,"provider":"m365","targetId":"00000000-0000-4000-8000-0000000000c1","toolName":"m365_revoke_sessions"},{"accountExternalId":"101234567890","argumentDigest":"e891df249108b76dd72d21b6441550c1cdc87aa1ab6d06611e94ed2d18734b03","ordinal":8,"provider":"google","targetId":"00000000-0000-4000-8000-0000000000c1","toolName":"google_suspend_user"}],"planRevision":2,"taskId":"00000000-0000-4000-8000-0000000000a1","v":1}',
    digest: '98e91bc30c8a1ef4ff0b7bb5f0a7a835a8f6d855044ae7d8e0cc6c492a1bf5e4',
  },
] as const;
