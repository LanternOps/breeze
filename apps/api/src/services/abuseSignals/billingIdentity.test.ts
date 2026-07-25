import { describe, it, expect } from 'vitest';
import {
  computeBillingIdentitySignals,
  buildIdentityTokens,
  identityTokens,
  domainIdentityLabels,
  isFreeEmailProvider,
  FREE_EMAIL_PROVIDER_LABELS,
  type BillingIdentityAggregate,
} from './billingIdentity';
import { SIGNAL_DEFAULTS } from './config';

// Every name, mailbox, domain and fingerprint below is invented for this file.
const now = new Date('2026-07-25T00:00:00Z');

function agg(overrides: Partial<BillingIdentityAggregate> = {}): BillingIdentityAggregate {
  return {
    partnerId: 'p1',
    partnerName: 'Nordvane',
    emails: ['ops@nordvane.example'],
    userNames: ['Rosalind Quibley'],
    cardholderName: null,
    cardFingerprint: null,
    distinctPaymentMethods: 0,
    failedAttempts: 0,
    identitySyncedAt: null,
    ...overrides,
  };
}

const signalKeys = (signals: ReturnType<typeof computeBillingIdentitySignals>) =>
  signals.map((s) => s.signalKey);

const fires = (a: BillingIdentityAggregate, shared = new Map<string, number>()) =>
  signalKeys(computeBillingIdentitySignals([a], shared, SIGNAL_DEFAULTS, now)).includes(
    'billing.cardholder_name_mismatch',
  );

