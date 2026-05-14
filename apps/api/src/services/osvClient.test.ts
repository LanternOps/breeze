import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryOsvForPackage, OsvRateLimitError, OsvServerError } from './osvClient';

beforeEach(() => {
  (global as any).fetch = vi.fn();
});

function okResponse(body: unknown) {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    text: async () => text,
  };
}

describe('osvClient', () => {
  it('queries OSV.dev for a package + version', async () => {
    (global.fetch as any).mockResolvedValue(
      okResponse({
        vulns: [
          {
            id: 'CVE-2024-9999',
            database_specific: { severity: 'CRITICAL' },
          },
        ],
      })
    );

    const result = await queryOsvForPackage({
      ecosystem: 'npm',
      name: 'lodash',
      version: '4.17.20',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.osv.dev/v1/query',
      expect.objectContaining({ method: 'POST' })
    );
    expect(result.cveIds).toEqual(['CVE-2024-9999']);
    expect(result.maxSeverity).toBe('critical');
  });

  it('extracts CVEs from aliases when id is non-CVE', async () => {
    (global.fetch as any).mockResolvedValue(
      okResponse({
        vulns: [
          {
            id: 'GHSA-xxxx-yyyy',
            aliases: ['CVE-2024-1111'],
            database_specific: { severity: 'HIGH' },
          },
        ],
      })
    );
    const r = await queryOsvForPackage({
      ecosystem: 'npm',
      name: 'p',
      version: '1.0.0',
    });
    expect(r.cveIds).toEqual(['CVE-2024-1111']);
    expect(r.maxSeverity).toBe('important');
  });

  it('returns empty result when no vulns', async () => {
    (global.fetch as any).mockResolvedValue(okResponse({}));
    const r = await queryOsvForPackage({
      ecosystem: 'npm',
      name: 'safe',
      version: '1.0.0',
    });
    expect(r.cveIds).toEqual([]);
    expect(r.maxSeverity).toBeNull();
  });

  it('throws OsvServerError on 5xx response', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    });
    await expect(
      queryOsvForPackage({ ecosystem: 'npm', name: 'x', version: '1.0.0' })
    ).rejects.toBeInstanceOf(OsvServerError);
  });

  it('throws OsvRateLimitError on 429 response', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    });
    await expect(
      queryOsvForPackage({ ecosystem: 'npm', name: 'x', version: '1.0.0' })
    ).rejects.toBeInstanceOf(OsvRateLimitError);
  });

  it('deduplicates CVE IDs across vulns', async () => {
    (global.fetch as any).mockResolvedValue(
      okResponse({
        vulns: [
          { id: 'CVE-2024-1', database_specific: { severity: 'HIGH' } },
          { id: 'CVE-2024-1', database_specific: { severity: 'CRITICAL' } },
        ],
      })
    );
    const r = await queryOsvForPackage({
      ecosystem: 'npm',
      name: 'p',
      version: '1.0.0',
    });
    expect(r.cveIds).toEqual(['CVE-2024-1']);
    expect(r.maxSeverity).toBe('critical');
  });
});
