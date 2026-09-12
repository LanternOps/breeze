import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * A source-order assertion, deliberately, for the same reason
 * aiGuardrails.imports.contract.test.ts is one: the behaviour being pinned is
 * "these three things happen in this order on the inline release path", and
 * exercising it end-to-end would need a live intent, a live CAS and a live
 * tool. The cheap structural check catches the refactor that matters.
 */
const src = readFileSync(new URL('./aiAgentSdk.ts', import.meta.url), 'utf8');

describe('chat inline release ordering (spec §4.5, needed by W04)', () => {
  it('revalidates after winning the release CAS and before the digest recheck', () => {
    const cas = src.indexOf('const wonRelease = await transitionIntent(');
    const revalidate = src.indexOf('revalidateApprovedIntentForRelease(intentRow, winningApproval)');
    const digest = src.indexOf('computeEffectDigestForRelease(');
    expect(cas).toBeGreaterThan(-1);
    expect(revalidate).toBeGreaterThan(cas);
    expect(digest).toBeGreaterThan(revalidate);
  });

  it('passes a possibly-null winning approval, so an intent approved at creation still revalidates', () => {
    // `script_reviewer` intents (W04) write NO approval_requests row, so the
    // revalidation must tolerate null here rather than short-circuit on it.
    expect(src).toMatch(/winningApproval:\s*approvalRow\s*\?\?\s*null/);
    expect(src).not.toMatch(/if \(!winningApproval\)\s*\{\s*return/);
  });
});
