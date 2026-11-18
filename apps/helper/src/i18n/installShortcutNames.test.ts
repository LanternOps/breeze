import { describe, expect, it } from 'vitest';

// #11718: the Windows desktop shortcut and Start-menu entry say "Breeze Assist"
// while the install identity (productName, INSTALLDIR, DisplayName) stays
// "Breeze Helper" — the agent matches on it (see installIdentityPin.test.ts).
// Tauri derives every shortcut name from productName, so the MSI uses a
// template override that hardcodes the shortcut names only.
const files = import.meta.glob(
  ['../../src-tauri/tauri.conf.json', '../../src-tauri/wix/main.wxs'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const read = (suffix: string): string => {
  const hit = Object.entries(files).find(([k]) => k.endsWith(suffix));
  expect(hit, `${suffix} missing`).toBeDefined();
  return hit![1];
};

describe('helper MSI shortcut names', () => {
  it('tauri.conf points the WiX bundler at the template override', () => {
    const conf = JSON.parse(read('tauri.conf.json'));
    expect(conf.bundle.windows.wix.template).toBe('wix/main.wxs');
  });

  it('every shortcut and the Start folder are named "Breeze Assist"', () => {
    const wxs = read('main.wxs');
    const names = [...wxs.matchAll(/<Shortcut\b[^>]*?\bName="([^"]*)"/gs)].map((m) => m[1]);
    expect(names.sort()).toEqual(['Breeze Assist', 'Breeze Assist', 'Uninstall Breeze Assist']);
    expect(wxs).toContain('<Directory Id="ApplicationProgramsFolder" Name="Breeze Assist"/>');
  });

  it('install dir keeps the productName identity the agent matches on', () => {
    expect(read('main.wxs')).toContain('<Directory Id="INSTALLDIR" Name="{{product_name}}"/>');
  });
});
