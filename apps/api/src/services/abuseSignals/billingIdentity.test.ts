import { describe, it, expect } from 'vitest';
import {
  computeBillingIdentitySignals,
  buildIdentityTokens,
  identityTokens,
  domainIdentityLabels,
  isFreeEmailProvider,
  spanMilliseconds,
  FREE_EMAIL_PROVIDER_LABELS,
  type BillingIdentityAggregate,
  type BillingIdentityScorerOptions,
} from './billingIdentity';
import { SIGNAL_DEFAULTS } from './config';

// Every name, mailbox, domain and fingerprint below is invented for this file.
// Mailbox domains are reserved-TLD placeholders only (.example) — never a real
// provider domain, which the customer-PII guard rejects in a public repo.

function agg(overrides: Partial<BillingIdentityAggregate> = {}): BillingIdentityAggregate {
  return {
    partnerId: 'p1',
    partnerName: 'Nordvane',
    emails: ['ops@nordvane.example'],
    userNames: ['Rosalind Quibley'],
    cardholderName: null,
    cardFingerprint: null,
    distinctPaymentMethods: 0,
    paymentMethodsFirstSeenAt: null,
    paymentMethodsLastSeenAt: null,
    failedAttempts: 0,
    identitySyncedAt: null,
    ...overrides,
  };
}

const signalKeys = (signals: ReturnType<typeof computeBillingIdentitySignals>) =>
  signals.map((s) => s.signalKey);

/**
 * Synthetic stand-in for a consumer mailbox provider. Reserved-TLD domains only
 * in fixtures — a real provider domain in a public repo trips (and would blunt)
 * the customer-PII guard, and the scorer takes an injectable provider set
 * precisely so the exclusion BEHAVIOUR can be proven without one. The shipped
 * list is covered separately, by bare-domain assertions that contain no address.
 */
const SYNTHETIC_FREE_PROVIDERS: ReadonlySet<string> = new Set(['freemail']);

const fires = (
  a: BillingIdentityAggregate,
  options?: BillingIdentityScorerOptions,
  shared = new Map<string, number>(),
) =>
  signalKeys(computeBillingIdentitySignals([a], shared, SIGNAL_DEFAULTS, options)).includes(
    'billing.cardholder_name_mismatch',
  );

describe('computeBillingIdentitySignals — quiet cases', () => {
  it('emits nothing for a partner with no billing identity data', () => {
    expect(computeBillingIdentitySignals([agg()], new Map(), SIGNAL_DEFAULTS)).toEqual([]);
  });

  it('emits nothing when the cardholder name is blank', () => {
    expect(
      computeBillingIdentitySignals([agg({ cardholderName: '   ' })], new Map(), SIGNAL_DEFAULTS),
    ).toEqual([]);
  });

  it('never fires a mismatch when the account side has no meaningful tokens', () => {
    // "no data" is not evidence: every account token here is a stop word.
    expect(
      fires(
        agg({
          partnerName: 'IT Solutions LLC',
          userNames: [],
          emails: ['billing@it.example'],
          cardholderName: 'Perpetua Vandersloot',
        }),
      ),
    ).toBe(false);
  });
});

