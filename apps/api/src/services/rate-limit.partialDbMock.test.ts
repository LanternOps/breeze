import { describe, expect, it, vi } from 'vitest';

// #6130 review follow-up — the load-bearing compatibility contract of the
// tripwire instrumentation: `rateLimiter` is reached from 100+ call sites whose
// unit suites mock `../db` with only the exports their route needs. Vitest
// throws on reading an undeclared export from a mocked module, so without the
// guarded property read in `assertOutsideHeldDbContextSafe` every one of those
// suites would go red on an error that says nothing about the code under test
// (observed: routes/agents/mtls.test.ts, 62 failures).
//
// That behaviour was previously only exercised incidentally by unrelated auth
// suites. This file pins it directly: `../db` mocked with NO
// `assertOutsideHeldDbContext` export at all.
vi.mock('../db', () => ({}));

import { rateLimiter } from './rate-limit';

describe('rateLimiter with a partially-mocked ../db', () => {
  it('still runs and fails closed, instead of throwing the mock`s missing-export error', async () => {
    await expect(rateLimiter(null, 'login:someone@example.com', 5, 300)).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
    });
  });
});
