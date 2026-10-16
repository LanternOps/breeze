import { describe, it, expect } from 'vitest';
import { workspaceUrl } from './workspaceUrl';
import type { AgentConfig } from './helperFetch';

const config: AgentConfig = { api_url: 'https://api.example.test', agent_id: 'a1' };

describe('workspaceUrl', () => {
  it('builds the helper base path with no query string', () => {
    expect(workspaceUrl(config, '/capabilities')).toBe(
      'https://api.example.test/api/v1/workspace/helper/capabilities',
    );
  });
  it('omits "?" for empty params', () => {
    expect(workspaceUrl(config, '/sources', new URLSearchParams())).toBe(
      'https://api.example.test/api/v1/workspace/helper/sources',
    );
  });
  it('appends encoded params', () => {
    const p = new URLSearchParams({ q: 'a b&c', limit: '5' });
    expect(workspaceUrl(config, '/search', p)).toBe(
      'https://api.example.test/api/v1/workspace/helper/search?q=a+b%26c&limit=5',
    );
  });
  it('keeps nested paths intact', () => {
    expect(workspaceUrl(config, '/filing/abc/assign')).toBe(
      'https://api.example.test/api/v1/workspace/helper/filing/abc/assign',
    );
  });
});
