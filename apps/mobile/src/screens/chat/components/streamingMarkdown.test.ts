import { describe, expect, it } from 'vitest';
import { sanitizeStreamingMarkdown } from './streamingMarkdown';

describe('sanitizeStreamingMarkdown (#5170)', () => {
  it('strips a dangling unmatched bold opener', () => {
    // The symptom: `**IPFSVCHOST /` prints the literal `**` until the
    // closing marker streams in. Strip the opener so the in-flight frame
    // reads as plain text instead.
    expect(sanitizeStreamingMarkdown('Fetching **IPFSVCHOST /')).toBe('Fetching IPFSVCHOST /');
    expect(sanitizeStreamingMarkdown('Meeting at **9 PM,')).toBe('Meeting at 9 PM,');
  });

  it('leaves a balanced bold span untouched', () => {
    expect(sanitizeStreamingMarkdown('This is **bold** text')).toBe('This is **bold** text');
  });

  it('leaves a trailing lone `*` in a list bullet line alone', () => {
    // Streaming char-by-char, a new bullet line arrives as "*" before its
    // trailing space — that's a list marker in progress, not a dangling
    // emphasis opener, and must not be stripped.
    expect(sanitizeStreamingMarkdown('- item\n*')).toBe('- item\n*');
  });

  it('strips a dangling single-asterisk italic opener outside a list context', () => {
    expect(sanitizeStreamingMarkdown('Hello *world')).toBe('Hello world');
  });

  it('leaves a balanced italic span untouched', () => {
    expect(sanitizeStreamingMarkdown('Hello *world* there')).toBe('Hello *world* there');
  });

  it('strips a dangling single backtick opener', () => {
    expect(sanitizeStreamingMarkdown('Run `kubectl get pods')).toBe('Run kubectl get pods');
  });

  it('leaves an unterminated fenced code block untouched, backticks and all', () => {
    const buffer = 'Here:\n```bash\necho "**not bold** `also not code`"\n';
    expect(sanitizeStreamingMarkdown(buffer)).toBe(buffer);
  });

  it('leaves a completed fenced code block untouched even with dangling text after it', () => {
    const buffer = '```js\nconst a = 1;\n```\nand then **more';
    expect(sanitizeStreamingMarkdown(buffer)).toBe('```js\nconst a = 1;\n```\nand then more');
  });

  it('is a no-op on empty content', () => {
    expect(sanitizeStreamingMarkdown('')).toBe('');
  });
});