describe('computeBillingIdentitySignals — quiet cases', () => {
  it('emits nothing for a partner with no billing identity data', () => {
    expect(computeBillingIdentitySignals([agg()], new Map(), SIGNAL_DEFAULTS, now)).toEqual([]);
  });

  it('emits nothing when the cardholder name is blank', () => {
    expect(
      computeBillingIdentitySignals([agg({ cardholderName: '   ' })], new Map(), SIGNAL_DEFAULTS, now),
    ).toEqual([]);
  });

  it('never fires a mismatch when the account side has no meaningful tokens', () => {
    // "no data" is not evidence: every account token here is a stop word.
    expect(
      fires(
        agg({
          partnerName: 'IT Solutions LLC',
          userNames: [],
          emails: ['billing@gmail.example'],
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
      name: 'free-provider email domain contributes no match token',
      aggregate: agg({
        partnerName: 'Nordvane',
        userNames: ['Rosalind Threnody'],
        emails: ['rq@proton.me'],
        cardholderName: 'Proton Pfennig',
      }),
      shouldFire: true,
    },
    {
      name: 'non-free email domain does contribute a match token',
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

  for (const { name, aggregate, shouldFire } of cases) {
    it(`${shouldFire ? 'fires' : 'does not fire'}: ${name}`, () => {
      expect(fires(aggregate)).toBe(shouldFire);
    });
  }

  it('scores below alert on its own and carries the cardholder name as evidence', () => {
    const [signal] = computeBillingIdentitySignals(
      [agg({ cardholderName: 'Bartholomew Pfennig' })],
      new Map(),
      SIGNAL_DEFAULTS,
      now,
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
      now,
    );
    expect(signal!.score).toBe(
      SIGNAL_DEFAULTS['billing.cardholder_name_mismatch.score'] +
        SIGNAL_DEFAULTS['billing.cardholder_name_mismatch.failed_attempt_bonus'] * 9,
    );
    expect(signal!.severity).toBe('alert');
  });

  it('accepts an injected free-provider list', () => {
    const aggregate = agg({
      partnerName: 'Nordvane',
      userNames: [],
      emails: ['rq@calloway-brix.example'],
      cardholderName: 'Calloway Pfennig',
    });
    // With the default list the domain token 'calloway' matches, so it is quiet.
    expect(fires(aggregate)).toBe(false);
    // Treating that domain as a free provider strips the token, so it fires.
    const signals = computeBillingIdentitySignals([aggregate], new Map(), SIGNAL_DEFAULTS, now, {
      freeEmailProviderLabels: new Set(['calloway-brix']),
    });
    expect(signalKeys(signals)).toContain('billing.cardholder_name_mismatch');
  });
});

describe('billing.shared_card_fingerprint', () => {
  it('fires for the in-scope partner when a fingerprint spans two partners', () => {
    const shared = new Map([['fpr_zzxq1', 2]]);
    const signals = computeBillingIdentitySignals(
      [agg({ cardholderName: 'Nordvane', cardFingerprint: 'fpr_zzxq1' })],
      shared,
      SIGNAL_DEFAULTS,
      now,
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
      now,
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
      now,
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
      now,
    );
    expect(signalKeys(signals)).not.toContain('billing.shared_card_fingerprint');
  });
});

describe('billing.card_testing', () => {
  const freshSync = new Date('2026-07-24T00:00:00Z');

  it('fires when distinct payment methods reach the threshold on a fresh snapshot', () => {
    const signals = computeBillingIdentitySignals(
      [agg({ distinctPaymentMethods: 3, identitySyncedAt: freshSync })],
      new Map(),
      SIGNAL_DEFAULTS,
      now,
    );
    const signal = signals.find((s) => s.signalKey === 'billing.card_testing');
    expect(signal).toBeDefined();
    expect(signal!.score).toBe(SIGNAL_DEFAULTS['billing.card_testing.base_score']);
    expect(signal!.evidence).toMatchObject({ distinctPaymentMethods: 3, failedAttempts: 0 });
  });

  it('is silent below the threshold', () => {
    const signals = computeBillingIdentitySignals(
      [agg({ distinctPaymentMethods: 2, identitySyncedAt: freshSync })],
      new Map(),
      SIGNAL_DEFAULTS,
      now,
    );
    expect(signalKeys(signals)).not.toContain('billing.card_testing');
  });

  it('is silent when the snapshot is older than the window', () => {
    const signals = computeBillingIdentitySignals(
      [agg({ distinctPaymentMethods: 6, identitySyncedAt: new Date('2026-06-01T00:00:00Z') })],
      new Map(),
      SIGNAL_DEFAULTS,
      now,
    );
    expect(signalKeys(signals)).not.toContain('billing.card_testing');
  });

  it('is silent when the snapshot was never synced', () => {
    const signals = computeBillingIdentitySignals(
      [agg({ distinctPaymentMethods: 6, identitySyncedAt: null })],
      new Map(),
      SIGNAL_DEFAULTS,
      now,
    );
    expect(signalKeys(signals)).not.toContain('billing.card_testing');
  });

  it('escalates with extra methods and failed attempts', () => {
    const signals = computeBillingIdentitySignals(
      [agg({ distinctPaymentMethods: 5, failedAttempts: 4, identitySyncedAt: freshSync })],
      new Map(),
      SIGNAL_DEFAULTS,
      now,
    );
    const signal = signals.find((s) => s.signalKey === 'billing.card_testing');
    expect(signal!.score).toBe(
      SIGNAL_DEFAULTS['billing.card_testing.base_score'] +
        SIGNAL_DEFAULTS['billing.card_testing.per_extra_method'] * 2 +
        SIGNAL_DEFAULTS['billing.card_testing.per_failed_attempt'] * 4,
    );
    expect(signal!.severity).toBe('alert');
  });

  it('clamps the score at 100', () => {
    const signals = computeBillingIdentitySignals(
      [agg({ distinctPaymentMethods: 40, failedAttempts: 40, identitySyncedAt: freshSync })],
      new Map(),
      SIGNAL_DEFAULTS,
      now,
    );
    const signal = signals.find((s) => s.signalKey === 'billing.card_testing');
    expect(signal!.score).toBe(100);
  });
});

describe('never age-decays', () => {
  it('scores an old account exactly like a brand-new one', () => {
    // The scorer takes no partner creation date at all — this asserts the
    // signature/behaviour rather than a decayed value.
    const aggregate = agg({ cardholderName: 'Bartholomew Pfennig' });
    const early = computeBillingIdentitySignals(
      [aggregate],
      new Map(),
      SIGNAL_DEFAULTS,
      new Date('2026-01-01T00:00:00Z'),
    );
    const late = computeBillingIdentitySignals(
      [aggregate],
      new Map(),
      SIGNAL_DEFAULTS,
      new Date('2029-01-01T00:00:00Z'),
    );
    expect(early[0]!.score).toBe(late[0]!.score);
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
    const tokens = buildIdentityTokens({
      partnerName: 'Nordvane',
      userNames: [],
      emails: ['quibley@hotmail.example'],
    });
    expect([...tokens].sort()).toEqual(['nordvane', 'quibley']);
  });
});