describe('billing.cardholder_name_mismatch — matching algorithm', () => {
  const cases: Array<{
    name: string;
    aggregate: BillingIdentityAggregate;
    shouldFire: boolean;
    options?: BillingIdentityScorerOptions;
  }> = [
    {
      name: 'cardholder shares no token with partner name, user names, or email local-part',
      aggregate: agg({
        partnerName: 'Nordvane',
        userNames: ['Rosalind Quibley'],
        emails: ['rosalind@nordvane.example'],
        cardholderName: 'Bartholomew Pfennig',
      }),
      shouldFire: true,
    },
    {
      name: 'cardholder first name matches the email local-part (operator paying with their own card)',
      aggregate: agg({
        partnerName: 'Nordvane',
        userNames: [],
        emails: ['andrivo@nordvane.example'],
        cardholderName: 'Andrivo Pfennig',
      }),
      shouldFire: false,
    },
    {
      name: 'cardholder shares a token with the partner name (documented known miss)',
      aggregate: agg({
        partnerName: 'Quibley Holdings',
        userNames: ['Rosalind Threnody'],
        emails: ['ops@nordvane.example'],
        cardholderName: 'Marguerite Quibley',
      }),
      shouldFire: false,
    },
    {
      name: 'cardholder matches a member display name rather than the partner name',
      aggregate: agg({
        partnerName: 'Nordvane',
        userNames: ['Rosalind Threnody'],
        emails: ['ops@nordvane.example'],
        cardholderName: 'Threnody Rosalind',
      }),
      shouldFire: false,
    },
    {
      // A/B pair with the case below: identical fixture, and the ONLY
      // difference is whether the mailbox domain is treated as a free provider.
      // That isolates the exclusion behaviour from every other axis.
      name: 'free-provider email domain contributes no match token',
      aggregate: agg({
        partnerName: 'Nordvane',
        userNames: ['Rosalind Threnody'],
        emails: ['rq@freemail.example'],
        cardholderName: 'Freemail Pfennig',
      }),
      options: { freeEmailProviderLabels: SYNTHETIC_FREE_PROVIDERS },
      shouldFire: true,
    },
    {
      name: 'the same domain DOES contribute a token when it is not a free provider',
      aggregate: agg({
        partnerName: 'Nordvane',
        userNames: ['Rosalind Threnody'],
        emails: ['rq@freemail.example'],
        cardholderName: 'Freemail Pfennig',
      }),
      shouldFire: false,
    },
    {
      name: 'a corporate email domain contributes a match token',
      aggregate: agg({
        partnerName: 'Nordvane',
        userNames: ['Rosalind Threnody'],
        emails: ['rq@calloway-brix.example'],
        cardholderName: 'Calloway Pfennig',
      }),
      shouldFire: false,
    },
    {
      name: 'diacritics, punctuation and word order still match',
      aggregate: agg({
        partnerName: 'Nordvane',
        userNames: ["Ódhrán Ferreiró-Blaÿse"],
        emails: ['ops@nordvane.example'],
        cardholderName: 'FERREIRO, ODHRAN',
      }),
      shouldFire: false,
    },
    {
      name: 'non-decomposing letters (ø, ß) fold to their ASCII spelling',
      aggregate: agg({
        partnerName: 'Nordvane',
        userNames: ['Sønderby Weißmuller'],
        emails: ['ops@nordvane.example'],
        cardholderName: 'Sonderby Weissmuller',
      }),
      shouldFire: false,
    },
    {
      name: 'digits in a mailbox local-part do not block the match',
      aggregate: agg({
        partnerName: 'Nordvane',
        userNames: [],
        emails: ['pfennig91@nordvane.example'],
        cardholderName: 'Bartholomew Pfennig',
      }),
      shouldFire: false,
    },
    {
      name: 'a shared corporate stop word alone is not a match',
      aggregate: agg({
        partnerName: 'Nordvane Managed Services',
        userNames: ['Rosalind Threnody'],
        emails: ['ops@nordvane.example'],
        cardholderName: 'Pfennig Managed Services Ltd',
      }),
      shouldFire: true,
    },
  ];

  for (const { name, aggregate, shouldFire, options } of cases) {
    it(`${shouldFire ? 'fires' : 'does not fire'}: ${name}`, () => {
      expect(fires(aggregate, options)).toBe(shouldFire);
    });
  }

  it('scores below alert on its own and carries the cardholder name as evidence', () => {
    const [signal] = computeBillingIdentitySignals(
      [agg({ cardholderName: 'Bartholomew Pfennig' })],
      new Map(),
      SIGNAL_DEFAULTS,
    );
    expect(signal).toBeDefined();
    expect(signal!.signalKey).toBe('billing.cardholder_name_mismatch');
    expect(signal!.severity).toBe('watch');
    expect(signal!.score).toBe(SIGNAL_DEFAULTS['billing.cardholder_name_mismatch.score']);
    expect(signal!.evidence).toMatchObject({
      partnerName: 'Nordvane',
      cardholderName: 'Bartholomew Pfennig',
      failedAttempts: 0,
    });
  });

  it('escalates a mismatch when the account also has failed payment attempts', () => {
    const [signal] = computeBillingIdentitySignals(
      [agg({ cardholderName: 'Bartholomew Pfennig', failedAttempts: 9 })],
      new Map(),
      SIGNAL_DEFAULTS,
    );
    expect(signal!.score).toBe(
      SIGNAL_DEFAULTS['billing.cardholder_name_mismatch.score'] +
        SIGNAL_DEFAULTS['billing.cardholder_name_mismatch.failed_attempt_bonus'] * 9,
    );
    expect(signal!.severity).toBe('alert');
  });

  it('defaults to the shipped free-provider list when none is injected', () => {
    // Guards the default-argument wiring: omitting options must not silently
    // fall back to an empty provider set, which would quietly disable the
    // exclusion in production while every injected test stayed green.
    const aggregate = agg({
      partnerName: 'Nordvane',
      userNames: [],
      emails: ['rq@freemail.example'],
      cardholderName: 'Freemail Pfennig',
    });
    expect(fires(aggregate)).toBe(fires(aggregate, { freeEmailProviderLabels: FREE_EMAIL_PROVIDER_LABELS }));
  });
});

