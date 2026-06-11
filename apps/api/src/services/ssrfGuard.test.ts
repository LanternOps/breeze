import { describe, expect, it } from 'vitest';
import { checkSsrfSafe, isSsrfSafe } from './ssrfGuard';

describe('ssrfGuard', () => {
  describe('strict-https mode', () => {
    const opts = { mode: 'strict-https' as const };

    it('accepts a normal public HTTPS URL', () => {
      expect(checkSsrfSafe('https://api.example.com/v1/things', opts)).toEqual({ ok: true });
    });

    it('rejects HTTP', () => {
      expect(isSsrfSafe('http://api.example.com', opts)).toBe(false);
    });

    it('rejects cloud-metadata IPv4 (AWS / OpenStack)', () => {
      expect(isSsrfSafe('https://169.254.169.254/latest/meta-data/', opts)).toBe(false);
    });

    it('rejects cloud-metadata hostname (GCP)', () => {
      expect(isSsrfSafe('https://metadata.google.internal/computeMetadata/', opts)).toBe(false);
    });

    it('rejects loopback hostname alias', () => {
      expect(isSsrfSafe('https://localhost/', opts)).toBe(false);
    });

    it('rejects 127.0.0.1', () => {
      expect(isSsrfSafe('https://127.0.0.1/', opts)).toBe(false);
    });

    it('rejects ::1', () => {
      expect(isSsrfSafe('https://[::1]/', opts)).toBe(false);
    });

    it('rejects RFC1918 in strict-https mode', () => {
      expect(isSsrfSafe('https://10.0.0.5/', opts)).toBe(false);
      expect(isSsrfSafe('https://192.168.1.1/', opts)).toBe(false);
      expect(isSsrfSafe('https://172.20.0.1/', opts)).toBe(false);
    });

    it('rejects CGNAT 100.64.0.0/10', () => {
      expect(isSsrfSafe('https://100.64.0.5/', opts)).toBe(false);
    });

    it('rejects IPv6 unique-local fc00::/7', () => {
      expect(isSsrfSafe('https://[fd00::1]/', opts)).toBe(false);
    });

    it('rejects IPv4-mapped IPv6 loopback', () => {
      expect(isSsrfSafe('https://[::ffff:127.0.0.1]/', opts)).toBe(false);
    });

    it('rejects unparseable URL', () => {
      expect(isSsrfSafe('not a url', opts)).toBe(false);
    });

    it('rejects URL with empty hostname (file:// style — caught by scheme check)', () => {
      expect(isSsrfSafe('https://', opts)).toBe(false);
    });

    it('rejects non-http(s) schemes', () => {
      expect(isSsrfSafe('file:///etc/passwd', opts)).toBe(false);
      expect(isSsrfSafe('gopher://example.com/', opts)).toBe(false);
    });

    it('rejects ftp scheme', () => {
      expect(isSsrfSafe('ftp://example.com/', opts)).toBe(false);
    });

    it('accepts 172.15 (below private range)', () => {
      expect(isSsrfSafe('https://172.15.0.1/', opts)).toBe(true);
    });

    it('accepts 172.32 (above private range)', () => {
      expect(isSsrfSafe('https://172.32.0.1/', opts)).toBe(true);
    });
  });

  describe('on-prem-http mode', () => {
    const opts = { mode: 'on-prem-http' as const };

    it('accepts HTTP', () => {
      expect(isSsrfSafe('http://pi-hole.lan/admin/', opts)).toBe(true);
    });

    it('accepts HTTPS', () => {
      expect(isSsrfSafe('https://adguard.example.com/', opts)).toBe(true);
    });

    it('accepts RFC1918 (on-prem appliances live there)', () => {
      expect(isSsrfSafe('http://192.168.1.50/', opts)).toBe(true);
      expect(isSsrfSafe('http://10.0.0.5/', opts)).toBe(true);
      expect(isSsrfSafe('http://172.20.0.1/', opts)).toBe(true);
    });

    it('still rejects loopback', () => {
      expect(isSsrfSafe('http://127.0.0.1/', opts)).toBe(false);
      expect(isSsrfSafe('http://localhost/', opts)).toBe(false);
    });

    it('still rejects link-local / metadata', () => {
      expect(isSsrfSafe('http://169.254.169.254/', opts)).toBe(false);
    });
  });

  describe('on-prem-strict mode', () => {
    const opts = { mode: 'on-prem-strict' as const };

    it('accepts a public HTTP host (on-prem appliance reachable over WAN)', () => {
      expect(isSsrfSafe('http://adguard.public.example.com/', opts)).toBe(true);
    });

    it('rejects RFC1918 (hosted-saas can\'t reach customer LAN)', () => {
      expect(isSsrfSafe('http://192.168.1.50/', opts)).toBe(false);
    });

    it('rejects loopback / link-local same as the other modes', () => {
      expect(isSsrfSafe('http://127.0.0.1/', opts)).toBe(false);
      expect(isSsrfSafe('http://169.254.169.254/', opts)).toBe(false);
    });
  });

  describe('hostnameAllowlist', () => {
    it('accepts hostname ending with allowed suffix', () => {
      expect(
        isSsrfSafe('https://usea1-partners.sentinelone.net/web/api', {
          mode: 'strict-https',
          hostnameAllowlist: ['.sentinelone.net'],
        })
      ).toBe(true);
    });

    it('rejects hostname not on allowlist even if public + HTTPS', () => {
      expect(
        isSsrfSafe('https://internal-vault.cluster.example.com/', {
          mode: 'strict-https',
          hostnameAllowlist: ['.sentinelone.net'],
        })
      ).toBe(false);
    });

    it('rejects subdomain match without the leading dot guard (no .sentinel.one match)', () => {
      expect(
        isSsrfSafe('https://attacker-sentinelone.net.evil.com/', {
          mode: 'strict-https',
          hostnameAllowlist: ['.sentinelone.net'],
        })
      ).toBe(false);
    });
  });
});
