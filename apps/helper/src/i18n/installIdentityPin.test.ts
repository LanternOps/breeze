import { describe, expect, it } from 'vitest';

// #11718: only the in-app strings are "Breeze Assist". The install identity
// stays "Breeze Helper" because the agent locates and uninstalls the helper by
// it. Renaming any of these is the follow-up migration (agent + MSI together),
// never an incidental edit.
const files = import.meta.glob(
  [
    '../../src-tauri/tauri.conf.json',
    '../../../../agent/internal/helper/install_windows.go',
    '../../../../agent/internal/sessionbroker/broker.go',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const read = (suffix: string): string => {
  const hit = Object.entries(files).find(([k]) => k.endsWith(suffix));
  expect(hit, suffix).toBeDefined();
  return hit![1];
};

describe('helper install identity stays "Breeze Helper"', () => {
  it('tauri productName is unchanged', () => {
    expect(JSON.parse(read('tauri.conf.json')).productName).toBe('Breeze Helper');
  });

  it('agent uninstall/version match string is unchanged', () => {
    expect(read('install_windows.go')).toContain('const helperDisplayName = "Breeze Helper"');
  });

  it('agent install-dir candidates are unchanged', () => {
    const broker = read('broker.go');
    expect(broker).toContain('"Breeze Helper", "breeze-helper.exe"');
    expect(broker).toContain('/Applications/Breeze Helper.app/Contents/MacOS/breeze-helper');
  });
});
