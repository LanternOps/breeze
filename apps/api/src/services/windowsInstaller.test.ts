import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getWindowsInstaller } from './windowsInstaller';

describe('Windows installer artifact', () => {
  it('binds the descriptor to exact UTF-8 bytes with LF and no BOM', () => {
    const installer = getWindowsInstaller('https://rmm.example.com/path');
    if (!installer) throw new Error('Expected a Windows installer');
    expect(installer.integrity.url).toBe('https://rmm.example.com/path/api/v1/agents/install.ps1');
    expect(installer.integrity.sha256).toBe(createHash('sha256').update(installer.body).digest('hex'));
    const source = new TextDecoder('utf-8', { fatal: true }).decode(installer.body);
    expect(source).toMatch(/^function Install-BreezeAgent/);
    expect(source).not.toContain('\r');
    expect(source.endsWith('\n')).toBe(true);
    expect(getWindowsInstaller('https://rmm.example.com/path')).toEqual(installer);
    expect(getWindowsInstaller('https://other.example.com')?.integrity.sha256).not.toBe(installer.integrity.sha256);
  });

  it.each(['http://rmm.example.com', 'https://user:password@rmm.example.com', 'invalid'])('refuses unsafe server URL %s', (url) => {
    expect(getWindowsInstaller(url)).toBeNull();
  });
});
