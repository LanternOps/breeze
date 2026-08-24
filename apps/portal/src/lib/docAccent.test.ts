import { describe, it, expect } from 'vitest';
import { sanitizeAccentColor, buildDocAccentCss } from './docAccent';

describe('sanitizeAccentColor', () => {
  // #ffff is the 4-digit RGBA shorthand and is legitimate; #12345 is not a
  // valid hex length and is rejected below.
  it.each(['#fff', '#ffff', '#ffffff', '#ffffffcc', '#AbC123', 'rebeccapurple', 'rgb(1, 2, 3)', 'rgba(1,2,3,.5)', 'hsl(210 40% 50%)'])(
    'accepts %s',
    (v) => expect(sanitizeAccentColor(v)).toBe(v)
  );

  it('trims surrounding whitespace', () => {
    expect(sanitizeAccentColor('  #123456  ')).toBe('#123456');
  });

  it.each([null, undefined, '', '   '])('rejects empty input %j', (v) => {
    expect(sanitizeAccentColor(v as string)).toBeNull();
  });

  // The value is partner-controlled and lands in a <style> element, so these
  // are the cases that matter: anything that could close the declaration or
  // the rule and start authoring CSS of its own.
  it.each([
    'red}body{display:none',
    '#fff;background:url(x)',
    'red;}@import "evil.css";a{color:red',
    'url(javascript:alert(1))',
    'expression(alert(1))',
    '#fff/*',
    'var(--x)',
    '#12345',
    'rgb(1,2,3)}x{y:z',
    'a'.repeat(65),
  ])('rejects injection attempt %j', (v) => {
    expect(sanitizeAccentColor(v)).toBeNull();
  });
});

describe('buildDocAccentCss', () => {
  it('emits a single custom-property declaration', () => {
    expect(buildDocAccentCss('#123456')).toBe(':root{--doc-accent:#123456}');
  });

  it('emits nothing when there is no usable accent, so the fallback applies', () => {
    expect(buildDocAccentCss(null)).toBeNull();
    expect(buildDocAccentCss('red}body{display:none')).toBeNull();
  });
});
