import { describe, it, expect } from 'vitest';
import {
  softwareDownloadPolicySchema,
  privateSoftwareOriginSchema,
  normalizePrivateSoftwareOrigin,
} from './softwareDownloadPolicy';

describe('normalizePrivateSoftwareOrigin', () => {
  it('accepts a valid DNS hostname origin', () => {
    expect(normalizePrivateSoftwareOrigin('https://files.corp.internal')).toBe(
      'https://files.corp.internal',
    );
  });

  it('accepts a valid RFC1918 private-IP origin', () => {
    expect(normalizePrivateSoftwareOrigin('https://10.0.0.5')).toBe('https://10.0.0.5');
  });

  it('accepts a valid RFC1918 private-IP origin in the 192.168.0.0/16 range', () => {
    expect(normalizePrivateSoftwareOrigin('https://192.168.1.10:8443')).toBe(
      'https://192.168.1.10:8443',
    );
  });

  it('accepts a CGNAT-range origin (100.64.0.0/10) — approved-with-allowlist, not banned', () => {
    expect(normalizePrivateSoftwareOrigin('https://100.64.1.2')).toBe('https://100.64.1.2');
  });

  it('accepts a ULA IPv6 origin', () => {
    expect(normalizePrivateSoftwareOrigin('https://[fd12:3456:789a::1]')).toBe(
      'https://[fd12:3456:789a::1]',
    );
  });

  describe('normalization', () => {
    it('lowercases the host and strips the trailing slash', () => {
      expect(normalizePrivateSoftwareOrigin('https://Files.Corp.Internal/')).toBe(
        'https://files.corp.internal',
      );
    });

    it('strips a trailing root dot', () => {
      expect(normalizePrivateSoftwareOrigin('https://files.corp.internal./')).toBe(
        'https://files.corp.internal',
      );
    });

    it('omits the default 443 port whether implicit or explicit', () => {
      expect(normalizePrivateSoftwareOrigin('https://files.corp.internal:443/')).toBe(
        'https://files.corp.internal',
      );
    });

    it('preserves a non-default port', () => {
      expect(normalizePrivateSoftwareOrigin('https://files.corp.internal:8443/')).toBe(
        'https://files.corp.internal:8443',
      );
    });

    it('normalizes an uppercase scheme', () => {
      expect(normalizePrivateSoftwareOrigin('HTTPS://files.corp.internal/')).toBe(
        'https://files.corp.internal',
      );
    });
  });

  describe('rejections', () => {
    it('rejects a non-HTTPS scheme (http)', () => {
      expect(normalizePrivateSoftwareOrigin('http://files.corp.internal')).toBeNull();
    });

    it('rejects a non-HTTPS scheme (ftp)', () => {
      expect(normalizePrivateSoftwareOrigin('ftp://files.corp.internal')).toBeNull();
    });

    it('rejects userinfo', () => {
      expect(normalizePrivateSoftwareOrigin('https://user:pass@files.corp.internal')).toBeNull();
    });

    it('rejects a path other than "/"', () => {
      expect(normalizePrivateSoftwareOrigin('https://files.corp.internal/download')).toBeNull();
    });

    it('rejects a query string', () => {
      expect(normalizePrivateSoftwareOrigin('https://files.corp.internal/?tok=secret')).toBeNull();
    });

    it('rejects a fragment', () => {
      expect(normalizePrivateSoftwareOrigin('https://files.corp.internal/#frag')).toBeNull();
    });

    it('rejects a wildcard host', () => {
      expect(normalizePrivateSoftwareOrigin('https://*.corp.internal')).toBeNull();
    });

    it('rejects an empty string', () => {
      expect(normalizePrivateSoftwareOrigin('')).toBeNull();
    });

    it('rejects a malformed URL', () => {
      expect(normalizePrivateSoftwareOrigin('not a url')).toBeNull();
    });

    it('rejects port 0', () => {
      expect(normalizePrivateSoftwareOrigin('https://files.corp.internal:0')).toBeNull();
    });

    it('rejects an empty-label hostname', () => {
      expect(normalizePrivateSoftwareOrigin('https://host..example')).toBeNull();
    });

    describe('loopback', () => {
      it('rejects 127.0.0.1', () => {
        expect(normalizePrivateSoftwareOrigin('https://127.0.0.1')).toBeNull();
      });

      it('rejects an arbitrary 127.0.0.0/8 address', () => {
        expect(normalizePrivateSoftwareOrigin('https://127.99.42.7')).toBeNull();
      });

      it('rejects the IPv6 loopback ::1', () => {
        expect(normalizePrivateSoftwareOrigin('https://[::1]')).toBeNull();
      });
    });

    describe('link-local', () => {
      it('rejects an IPv4 link-local address', () => {
        expect(normalizePrivateSoftwareOrigin('https://169.254.13.37')).toBeNull();
      });

      it('rejects the IPv6 link-local prefix fe80::/10', () => {
        expect(normalizePrivateSoftwareOrigin('https://[fe80::1]')).toBeNull();
      });
    });

    describe('metadata', () => {
      it('rejects the AWS/Azure/GCP metadata address', () => {
        expect(normalizePrivateSoftwareOrigin('https://169.254.169.254')).toBeNull();
      });

      it('rejects the ECS task metadata address', () => {
        expect(normalizePrivateSoftwareOrigin('https://169.254.170.2')).toBeNull();
      });

      it('rejects the Alibaba metadata address inside the otherwise-allowed CGNAT range', () => {
        expect(normalizePrivateSoftwareOrigin('https://100.100.100.200')).toBeNull();
      });

      it('rejects the metadata.google.internal hostname', () => {
        expect(normalizePrivateSoftwareOrigin('https://metadata.google.internal')).toBeNull();
      });

      it('rejects metadata.google.internal regardless of trailing dots / case', () => {
        expect(normalizePrivateSoftwareOrigin('https://METADATA.GOOGLE.INTERNAL..')).toBeNull();
      });
    });

    describe('other universally-unsafe classes', () => {
      it('rejects the unspecified address 0.0.0.0', () => {
        expect(normalizePrivateSoftwareOrigin('https://0.0.0.0')).toBeNull();
      });

      it('rejects the IPv6 unspecified address ::', () => {
        expect(normalizePrivateSoftwareOrigin('https://[::]')).toBeNull();
      });

      it('rejects an IPv4 multicast address', () => {
        expect(normalizePrivateSoftwareOrigin('https://224.0.0.1')).toBeNull();
      });

      it('rejects an IPv4-mapped IPv6 loopback', () => {
        expect(normalizePrivateSoftwareOrigin('https://[::ffff:127.0.0.1]')).toBeNull();
      });

      it('rejects an IPv4-mapped IPv6 origin wrapping a benign private (RFC1918) payload', () => {
        // agent/internal/netpolicy's checkHostShape rejects EVERY IPv4-mapped
        // literal (a.Is4In6()) regardless of payload, not just a forbidden
        // one — Go's own newOriginSet/NewClient fails client construction
        // outright on the first unparseable configured origin, so a
        // validator-blessed IPv4-mapped origin here would break agent policy
        // handling for every device receiving the policy, even though
        // 10.0.0.5 itself is a perfectly legitimate destination written the
        // normal way (https://10.0.0.5).
        expect(normalizePrivateSoftwareOrigin('https://[::ffff:10.0.0.5]')).toBeNull();
      });

      it('rejects an IPv4-mapped IPv6 origin wrapping a benign public payload', () => {
        expect(normalizePrivateSoftwareOrigin('https://[::ffff:8.8.8.8]')).toBeNull();
      });
    });

    describe('IPv6 transition encodings wrapping a forbidden IPv4 address', () => {
      // Mirrors agent/internal/netpolicy/address_test.go's TestClassifyAddress
      // "ambiguous IPv6 encodings" cases — an attacker who can't get a raw
      // forbidden literal past this validator could otherwise wrap the same
      // destination in one of these historical/transition forms.
      it('rejects a 6to4 address wrapping loopback', () => {
        expect(normalizePrivateSoftwareOrigin('https://[2002:7f00:1::]')).toBeNull();
      });

      it('rejects a Teredo address wrapping loopback', () => {
        expect(normalizePrivateSoftwareOrigin('https://[2001::80ff:fffe]')).toBeNull();
      });

      it('rejects a NAT64 address wrapping loopback', () => {
        expect(normalizePrivateSoftwareOrigin('https://[64:ff9b::7f00:1]')).toBeNull();
      });

      it('rejects an IPv4-compatible address wrapping loopback', () => {
        expect(normalizePrivateSoftwareOrigin('https://[::7f00:1]')).toBeNull();
      });

      it('rejects an IPv4-translated address wrapping loopback', () => {
        expect(normalizePrivateSoftwareOrigin('https://[::ffff:0:7f00:1]')).toBeNull();
      });

      it('accepts a NAT64 address wrapping an RFC1918 address (private, not forbidden)', () => {
        expect(normalizePrivateSoftwareOrigin('https://[64:ff9b::a00:5]')).toBe(
          'https://[64:ff9b::a00:5]',
        );
      });

      it('accepts an IPv4-compatible address wrapping an RFC1918 address (private, not forbidden)', () => {
        expect(normalizePrivateSoftwareOrigin('https://[::a00:5]')).toBe('https://[::a00:5]');
      });
    });
  });
});

