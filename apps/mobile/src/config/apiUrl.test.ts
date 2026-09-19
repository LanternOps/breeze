import { describe, expect, it, vi } from 'vitest';

import {
  ALLOW_PRIVATE_API_URL_VAR,
  API_URL_VAR,
  assertReleaseApiUrl,
  describeApiUrlProblem,
} from './apiUrl';
import { FORCE_DEV_VAR } from './releaseBuild';

const HOSTED = 'https://us.2breeze.app';

/** The env a release Xcode Archive evaluates `app.config.js` under. */
const archive = (extra: Record<string, string | undefined> = {}) => ({
  CONFIGURATION: 'Release',
  ...extra,
});

describe('describeApiUrlProblem', () => {
  it('accepts the hosted regions and a self-hosted https host', () => {
    for (const value of [
      HOSTED,
      'https://eu.2breeze.app',
      `  ${HOSTED}  `,
      'https://us.2breeze.app/', // trailing slash, as pasted from a browser
      'https://breeze.acme-msp.co.uk',
      'https://rmm.acme.internal.acme.com:8443/api', // port + path prefix
      'https://203.0.113.10', // a public IP literal is unusual but reachable
    ]) {
      expect(describeApiUrlProblem(value)).toBeNull();
    }
  });

  it('reports an unset value', () => {
    for (const value of [undefined, null, '', '   ']) {
      expect(describeApiUrlProblem(value)).toBe('is not set');
    }
  });

  // The headline case from issue #3943: this is what ships when nobody sets the
  // variable, because every service module defaults to it.
  it('rejects loopback in every spelling', () => {
    for (const value of [
      'http://localhost:3001',
      'https://localhost',
      'http://LOCALHOST:3001',
      'http://api.localhost:3001',
      'http://127.0.0.1:3001',
      'http://127.1.2.3',
      'http://[::1]:3001',
      'http://0.0.0.0:3001',
    ]) {
      expect(describeApiUrlProblem(value)).toMatch(/the phone itself/);
    }
  });

  // Loopback is not opt-out-able: there is no build where the phone's own
  // loopback is a real API host. `BREEZE_MOBILE_DEV=1` is the escape hatch.
  it('rejects loopback even with the private-address opt-in set', () => {
    expect(describeApiUrlProblem('http://localhost:3001', { allowPrivate: true })).toMatch(
      /the phone itself/
    );
    expect(describeApiUrlProblem('http://0.0.0.0:3001', { allowPrivate: true })).toMatch(
      /the phone itself/
    );
  });

  it('rejects private-network addresses by default', () => {
    for (const value of [
      'http://192.168.1.50:3001',
      'https://10.0.0.5',
      'https://172.16.4.4',
      'https://172.31.255.254',
      'http://169.254.10.1', // APIPA
      'https://100.100.1.1', // CGNAT / Tailscale
      'http://breeze.local:3001', // mDNS
      'https://rmm.lan',
      'https://breeze.internal',
      'http://[fd00::1]',
      'http://[fe80::1]',
    ]) {
      expect(describeApiUrlProblem(value)).toMatch(/private-network address/);
    }
  });

  // 172.16/12 is a /12, not a /8 — 172.15 and 172.32 are public.
  it('does not over-claim the 172 range', () => {
    expect(describeApiUrlProblem('https://172.15.0.1')).toBeNull();
    expect(describeApiUrlProblem('https://172.32.0.1')).toBeNull();
    expect(describeApiUrlProblem('https://100.63.0.1')).toBeNull();
    expect(describeApiUrlProblem('https://100.128.0.1')).toBeNull();
  });

  // An MSP building an internal-distribution app for a LAN-hosted Breeze is a
  // real, supported case — this repo ships a self-hosted mode. Plaintext is
  // allowed on that same opt-in, because a LAN box often has no public cert.
  it('accepts private addresses, including plaintext, when opted in', () => {
    for (const value of ['http://192.168.1.50:3001', 'https://10.0.0.5', 'http://breeze.local']) {
      expect(describeApiUrlProblem(value, { allowPrivate: true })).toBeNull();
    }
  });

  it('rejects plaintext http to a public host', () => {
    expect(describeApiUrlProblem('http://us.2breeze.app')).toMatch(/plaintext http/);
    expect(describeApiUrlProblem('http://breeze.acme-msp.co.uk')).toMatch(/plaintext http/);
  });

  // The opt-in says "a private host is fine", never "plaintext to the open
  // internet is fine". Gating the plaintext branch on it — which the first cut
  // of this file did — let a build that had the flag set for LAN testing ship
  // http:// to a public host, which ATS then blocks on the device, silently.
  it('still rejects plaintext to a PUBLIC host under the private opt-in', () => {
    expect(describeApiUrlProblem('http://us.2breeze.app', { allowPrivate: true })).toMatch(
      /plaintext http/
    );
    expect(describeApiUrlProblem('http://breeze.acme-msp.co.uk', { allowPrivate: true })).toMatch(
      /plaintext http/
    );
  });

  // The WHATWG parser normalises an IPv4-mapped IPv6 literal into hex groups
  // (`::ffff:127.0.0.1` -> `::ffff:7f00:1`), so the dotted-quad rules only see
  // it if `normalizeHost` folds it back.
  it('sees through IPv4-mapped IPv6 literals', () => {
    expect(describeApiUrlProblem('https://[::ffff:127.0.0.1]')).toMatch(/the phone itself/);
    expect(describeApiUrlProblem('https://[::ffff:7f00:1]')).toMatch(/the phone itself/);
    expect(describeApiUrlProblem('https://[::ffff:192.168.1.50]')).toMatch(
      /private-network address/
    );
    // A mapped PUBLIC address is still fine — the folding must not over-reject.
    expect(describeApiUrlProblem('https://[::ffff:203.0.113.10]')).toBeNull();
  });

  // The URL parser canonicalises octal, decimal and short-form IPv4 before the
  // dotted-quad rules run, so obfuscated loopback needs no special handling —
  // but it must actually be caught, so assert it rather than assume it.
  it('catches obfuscated IPv4 loopback spellings', () => {
    for (const value of ['https://0177.0.0.1', 'https://2130706433', 'https://127.1']) {
      expect(describeApiUrlProblem(value)).toMatch(/the phone itself/);
    }
  });

  it('rejects values that are not usable URLs', () => {
    for (const value of [
      'us.2breeze.app', // no scheme
      'not a url',
      'ftp://us.2breeze.app',
      'wss://us.2breeze.app',
      'https://<your-host>', // angle brackets are forbidden host characters
      'TODO',
    ]) {
      expect(describeApiUrlProblem(value)).toMatch(/not a valid URL/);
    }
  });

  // eas.json and .env.example both ship example-shaped values, and RFC 2606
  // domains can never be a real deployment.
  it('rejects placeholders that would otherwise parse', () => {
    for (const value of [
      'https://your-domain.example.com',
      'https://api.example.org',
      'https://CHANGEME.acme.com',
      'https://placeholder.acme.com',
    ]) {
      expect(describeApiUrlProblem(value)).toMatch(/placeholder/);
    }
  });

  // Matching runs on the hostname only, so a real host is not rejected for a
  // word that happens to appear elsewhere in the URL.
  it('does not read placeholder markers out of the path or query', () => {
    expect(describeApiUrlProblem('https://us.2breeze.app/example.com/todo')).toBeNull();
    expect(describeApiUrlProblem('https://us.2breeze.app/?next=changeme')).toBeNull();
  });

  // Reserved domains match as a suffix and marker words as a whole LABEL. A
  // substring match would break real customers: `forexample.com` contains
  // `example.com`, and `changemedia.com` contains `changeme`.
  it('does not reject real hosts that merely contain a marker', () => {
    for (const value of [
      'https://forexample.com',
      'https://changemedia.com',
      'https://api.exampleco.com',
      'https://yourdomainname.io',
      'https://placeholders.acme.com',
    ]) {
      expect(describeApiUrlProblem(value)).toBeNull();
    }
  });
});