describe('billing.shared_card_fingerprint', () => {
  it('fires for the in-scope partner when a fingerprint spans two partners', () => {
    const shared = new Map([['fpr_zzxq1', 2]]);
    const signals = computeBillingIdentitySignals(
      [agg({ cardholderName: 'Nordvane', cardFingerprint: 'fpr_zzxq1' })],
      shared,
      SIGNAL_DEFAULTS,
    );
    const signal = signals.find((s) => s.signalKey === 'billing.shared_card_fingerprint');
    expect(signal).toBeDefined();
    expect(signal!.score).toBe(SIGNAL_DEFAULTS['billing.shared_card_fingerprint.base_score']);
    expect(signal!.severity).toBe('alert');
    expect(signal!.evidence).toMatchObject({ cardFingerprintPrefix: 'fpr_zzxq1', partnerCount: 2 });
  });

  it('scores higher as the fingerprint spans more partners', () => {
    const signals = computeBillingIdentitySignals(
      [agg({ cardFingerprint: 'fpr_zzxq1' })],
      new Map([['fpr_zzxq1', 4]]),
      SIGNAL_DEFAULTS,
    );
    const signal = signals.find((s) => s.signalKey === 'billing.shared_card_fingerprint');
    expect(signal!.score).toBe(
      SIGNAL_DEFAULTS['billing.shared_card_fingerprint.base_score'] +
        SIGNAL_DEFAULTS['billing.shared_card_fingerprint.per_extra_partner'] * 2,
    );
  });

  it('is silent for a fingerprint held by only one partner', () => {
    const signals = computeBillingIdentitySignals(
      [agg({ cardFingerprint: 'fpr_zzxq1' })],
      new Map(),
      SIGNAL_DEFAULTS,
    );
    expect(signalKeys(signals)).not.toContain('billing.shared_card_fingerprint');
  });

  it('never matches two null fingerprints against each other', () => {
    // Wallet/Link payments expose no fingerprint. A corpus can never contain a
    // NULL key, and a null-fingerprint partner is skipped outright.
    const shared = new Map<string, number>([['', 5]]);
    const signals = computeBillingIdentitySignals(
      [agg({ partnerId: 'pA', cardFingerprint: null }), agg({ partnerId: 'pB', cardFingerprint: '  ' })],
      shared,
      SIGNAL_DEFAULTS,
    );
    expect(signalKeys(signals)).not.toContain('billing.shared_card_fingerprint');
  });
});

