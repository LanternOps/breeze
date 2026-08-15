import { describe, expect, it } from 'vitest';
import { buildExactValueRedactor, EXACT_REDACTION_MARKER } from './exactSecretRedaction';

describe('buildExactValueRedactor', () => {
  it('replaces every occurrence with a generic marker', () => {
    const redact = buildExactValueRedactor(['hunter2000']);
    expect(redact('token=hunter2000 and again hunter2000')).toBe(
      `token=${EXACT_REDACTION_MARKER} and again ${EXACT_REDACTION_MARKER}`,
    );
  });

  it('never names the variable it redacted', () => {
    // Naming the key would confirm WHICH credential the script emitted, to an
    // audience (scripts:read) wider than the script's author.
    const redact = buildExactValueRedactor(['hunter2000']);
    expect(redact('hunter2000')).toBe(EXACT_REDACTION_MARKER);
  });

  it('treats values as literals, not patterns', () => {
    const redact = buildExactValueRedactor(['a.c*d']);
    expect(redact('abcd a.c*d')).toBe(`abcd ${EXACT_REDACTION_MARKER}`);
  });

  it('merges overlapping matches into a single marker', () => {
    const redact = buildExactValueRedactor(['abcabc', 'bcab']);
    expect(redact('xxabcabcxx')).toBe(`xx${EXACT_REDACTION_MARKER}xx`);
  });

  it('collapses adjacent matches of the same value into separate markers', () => {
    const redact = buildExactValueRedactor(['abcd']);
    expect(redact('abcdabcd')).toBe(`${EXACT_REDACTION_MARKER}${EXACT_REDACTION_MARKER}`);
  });

  it('does not rescan its own marker', () => {
    // A naive replaceAll-per-value pass rewrites text it then rescans, so a
    // value occurring inside "[REDACTED]" would re-fire.
    const redact = buildExactValueRedactor(['secret', 'REDACTED']);
    expect(redact('secret')).toBe(EXACT_REDACTION_MARKER);
  });

  it('is idempotent', () => {
    const redact = buildExactValueRedactor(['hunter2000']);
    const once = redact('x hunter2000 y');
    expect(redact(once)).toBe(once);
  });

  it('dedupes identical values', () => {
    const redact = buildExactValueRedactor(['same-value', 'same-value']);
    expect(redact('same-value')).toBe(EXACT_REDACTION_MARKER);
  });

  it('ignores empty and sub-floor values rather than shredding the output', () => {
    const redact = buildExactValueRedactor(['', 'ab']);
    expect(redact('ab and an empty  gap')).toBe('ab and an empty  gap');
  });

  it('is a passthrough when there is nothing to redact', () => {
    expect(buildExactValueRedactor([])('anything')).toBe('anything');
    expect(buildExactValueRedactor(['hunter2000'])('')).toBe('');
  });

  it('redacts across line boundaries and inside larger tokens', () => {
    const redact = buildExactValueRedactor(['hunter2000']);
    expect(redact('line1\nprefix-hunter2000-suffix\nline3')).toBe(
      `line1\nprefix-${EXACT_REDACTION_MARKER}-suffix\nline3`,
    );
  });

  it('handles a large output without quadratic blowup', () => {
    const redact = buildExactValueRedactor(['hunter2000']);
    const text = `${'x'.repeat(500_000)}hunter2000${'y'.repeat(500_000)}`;
    const started = Date.now();
    expect(redact(text)).toContain(EXACT_REDACTION_MARKER);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
