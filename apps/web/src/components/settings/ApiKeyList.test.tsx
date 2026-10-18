import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ApiKeyList from './ApiKeyList';

describe('ApiKeyList status filter select accessible name (#7156)', () => {
  it('gives the status filter select a real accessible name', () => {
    render(<ApiKeyList apiKeys={[]} />);
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
  });
});

describe('ApiKeyList MCP domains badge (#6156)', () => {
  const base = {
    keyPrefix: 'brz_abc',
    createdAt: '2026-09-01T00:00:00.000Z',
    lastUsedAt: null,
    status: 'active' as const,
    expiresAt: null,
    rateLimit: null,
  };

  it('list badge renders All tools / N areas', () => {
    render(
      <ApiKeyList
        apiKeys={[
          { ...base, id: 'k-all', name: 'All', scopes: ['ai:read'], mcpDomains: null },
          { ...base, id: 'k-two', name: 'Two', scopes: ['ai:read'], mcpDomains: ['tickets', 'devices'] },
          { ...base, id: 'k-one', name: 'One', scopes: ['ai:write'], mcpDomains: ['billing'] },
          { ...base, id: 'k-none', name: 'None', scopes: ['devices:read'], mcpDomains: null },
          { ...base, id: 'k-legacy', name: 'Legacy', scopes: ['ai:read'] },
        ]}
      />,
    );
    expect(screen.getByTestId('api-key-mcp-domains-k-all').textContent).toBe('All tools');
    expect(screen.getByTestId('api-key-mcp-domains-k-two').textContent).toBe('2 areas');
    expect(screen.getByTestId('api-key-mcp-domains-k-one').textContent).toBe('1 area');
    expect(screen.queryByTestId('api-key-mcp-domains-k-none')).toBeNull();
    // A row without the field (older API) is unrestricted.
    expect(screen.getByTestId('api-key-mcp-domains-k-legacy').textContent).toBe('All tools');
  });
});