describe('billing.card_testing — span-based', () => {
  const burstStart = new Date('2026-07-25T09:00:00Z');
  /** Same day, 7 minutes later: the flagship card-testing shape. */
  const burstEnd = new Date('2026-07-25T09:07:00Z');

  const cardTesting = (overrides: Partial<BillingIdentityAggregate>) =>
    computeBillingIdentitySignals([agg(overrides)], new Map(), SIGNAL_DEFAULTS).find(
      (s) => s.signalKey === 'billing.card_testing',
    );

  it('fires for 3 distinct methods inside a 7-minute span', () => {
    const signal = cardTesting({
      distinctPaymentMethods: 3,
      paymentMethodsFirstSeenAt: burstStart,
      paymentMethodsLastSeenAt: burstEnd,
    });
    expect(signal).toBeDefined();
    expect(signal!.score).toBe(SIGNAL_DEFAULTS['billing.card_testing.base_score']);
    expect(signal!.evidence).toMatchObject({
      distinctPaymentMethods: 3,
      failedAttempts: 0,
      spanMinutes: 7,
      paymentMethodsFirstSeenAt: burstStart.toISOString(),
      paymentMethodsLastSeenAt: burstEnd.toISOString(),
      identitySyncedAt: null,
    });
  });

  it('carries snapshot age into evidence without letting it gate the signal', () => {
    // A stale snapshot still fires — only the span decides — but the operator
    // gets to see how old the data is.
    const signal = cardTesting({
      distinctPaymentMethods: 3,
      paymentMethodsFirstSeenAt: burstStart,
      paymentMethodsLastSeenAt: burstEnd,
      identitySyncedAt: new Date('2026-05-01T00:00:00Z'),
    });
    expect(signal).toBeDefined();
    expect(signal!.evidence).toMatchObject({ identitySyncedAt: '2026-05-01T00:00:00.000Z' });
  });

  it('does NOT fire for 3 distinct methods spanning two years', () => {
    // A long-lived MSP replacing an expired card twice. Identical count, and an
    // equally fresh snapshot — only the span tells the two apart.
    expect(
      cardTesting({
        distinctPaymentMethods: 3,
        paymentMethodsFirstSeenAt: new Date('2024-07-25T09:00:00Z'),
        paymentMethodsLastSeenAt: new Date('2026-07-25T09:00:00Z'),
        identitySyncedAt: new Date('2026-07-25T08:00:00Z'),
      }),
    ).toBeUndefined();
  });

  it('does NOT fire when both span timestamps are NULL', () => {
    // The deploy-day case: legacy rows, or the billing service has not
    // backfilled yet. An unknown span must never read as a zero span.
    expect(cardTesting({ distinctPaymentMethods: 9 })).toBeUndefined();
  });

  it('does NOT fire when only one span timestamp is present', () => {
    expect(
      cardTesting({ distinctPaymentMethods: 9, paymentMethodsFirstSeenAt: burstStart }),
    ).toBeUndefined();
    expect(
      cardTesting({ distinctPaymentMethods: 9, paymentMethodsLastSeenAt: burstEnd }),
    ).toBeUndefined();
  });

  it('does NOT fire on a reversed span (bad data is not an instantaneous burst)', () => {
    expect(
      cardTesting({
        distinctPaymentMethods: 9,
        paymentMethodsFirstSeenAt: burstEnd,
        paymentMethodsLastSeenAt: burstStart,
      }),
    ).toBeUndefined();
  });

  it('fires at exactly the window boundary and is silent one millisecond past it', () => {
    const windowMs = SIGNAL_DEFAULTS['billing.card_testing.window_days'] * 86_400_000;
    expect(
      cardTesting({
        distinctPaymentMethods: 3,
        paymentMethodsFirstSeenAt: burstStart,
        paymentMethodsLastSeenAt: new Date(burstStart.getTime() + windowMs),
      }),
    ).toBeDefined();
    expect(
      cardTesting({
        distinctPaymentMethods: 3,
        paymentMethodsFirstSeenAt: burstStart,
        paymentMethodsLastSeenAt: new Date(burstStart.getTime() + windowMs + 1),
      }),
    ).toBeUndefined();
  });

  it('is silent below the method threshold even inside a tight span', () => {
    expect(
      cardTesting({
        distinctPaymentMethods: 2,
        paymentMethodsFirstSeenAt: burstStart,
        paymentMethodsLastSeenAt: burstEnd,
      }),
    ).toBeUndefined();
  });

  it('scores a legitimate multi-year partner with several cards at zero', () => {
    // The whole aggregate, not just the card-testing branch: a cardholder that
    // matches the account and a fingerprint held by nobody else must produce no
    // signals at all, however many cards the account has seen over the years.
    const signals = computeBillingIdentitySignals(
      [
        agg({
          partnerName: 'Nordvane',
          userNames: ['Rosalind Quibley'],
          emails: ['rosalind@nordvane.example'],
          cardholderName: 'Rosalind Quibley',
          cardFingerprint: 'fpr_zzxq1',
          distinctPaymentMethods: 5,
          failedAttempts: 3,
          paymentMethodsFirstSeenAt: new Date('2022-01-04T00:00:00Z'),
          paymentMethodsLastSeenAt: new Date('2026-07-01T00:00:00Z'),
          identitySyncedAt: new Date('2026-07-25T08:00:00Z'),
        }),
      ],
      new Map(),
      SIGNAL_DEFAULTS,
    );
    expect(signals).toEqual([]);
  });

  it('escalates with extra methods and failed attempts', () => {
    const signal = cardTesting({
      distinctPaymentMethods: 5,
      failedAttempts: 4,
      paymentMethodsFirstSeenAt: burstStart,
      paymentMethodsLastSeenAt: burstEnd,
    });
    expect(signal!.score).toBe(
      SIGNAL_DEFAULTS['billing.card_testing.base_score'] +
        SIGNAL_DEFAULTS['billing.card_testing.per_extra_method'] * 2 +
        SIGNAL_DEFAULTS['billing.card_testing.per_failed_attempt'] * 4,
    );
    expect(signal!.severity).toBe('alert');
  });

  it('clamps the score at 100', () => {
    const signal = cardTesting({
      distinctPaymentMethods: 40,
      failedAttempts: 40,
      paymentMethodsFirstSeenAt: burstStart,
      paymentMethodsLastSeenAt: burstEnd,
    });
    expect(signal!.score).toBe(100);
  });
});

