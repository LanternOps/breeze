// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The needles are built from parts so this file does not match its own scan.
const TAURI_SCOPE = '@tauri-apps' + '/';
const DEEP_LINK_PARSER = 'parse' + 'DeepLink';

const srcDir = fileURLToPath(new URL('..', import.meta.url));
const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
  .map(name => join(srcDir, name))
  .filter(path => statSync(path).isFile());

const filesContaining = (needle: string) =>
  files.filter(path => readFileSync(path, 'utf8').includes(needle)).map(path => relative(srcDir, path));

describe('remote-desktop-ui package boundary', () => {
  it('scans the whole source tree, subfolders included', () => {
    const scanned = files.map(path => relative(srcDir, path));
    expect(scanned).toContain('index.ts');
    expect(scanned).toContain(join('transports', 'webrtc.ts'));
  });

  it('has no file that references the Tauri runtime', () => {
    expect(filesContaining(TAURI_SCOPE)).toEqual([]);
  });

  it('has no file that references the deep link parser', () => {
    expect(filesContaining(DEEP_LINK_PARSER)).toEqual([]);
  });
});
