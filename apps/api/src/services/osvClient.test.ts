import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryOsvForPackage } from './osvClient';

beforeEach(() => {
  (global as any).fetch = vi.fn();
});

describe('osvClient', () => {
  it('queries OSV.dev for a package + version', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        vulns: [
          {
            id: 'CVE-2024-9999',
            database_specific: { severity: 'CRITICAL' },
          },
        ],
      }),
    });

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
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        vulns: [
          {
            id: 'GHSA-xxxx-yyyy',
            aliases: ['CVE-2024-1111'],
            database_specific: { severity: 'HIGH' },
          },
        ],
      }),
    });
    const r = await queryOsvForPackage({
      ecosystem: 'npm',
      name: 'p',
      version: '1.0.0',
    });
    expect(r.cveIds).toEqual(['CVE-2024-1111']);
    expect(r.maxSeverity).toBe('important');
  });

  it('returns empty result when no vulns', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    const r = await queryOsvForPackage({
      ecosystem: 'npm',
      name: 'safe',
      version: '1.0.0',
    });
    expect(r.cveIds).toEqual([]);
    expect(r.maxSeverity).toBeNull();
  });

  it('throws on non-ok response', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    await expect(
      queryOsvForPackage({ ecosystem: 'npm', name: 'x', version: '1.0.0' })
    ).rejects.toThrow(/OSV query failed/);
  });

  it('deduplicates CVE IDs across vulns', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        vulns: [
          { id: 'CVE-2024-1', database_specific: { severity: 'HIGH' } },
          { id: 'CVE-2024-1', database_specific: { severity: 'CRITICAL' } },
        ],
      }),
    });
    const r = await queryOsvForPackage({
      ecosystem: 'npm',
      name: 'p',
      version: '1.0.0',
    });
    expect(r.cveIds).toEqual(['CVE-2024-1']);
    expect(r.maxSeverity).toBe('critical');
  });
});
