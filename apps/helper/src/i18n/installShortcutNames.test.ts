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

  it('header names the tauri-cli version the lockfile resolves', () => {
    const header = read('main.wxs').split('\n')[0];
    expect(header).toMatch(/Tauri(?: CLI)? 2\.12\.4 msi\/main\.wxs/);
    expect(header).not.toContain('2.12.5');
  });
});

// Upgrading from an MSI that shipped the "Breeze Helper" shortcut names leaves
// them behind: the old product's nested removal skips RemoveShortcuts (stock
// condition `Installed AND NOT UPGRADINGPRODUCTCODE`), so the new package must
// delete the legacy names itself, on install and again on uninstall.
describe('helper MSI legacy "Breeze Helper" shortcut cleanup', () => {
  const COMPONENT = 'CMP_LegacyHelperShortcuts';

  const legacyComponent = (): string => {
    const wxs = read('main.wxs');
    const m = wxs.match(new RegExp(`<Component\\b[^>]*\\bId="${COMPONENT}"[\\s\\S]*?</Component>`));
    expect(m, `${COMPONENT} component missing`).not.toBeNull();
    return m![0];
  };

  const attrs = (el: string): Record<string, string> =>
    Object.fromEntries([...el.matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));

  const rows = (tag: string): Record<string, string>[] =>
    [...legacyComponent().matchAll(new RegExp(`<${tag}\\b[^>]*/>`, 'g'))].map((m) => attrs(m[0]));

  it('removes exactly the three legacy shortcuts, by literal name, on install and uninstall', () => {
    const files = rows('RemoveFile')
      .map((r) => ({ dir: r.Directory, name: r.Name, on: r.On }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(files).toEqual([
      { dir: 'DesktopFolder', name: 'Breeze Helper.lnk', on: 'both' },
      { dir: 'LegacyApplicationProgramsFolder', name: 'Breeze Helper.lnk', on: 'both' },
      { dir: 'INSTALLDIR', name: 'Uninstall Breeze Helper.lnk', on: 'both' },
    ].sort((a, b) => a.name.localeCompare(b.name)));
  });

  it('removes the legacy Start-menu folder, which sits under ProgramMenuFolder', () => {
    expect(rows('RemoveFolder')).toEqual([
      expect.objectContaining({ Directory: 'LegacyApplicationProgramsFolder', On: 'both' }),
    ]);
    expect(read('main.wxs')).toMatch(
      /<Directory Id="ProgramMenuFolder">\s*<Directory Id="ApplicationProgramsFolder" Name="Breeze Assist"\/>\s*<Directory Id="LegacyApplicationProgramsFolder" Name="Breeze Helper"\/>\s*<\/Directory>/,
    );
  });

  it('never installs anything into the legacy names (removal only)', () => {
    const c = legacyComponent();
    expect(c).not.toMatch(/<(Shortcut|File|CreateFolder)\b/);
    expect(read('main.wxs')).not.toMatch(/<DirectoryRef Id="LegacyApplicationProgramsFolder"/);
  });

  it('uses fresh Ids and its own keypath value, not the stock components\'', () => {
    const wxs = read('main.wxs');
    const ids = [...rows('RemoveFile'), ...rows('RemoveFolder')].map((r) => r.Id);
    expect(ids).toHaveLength(4);
    for (const id of ids) {
      expect([...wxs.matchAll(new RegExp(`\\bId="${id}"`, 'g'))], id).toHaveLength(1);
      expect(['DesktopFolder', 'INSTALLDIR', 'ApplicationProgramsFolder']).not.toContain(id);
    }
    const keyPath = rows('RegistryValue').filter((r) => r.KeyPath === 'yes');
    expect(keyPath).toHaveLength(1);
    expect(keyPath[0].Name).toBe('Legacy Shortcut Cleanup');
    expect([...wxs.matchAll(/Name="Legacy Shortcut Cleanup"/g)]).toHaveLength(1);
  });

  it('is installed by the always-on shortcuts feature', () => {
    const feature = read('main.wxs').match(/<Feature Id="ShortcutsFeature"[\s\S]*?<\/Feature>/);
    expect(feature).not.toBeNull();
    expect(feature![0]).toContain(`<ComponentRef Id="${COMPONENT}" />`);
  });
});
