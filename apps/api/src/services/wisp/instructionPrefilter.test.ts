import { describe, it, expect } from 'vitest';
import { prefilterInstruction, INSTRUCTION_PREFILTER_MAX_CHARS } from './instructionPrefilter';

describe('prefilterInstruction', () => {
  it.each([
    "don't reboot PC-01 and PC-02",
    'never patch the CEO laptop',
    'always ask before restarting services on SRV-DB',
    'avoid touching Mickey until Friday',
    'Don’t reboot Mickey',
    'From now on, ping me first',
    'make sure to snapshot first',
  ])('hits: %s', (msg) => {
    expect(prefilterInstruction(msg).hit).toBe(true);
  });

  it.each([
    ['quoted line', '> never reply to Bob'],
    ['backtick fence', 'see this:\n```\ndo not deploy\n```\nthanks'],
    ['tilde fence', 'see this:\n~~~\ndo not deploy\n~~~\nthanks'],
    ['question', 'What changed on PC-01?'],
    ['neverland', 'the neverland server is down'],
    ['stopwatch', 'stopwatch app crashed'],
    ['unclosed fence', '``` \n never do X'],
  ])('misses: %s', (_n, msg) => {
    expect(prefilterInstruction(msg).hit).toBe(false);
  });

  it('mixed quoted and unquoted', () => {
    const r = prefilterInstruction("> never reply to Bob\ndon't reboot PC-01");
    expect(r.hit).toBe(true);
    expect(r.text).not.toContain('Bob');
  });

  it('a ~~~ fence is not closed by ```', () => {
    const r = prefilterInstruction('~~~\n```\nnever x\n~~~\nok');
    expect(r.hit).toBe(false);
    expect(r.text).toBe('ok');
  });

  it('caps text', () => {
    const r = prefilterInstruction('a'.repeat(10000));
    expect(r.text.length).toBeLessThanOrEqual(INSTRUCTION_PREFILTER_MAX_CHARS);
  });

  it('does not split surrogate pairs at the cap', () => {
    const r = prefilterInstruction('😀'.repeat(5000));
    expect(Array.from(r.text).length).toBe(INSTRUCTION_PREFILTER_MAX_CHARS);
  });

  it('removed fenced content never appears in text', () => {
    const r = prefilterInstruction('hi\n```\nSECRET do not\n```\nbye');
    expect(r.text).not.toContain('SECRET');
    expect(r.text).toContain('hi');
    expect(r.text).toContain('bye');
  });
});
