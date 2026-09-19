import { describe, it, expect } from 'vitest';
import {
  classifyDrainOutcome,
  suggestionDedupeKey,
  type DrainOutcome,
} from './timeSuggestionDrain';

describe('classifyDrainOutcome — the spec table IS the test', () => {
  it.each<[number | undefined, DrainOutcome]>([
    [201, 'success'],        // logged
    [200, 'success'],        // replay: the ledger already held it (F4) — NOT an error
    [204, 'success'],        // dismiss/undismiss
    [409, 'drop'],           // dismissed, or already logged to a different entry — refetch
    [404, 'dropAndToast'],   // the session is gone
    [410, 'dropAndToast'],   // the entry was deleted (F5)
    [403, 'dropAndDisable'], // the partner turned the flag off (F10) — hide the entry points
    [422, 'dropAndToast'],   // org mismatch
    [400, 'dropAndToast'],   // range/tz rejected — never retried, it will never succeed
    [500, 'retry'],
    [503, 'retry'],
    [502, 'retry'],
    [408, 'retry'],          // request timeout is transient by definition
    [429, 'retry'],          // rate limited — the one 4xx that IS retryable
    [undefined, 'retry'],    // network failure: no status at all
  ])('status %s -> %s', (status, outcome) => {
    expect(classifyDrainOutcome(status)).toBe(outcome);
  });

  it('never retries a 4xx other than 408 and 429', () => {
    for (let status = 400; status < 500; status += 1) {
      if (status === 408 || status === 429) continue;
      expect(classifyDrainOutcome(status)).not.toBe('retry');
    }
  });

  it('retries every 5xx', () => {
    for (let status = 500; status < 600; status += 1) {
      expect(classifyDrainOutcome(status)).toBe('retry');
    }
  });

  it('treats an unknown 2xx as success rather than dropping the write silently', () => {
    expect(classifyDrainOutcome(202)).toBe('success');
  });

  it('treats an unknown 3xx as retry — a redirect is not a decision we can act on', () => {
    expect(classifyDrainOutcome(302)).toBe('retry');
  });

  it('does NOT special-case 0: a literal 0 status is a transport artefact, so retry', () => {
    expect(classifyDrainOutcome(0)).toBe('retry');
  });
});

describe('suggestionDedupeKey', () => {
  const A = { kind: 'remote_session' as const, id: 'aaaa1111-0000-4000-8000-000000000001' };
  const B = { kind: 'remote_session' as const, id: 'bbbb2222-0000-4000-8000-000000000002' };

  it('sorts signal ids so the same set in a different order collapses to one key', () => {
    expect(suggestionDedupeKey('confirm', [A, B])).toBe(suggestionDedupeKey('confirm', [B, A]));
  });

  it('separates confirm from dismiss for the same signals', () => {
    expect(suggestionDedupeKey('confirm', [A])).not.toBe(suggestionDedupeKey('dismiss', [A]));
  });

  it('separates different signal sets', () => {
    expect(suggestionDedupeKey('confirm', [A])).not.toBe(suggestionDedupeKey('confirm', [A, B]));
  });

  it('is stable across calls (no time or randomness in the key)', () => {
    expect(suggestionDedupeKey('confirm', [A, B])).toBe(suggestionDedupeKey('confirm', [A, B]));
  });
});
