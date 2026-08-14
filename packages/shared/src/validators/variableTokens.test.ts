import { describe, expect, it } from 'vitest';
import {
  findVariableTokens,
  hasVariableTokens,
  replaceVariableTokens,
  variableToken,
} from './variableTokens';

describe('findVariableTokens', () => {
  it('finds a well-formed token', () => {
    expect(findVariableTokens('curl {{var.repo_url}}/pkg')).toEqual(['repo_url']);
  });

  it('de-duplicates and preserves first-seen order', () => {
    expect(findVariableTokens('{{var.b}} {{var.a}} {{var.b}}')).toEqual(['b', 'a']);
  });

  it('ignores a token escaped by a leading $ — that is shell/Actions syntax', () => {
    expect(findVariableTokens('run ${{var.repo_url}}')).toEqual([]);
  });

  it.each([
    '{{ var.x }}',        // inner whitespace: one strict form only
    '{{VAR.X}}',          // case-sensitive
    '{{var.9bad}}',       // key grammar
    '{{var.Bad_Key}}',
    '{{var.}}',
    '{{var.x}',           // unbalanced
    '{{varx}}',           // no dot
    '{{org.name}}',       // a different namespace passes through
    '{file}',             // the agent's own single-brace token
  ])('does not treat %j as a variable token', (input) => {
    expect(findVariableTokens(input)).toEqual([]);
  });

  it('leaves an unrelated {{...}} expression alone', () => {
    const gha = 'if: ${{ github.event_name == \'push\' }}';
    expect(findVariableTokens(gha)).toEqual([]);
  });
});

describe('replaceVariableTokens', () => {
  it('substitutes verbatim, with no escaping', () => {
    const out = replaceVariableTokens('token={{var.k}}', (k) => (k === 'k' ? 'a b"c' : undefined));
    expect(out).toEqual({ content: 'token=a b"c', unresolved: [] });
  });

  it('reports an unknown key and leaves the token in place', () => {
    const out = replaceVariableTokens('{{var.missing}}', () => undefined);
    expect(out).toEqual({ content: '{{var.missing}}', unresolved: ['missing'] });
  });

  it('treats an empty value as unresolved', () => {
    const out = replaceVariableTokens('{{var.blank}}', () => '');
    expect(out.unresolved).toEqual(['blank']);
    expect(out.content).toBe('{{var.blank}}');
  });

  it('never re-scans a substituted value (no recursive expansion)', () => {
    const out = replaceVariableTokens('{{var.a}}', (k) => (k === 'a' ? '{{var.b}}' : 'SHOULD-NOT-APPEAR'));
    expect(out.content).toBe('{{var.b}}');
  });

  it('leaves a $-escaped token untouched', () => {
    const out = replaceVariableTokens('${{var.k}}', () => 'v');
    expect(out).toEqual({ content: '${{var.k}}', unresolved: [] });
  });

  it('de-duplicates unresolved keys — one missing variable, not three', () => {
    const out = replaceVariableTokens('{{var.x}} {{var.x}} {{var.x}}', () => undefined);
    expect(out.unresolved).toEqual(['x']);
  });

  it('inserts a value containing $& or $1 verbatim, not as a replacement pattern', () => {
    expect(replaceVariableTokens('{{var.k}}', () => 'a$&b').content).toBe('a$&b');
    expect(replaceVariableTokens('{{var.k}}', () => '$1').content).toBe('$1');
  });

  it('round-trips variableToken', () => {
    expect(replaceVariableTokens(variableToken('k'), () => 'v').content).toBe('v');
  });
});

describe('shared-regex state isolation', () => {
  // Regression: VARIABLE_TOKEN_PATTERN used to be a module-level GLOBAL regex.
  // `.test()` advanced its lastIndex and `matchAll` seeds its matcher from the
  // regex it is handed, so a hasVariableTokens() call left an offset that made
  // the next findVariableTokens() skip every token before it. API requests
  // interleave across awaits, so this desynchronised unrelated requests.
  it('findVariableTokens is unaffected by a preceding hasVariableTokens call', () => {
    const content = 'echo {{var.api_key}} then {{var.region}}';
    expect(findVariableTokens(content)).toEqual(['api_key', 'region']);
    expect(hasVariableTokens(content)).toBe(true);
    expect(findVariableTokens(content)).toEqual(['api_key', 'region']);
  });

  it('tokenizes a short template after hasVariableTokens ran on a longer one', () => {
    expect(hasVariableTokens('a much longer script body with {{var.some_key}} inside')).toBe(true);
    // The installerVariables.ts shape: findVariableTokens on an isolated match.
    expect(findVariableTokens('{{var.api_key}}')).toEqual(['api_key']);
  });

  it('replaceVariableTokens is unaffected by a preceding hasVariableTokens call', () => {
    expect(hasVariableTokens('{{var.a}} {{var.b}}')).toBe(true);
    expect(replaceVariableTokens('{{var.a}} {{var.b}}', (k) => k.toUpperCase()).content).toBe('A B');
  });
});
