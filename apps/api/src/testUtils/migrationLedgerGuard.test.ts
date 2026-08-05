import { describe, expect, it } from 'vitest';
import {
  LEDGER_DRIFT_BYPASS_ENV,
  findUnknownCoreLedgerEntries,
  formatLedgerDriftError,
} from './migrationLedgerGuard';

describe('findUnknownCoreLedgerEntries', () => {
  const checkout = [
    '0001-baseline.sql',
    '2026-04-19-a-installer-bootstrap-tokens.sql',
    '2026-07-01-alerts-partner-ownership.sql',
  ];

  it('returns nothing when the ledger is a subset of the checkout', () => {
    expect(findUnknownCoreLedgerEntries(['0001-baseline.sql'], checkout)).toEqual([]);
    expect(findUnknownCoreLedgerEntries(checkout, checkout)).toEqual([]);
    expect(findUnknownCoreLedgerEntries([], checkout)).toEqual([]);
  });

  it('flags ledger rows with no matching migration file, sorted', () => {
    // The exact #3064 shape: a sibling branch applied its migration to the
    // shared DB; this checkout has never heard of it.
    const ledger = [
      '2026-08-11-software-upload-sessions.sql',
      '0001-baseline.sql',
      '2026-08-01-aaa-other-branch.sql',
    ];
    expect(findUnknownCoreLedgerEntries(ledger, checkout)).toEqual([
      '2026-08-01-aaa-other-branch.sql',
      '2026-08-11-software-upload-sessions.sql',
    ]);
  });

  it('ignores extension-namespaced rows (absent extensions are legitimate)', () => {
    const ledger = ['some-ext/0001-init.sql', '0001-baseline.sql'];
    expect(findUnknownCoreLedgerEntries(ledger, checkout)).toEqual([]);
  });

  it('does not treat checkout-only files (unapplied migrations) as drift', () => {
    // Checkout ahead of DB is the normal "about to migrate" state.
    expect(findUnknownCoreLedgerEntries(['0001-baseline.sql'], [...checkout, '2026-09-01-new.sql'])).toEqual([]);
  });
});

describe('formatLedgerDriftError', () => {
  it('names the target, the offending files, and every remediation path', () => {
    const msg = formatLedgerDriftError(['2026-08-11-software-upload-sessions.sql'], 'localhost:5433/breeze_test');
    expect(msg).toContain('localhost:5433/breeze_test');
    expect(msg).toContain('2026-08-11-software-upload-sessions.sql');
    expect(msg).toContain('pnpm test-stack up');
    expect(msg).toContain('docker compose -f docker-compose.test.yml down -v');
    expect(msg).toContain(LEDGER_DRIFT_BYPASS_ENV);
    expect(msg).toContain('#3064');
  });

  it('truncates long lists but reports the true count', () => {
    const unknown = Array.from({ length: 14 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}-x.sql`);
    const msg = formatLedgerDriftError(unknown, 'localhost:5433/breeze_test');
    expect(msg).toContain('14 applied migration(s)');
    expect(msg).toContain('... and 4 more');
  });
});