describe('spanMilliseconds', () => {
  const first = new Date('2026-07-25T09:00:00Z');
  const last = new Date('2026-07-25T09:07:00Z');

  it('returns the elapsed milliseconds for a coherent pair', () => {
    expect(spanMilliseconds(first, last)).toBe(7 * 60_000);
  });

  it('returns 0 for identical bounds', () => {
    expect(spanMilliseconds(first, first)).toBe(0);
  });

  it('returns null — never 0 — when either bound is missing', () => {
    expect(spanMilliseconds(null, last)).toBeNull();
    expect(spanMilliseconds(first, null)).toBeNull();
    expect(spanMilliseconds(null, null)).toBeNull();
  });

  it('returns null for a reversed pair', () => {
    expect(spanMilliseconds(last, first)).toBeNull();
  });
});

describe('never age-decays', () => {
  it('takes no clock, so a signal cannot weaken as the account ages', () => {
    // The scorer's signature carries neither `now` nor partnerCreatedAt, which
    // is what makes "never age-decayed" structural rather than a convention.
    const aggregate = agg({ cardholderName: 'Bartholomew Pfennig' });
    const first = computeBillingIdentitySignals([aggregate], new Map(), SIGNAL_DEFAULTS);
    const second = computeBillingIdentitySignals([aggregate], new Map(), SIGNAL_DEFAULTS);
    expect(first).toEqual(second);
    expect(first[0]!.score).toBe(SIGNAL_DEFAULTS['billing.cardholder_name_mismatch.score']);
  });
});

describe('token helpers', () => {
  it('drops short tokens, stop words and digits', () => {
    expect(identityTokens('Nordvane IT Solutions 2026')).toEqual(['nordvane']);
  });

  it('strips the TLD and public second-level suffixes from a domain', () => {
    expect(domainIdentityLabels('nordvane.example')).toEqual(['nordvane']);
    expect(domainIdentityLabels('nordvane.co.uk')).toEqual(['nordvane']);
    expect(domainIdentityLabels('mail.nordvane.com')).toEqual(['mail', 'nordvane']);
    expect(domainIdentityLabels('localhost')).toEqual([]);
  });

  it('recognises free providers by their registrable base label', () => {
    expect(isFreeEmailProvider('gmail.com', FREE_EMAIL_PROVIDER_LABELS)).toBe(true);
    expect(isFreeEmailProvider('yahoo.co.uk', FREE_EMAIL_PROVIDER_LABELS)).toBe(true);
    expect(isFreeEmailProvider('mail.ru', FREE_EMAIL_PROVIDER_LABELS)).toBe(true);
    expect(isFreeEmailProvider('nordvane.example', FREE_EMAIL_PROVIDER_LABELS)).toBe(false);
    // A corporate mailbox subdomain resolves to the corporate base label.
    expect(isFreeEmailProvider('mail.nordvane.com', FREE_EMAIL_PROVIDER_LABELS)).toBe(false);
  });

  it('excludes free-provider domain labels from the identity token set', () => {
    const tokens = buildIdentityTokens(
      {
        partnerName: 'Nordvane',
        userNames: [],
        emails: ['quibley@freemail.example'],
      },
      SYNTHETIC_FREE_PROVIDERS,
    );
    expect([...tokens].sort()).toEqual(['nordvane', 'quibley']);
  });

  it('keeps the domain label when the provider is not in the injected set', () => {
    const tokens = buildIdentityTokens(
      {
        partnerName: 'Nordvane',
        userNames: [],
        emails: ['quibley@freemail.example'],
      },
      new Set<string>(),
    );
    expect([...tokens].sort()).toEqual(['freemail', 'nordvane', 'quibley']);
  });
});