describe('privateSoftwareOriginSchema', () => {
  it('parses a valid origin to its normalized form', () => {
    expect(privateSoftwareOriginSchema.parse('https://Files.Corp.Internal:443/')).toBe(
      'https://files.corp.internal',
    );
  });

  it('rejects an invalid origin', () => {
    expect(privateSoftwareOriginSchema.safeParse('https://127.0.0.1').success).toBe(false);
  });
});

describe('softwareDownloadPolicySchema', () => {
  const validPolicy = {
    version: 1 as const,
    approvedPrivateOrigins: ['https://files.corp.internal', 'https://10.0.0.5'],
  };

  it('accepts a valid policy', () => {
    const result = softwareDownloadPolicySchema.safeParse(validPolicy);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.approvedPrivateOrigins).toEqual([
        'https://files.corp.internal',
        'https://10.0.0.5',
      ]);
    }
  });

  it('accepts an empty allowlist', () => {
    expect(softwareDownloadPolicySchema.safeParse({ version: 1, approvedPrivateOrigins: [] }).success).toBe(
      true,
    );
  });

  it('rejects version values other than 1', () => {
    expect(
      softwareDownloadPolicySchema.safeParse({ ...validPolicy, version: 2 }).success,
    ).toBe(false);
  });

  it('rejects more than 32 entries', () => {
    const tooMany = {
      version: 1 as const,
      approvedPrivateOrigins: Array.from({ length: 33 }, (_, i) => `https://host-${i}.corp.internal`),
    };
    expect(softwareDownloadPolicySchema.safeParse(tooMany).success).toBe(false);
  });

  it('accepts exactly 32 entries', () => {
    const exactly32 = {
      version: 1 as const,
      approvedPrivateOrigins: Array.from({ length: 32 }, (_, i) => `https://host-${i}.corp.internal`),
    };
    expect(softwareDownloadPolicySchema.safeParse(exactly32).success).toBe(true);
  });

  it('rejects unknown keys (.strict())', () => {
    expect(
      softwareDownloadPolicySchema.safeParse({ ...validPolicy, extra: 'nope' }).success,
    ).toBe(false);
  });

  it('rejects a policy containing one invalid origin', () => {
    expect(
      softwareDownloadPolicySchema.safeParse({
        version: 1,
        approvedPrivateOrigins: ['https://10.0.0.5', 'https://127.0.0.1'],
      }).success,
    ).toBe(false);
  });
});
