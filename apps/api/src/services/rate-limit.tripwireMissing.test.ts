import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #6130 review follow-up — the cast in `assertOutsideHeldDbContextSafe` erases
// the type of `db.assertOutsideHeldDbContext`, so a rename or removal of that
// export would disable the #1105 tripwire for EVERY rateLimiter call site with
// no compile error and no failing test. This suite pins the one signal that
// would remain: a once-per-process warning. It lives in its own file because
// the mock shape (export present but not a function) is per-file.
vi.mock('../db', () => ({ assertOutsideHeldDbContext: undefined }));

import { __resetMissingGuardWarnForTests, rateLimiter } from './rate-limit';

describe('rateLimiter tripwire wiring is missing', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetMissingGuardWarnForTests();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns once per process instead of going silently dark, and still rate-limits', async () => {
    const first = await rateLimiter(null, 'login:someone@example.com', 5, 300);
    await rateLimiter(null, 'mfa:user-1', 5, 300);

    // Fail-closed behaviour is unaffected by the missing guard.
    expect(first.allowed).toBe(false);

    const tripwireWarnings = (warnSpy.mock.calls as unknown[][]).filter((args) =>
      String(args[0]).includes('#1105 tripwire unavailable'),
    );
    expect(tripwireWarnings).toHaveLength(1);
  });
});