describe('assertReleaseApiUrl', () => {
  describe('a release build with an unusable URL', () => {
    it('throws on an Xcode Archive with no API URL', () => {
      expect(() => assertReleaseApiUrl(archive())).toThrow(/refusing to build/);
    });

    it('throws on an Xcode Archive pointing at localhost', () => {
      expect(() => assertReleaseApiUrl(archive({ [API_URL_VAR]: 'http://localhost:3001' }))).toThrow(
        /the phone itself/
      );
    });

    it('throws on an EAS production build', () => {
      expect(() => assertReleaseApiUrl({ EAS_BUILD_PROFILE: 'production' })).toThrow(
        /refusing to build/
      );
    });

    it('names the variable, the reason, and both places to set it', () => {
      let message = '';
      try {
        assertReleaseApiUrl(archive());
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain(API_URL_VAR);
      expect(message).toContain('CONFIGURATION="Release"');
      expect(message).toContain('apps/mobile/.env');
      expect(message).toContain('eas env:create');
      expect(message).toContain(ALLOW_PRIVATE_API_URL_VAR);
    });

    // The message has to name the environment actually being built, or the user
    // configures `production`, rebuilds `preview`, and fails again.
    it('names the EAS environment matching the profile being built', () => {
      const messageFor = (profile: string) => {
        try {
          assertReleaseApiUrl({ EAS_BUILD_PROFILE: profile });
        } catch (err) {
          return (err as Error).message;
        }
        throw new Error('expected a throw');
      };
      expect(messageFor('preview')).toContain('--environment preview');
      expect(messageFor('production')).toContain('--environment production');
      expect(messageFor('production-eu')).toContain('--environment production');
    });
  });

  describe('a release build with a usable URL', () => {
    it('returns silently', () => {
      const warn = vi.fn();
      expect(() => assertReleaseApiUrl(archive({ [API_URL_VAR]: HOSTED }), { warn })).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
    });

    it('trims surrounding whitespace from a pasted value', () => {
      expect(() => assertReleaseApiUrl(archive({ [API_URL_VAR]: `\t${HOSTED}\n` }))).not.toThrow();
    });
  });

  describe('the private-address opt-in', () => {
    it('lets a LAN release build through', () => {
      expect(() =>
        assertReleaseApiUrl(
          archive({ [API_URL_VAR]: 'http://192.168.1.50:3001', [ALLOW_PRIVATE_API_URL_VAR]: '1' }),
          { warn: vi.fn() }
        )
      ).not.toThrow();
    });

    // An escape hatch that suppresses a guard in silence is the exact failure
    // this module exists to stop, and it is the pattern
    // BREEZE_MOBILE_ALLOW_NO_SENTRY already set next door. The first cut of this
    // file folded the flag into the problem calculation, so the rescue happened
    // before anything could report it.
    it('says so on every build where it rescued a value', () => {
      const warn = vi.fn();
      assertReleaseApiUrl(
        archive({ [API_URL_VAR]: 'http://192.168.1.50:3001', [ALLOW_PRIVATE_API_URL_VAR]: '1' }),
        { warn }
      );
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain(ALLOW_PRIVATE_API_URL_VAR);
      expect(message).toContain('192.168.1.50');
      expect(message).toContain('CONFIGURATION="Release"');
    });

    it('stays silent when the URL needed no rescuing', () => {
      const warn = vi.fn();
      assertReleaseApiUrl(archive({ [API_URL_VAR]: HOSTED, [ALLOW_PRIVATE_API_URL_VAR]: '1' }), {
        warn,
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not fire on a non-release build', () => {
      const warn = vi.fn();
      assertReleaseApiUrl(
        { [API_URL_VAR]: 'http://192.168.1.50:3001', [ALLOW_PRIVATE_API_URL_VAR]: '1' },
        { warn }
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not extend to plaintext http on a public host', () => {
      expect(() =>
        assertReleaseApiUrl(
          archive({ [API_URL_VAR]: 'http://us.2breeze.app', [ALLOW_PRIVATE_API_URL_VAR]: '1' })
        )
      ).toThrow(/plaintext http/);
    });

    // Same convention as BREEZE_MOBILE_ALLOW_NO_SENTRY: a near-miss spelling
    // fails safe, leaving the guard on.
    it('takes the literal 1 only', () => {
      for (const value of ['true', 'yes', 'on', ' 1 ']) {
        expect(() =>
          assertReleaseApiUrl(
            archive({ [API_URL_VAR]: 'http://192.168.1.50:3001', [ALLOW_PRIVATE_API_URL_VAR]: value })
          )
        ).toThrow(/private-network address/);
      }
    });

    it('does not also disable the loopback or placeholder checks', () => {
      const allowPrivate = { [ALLOW_PRIVATE_API_URL_VAR]: '1' };
      expect(() =>
        assertReleaseApiUrl(archive({ ...allowPrivate, [API_URL_VAR]: 'http://localhost:3001' }))
      ).toThrow(/refusing to build/);
      expect(() =>
        assertReleaseApiUrl(archive({ ...allowPrivate, [API_URL_VAR]: 'https://api.example.com' }))
      ).toThrow(/placeholder/);
      expect(() => assertReleaseApiUrl(archive(allowPrivate))).toThrow(/is not set/);
    });
  });

  // The regression that matters most: app.config.js is evaluated by EVERY Metro
  // bundle and every `expo prebuild`. A guard that could throw outside a release
  // build would brick the dev loop and CI, and would be reverted within the day.
  describe('never breaks a non-release build', () => {
    it('is silent with no API URL anywhere', () => {
      const warn = vi.fn();
      for (const env of [
        {},
        { CONFIGURATION: 'Debug' },
        { NODE_ENV: 'development' },
        { NODE_ENV: 'test', CI: 'true' },
        { EAS_BUILD_PROFILE: 'development' },
      ]) {
        expect(() => assertReleaseApiUrl(env, { warn })).not.toThrow();
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not reject localhost in dev — that is the whole point of dev', () => {
      expect(() =>
        assertReleaseApiUrl({ CONFIGURATION: 'Debug', [API_URL_VAR]: 'http://localhost:3001' })
      ).not.toThrow();
    });
  });

  // BREEZE_MOBILE_DEV=1 is the escape hatch for a Release-configuration build
  // that is not really shipping (a simulator archive, say). It must stay LOUD:
  // silently suppressing a guard on a genuine archive is the failure mode the
  // Sentry guard was reshaped to avoid, and it lives in apps/mobile/.env where
  // a stale line survives for months.
  describe('the BREEZE_MOBILE_DEV escape hatch', () => {
    it('suppresses the throw but says so, naming this check', () => {
      const warn = vi.fn();
      expect(() =>
        assertReleaseApiUrl(
          archive({ [API_URL_VAR]: 'http://localhost:3001', [FORCE_DEV_VAR]: '1' }),
          { warn }
        )
      ).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain(API_URL_VAR);
      expect(message).toContain('CONFIGURATION="Release"');
      expect(message).toContain('apps/mobile/.env');
    });

    it('stays silent when a good URL meant there was nothing to suppress', () => {
      const warn = vi.fn();
      assertReleaseApiUrl(archive({ [API_URL_VAR]: HOSTED, [FORCE_DEV_VAR]: '1' }), { warn });
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
