import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZendeskProvider } from './zendesk';
import { psaFetch } from './http';

vi.mock('./http', () => ({
  psaFetch: vi.fn(),
}));

const psaFetchMock = vi.mocked(psaFetch);

const credentials = {
  baseUrl: 'https://acme.zendesk.com',
  email: 'agent@acme.com',
  apiToken: 'tok-123',
};

describe('ZendeskProvider.testConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success and calls the identity endpoint with Basic auth', async () => {
    psaFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ user: { id: 1 } }), { status: 200 })
    );

    const provider = new ZendeskProvider(credentials);
    const result = await provider.testConnection();

    expect(result).toEqual({ success: true, message: 'Connected to Zendesk' });
    expect(psaFetchMock).toHaveBeenCalledWith(
      'https://acme.zendesk.com/api/v2/users/me.json',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from('agent@acme.com/token:tok-123').toString('base64')}`,
        }),
      })
    );
  });

  it('returns success:false with the upstream status embedded on auth failure (never throws)', async () => {
    psaFetchMock.mockResolvedValueOnce(new Response('Couldn\'t authenticate you', { status: 401 }));

    const provider = new ZendeskProvider(credentials);
    const result = await provider.testConnection();

    expect(result.success).toBe(false);
    expect(result.message).toContain('Zendesk API error (401)');
  });

  it('returns success:false when the fetch itself rejects (SSRF guard / network error)', async () => {
    psaFetchMock.mockRejectedValueOnce(new Error('PSA URL rejected: private address'));

    const provider = new ZendeskProvider(credentials);
    const result = await provider.testConnection();

    expect(result).toEqual({ success: false, message: 'PSA URL rejected: private address' });
  });

  it('strips a trailing slash from baseUrl before building the request URL', async () => {
    psaFetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const provider = new ZendeskProvider({ ...credentials, baseUrl: 'https://acme.zendesk.com/' });
    await provider.testConnection();

    expect(psaFetchMock).toHaveBeenCalledWith(
      'https://acme.zendesk.com/api/v2/users/me.json',
      expect.anything()
    );
  });
});
