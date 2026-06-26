import { describe, it, expect } from 'vitest';
import {
  renderTemplate,
  TICKET_TEMPLATE_VARIABLES,
  variablesForContext,
} from './ticketTemplate';

describe('renderTemplate', () => {
  it('substitutes a known token', () => {
    expect(renderTemplate('Hi {{requester_name}}', { requester_name: 'Ada' })).toBe('Hi Ada');
  });

  it('renders unknown tokens as empty string (no raw token leak)', () => {
    expect(renderTemplate('Ticket {{missing}}!', {})).toBe('Ticket !');
  });

  it('tolerates inner whitespace and repeats a token', () => {
    expect(renderTemplate('{{ org_name }} {{org_name}}', { org_name: 'x' })).toBe('x x');
  });

  it('handles adjacent tokens', () => {
    expect(renderTemplate('{{ticket_number}}{{ticket_subject}}', { ticket_number: '1', ticket_subject: '2' })).toBe('12');
  });

  it('leaves an unclosed brace untouched', () => {
    expect(renderTemplate('a {{ org_name', { org_name: 'x' })).toBe('a {{ org_name');
  });

  it('passes through a template with no tokens', () => {
    expect(renderTemplate('plain text', { org_name: 'x' })).toBe('plain text');
  });

  it('returns empty for an empty template', () => {
    expect(renderTemplate('', { org_name: 'x' })).toBe('');
  });

  it('does not recursively expand substituted values', () => {
    // ticket_number's value contains a token; it must NOT be re-scanned/expanded.
    expect(renderTemplate('{{ticket_number}}', { ticket_number: '{{requester_name}}', requester_name: 'NO' })).toBe('{{requester_name}}');
  });
});

describe('variable registry', () => {
  it('exposes the canned-only variables to the canned context but not autoreply', () => {
    const autoKeys = variablesForContext('autoreply').map((v) => v.key);
    const cannedKeys = variablesForContext('canned').map((v) => v.key);
    expect(autoKeys).not.toContain('agent_name');
    expect(cannedKeys).toContain('agent_name');
    expect(autoKeys).toContain('ticket_number');
    expect(cannedKeys).toContain('ticket_number');
  });

  it('every variable declares at least one context', () => {
    for (const v of TICKET_TEMPLATE_VARIABLES) {
      expect(v.contexts.length).toBeGreaterThan(0);
    }
  });
});
