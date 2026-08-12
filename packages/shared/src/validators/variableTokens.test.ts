import { describe, expect, it } from 'vitest';
import { findVariableTokens, replaceVariableTokens, variableToken } from './variableTokens';

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

  it('round-trips variableToken', () => {
    expect(replaceVariableTokens(variableToken('k'), () => 'v').content).toBe('v');
  });
});
