import { describe, it, expect } from 'vitest';
import { filesToBundle, looseFileToEntry } from './scriptBundle';

function file(name: string, content: string) {
  return { name, text: () => Promise.resolve(content) };
}

describe('looseFileToEntry', () => {
  it('infers language and osTypes from the extension and name from the filename', () => {
    expect(looseFileToEntry('Clear-Spooler.ps1', 'Restart-Service Spooler')).toEqual({
      name: 'Clear-Spooler',
      osTypes: ['windows'],
      language: 'powershell',
      content: 'Restart-Service Spooler'
    });
    expect(looseFileToEntry('cleanup.sh', 'echo hi')).toMatchObject({
      language: 'bash',
      osTypes: ['linux', 'macos']
    });
    expect(looseFileToEntry('report.py', 'print(1)')).toMatchObject({ language: 'python' });
    expect(looseFileToEntry('legacy.bat', '@echo off')).toMatchObject({
      language: 'cmd',
      osTypes: ['windows']
    });
  });

  it('strips folder paths from folder-picker file names', () => {
    expect(looseFileToEntry('toolkit/windows/Clear-Spooler.ps1', 'x')).toMatchObject({
      name: 'Clear-Spooler'
    });
  });

  it('rejects unsupported extensions and empty content', () => {
    expect(looseFileToEntry('evil.exe', 'MZ...')).toBeNull();
    expect(looseFileToEntry('README', 'hello')).toBeNull();
    expect(looseFileToEntry('empty.ps1', '')).toBeNull();
  });
});

describe('filesToBundle', () => {
  it('parses a single .json file as an existing bundle', async () => {
    const bundle = { bundleVersion: 1, scripts: [{ name: 'a' }] };
    const result = await filesToBundle([file('bundle.json', JSON.stringify(bundle))]);
    expect(result.errors).toHaveLength(0);
    expect(result.bundle?.bundleVersion).toBe(1);
    expect(result.bundle?.scripts).toHaveLength(1);
  });

  it('rejects malformed JSON and non-bundle JSON', async () => {
    expect((await filesToBundle([file('bundle.json', '{oops')])).bundle).toBeNull();
    expect((await filesToBundle([file('bundle.json', '{"foo":1}')])).bundle).toBeNull();
  });

  it('converts loose script files into a v1 bundle, reporting unsupported ones', async () => {
    const result = await filesToBundle([
      file('a.ps1', 'Write-Host a'),
      file('b.sh', 'echo b'),
      file('notes.txt', 'not a script')
    ]);
    expect(result.bundle?.bundleVersion).toBe(1);
    expect(result.bundle?.scripts.map((s) => s.name)).toEqual(['a', 'b']);
    expect(result.errors).toEqual(['notes.txt']);
  });

  it('skips stray .json files inside a multi-file (folder) selection instead of aborting', async () => {
    const result = await filesToBundle([file('package.json', '{}'), file('a.ps1', 'Write-Host a')]);
    expect(result.bundle?.scripts.map((s) => s.name)).toEqual(['a']);
    expect(result.errors).toEqual(['package.json']);
  });

  it('returns null bundle when nothing is convertible', async () => {
    const result = await filesToBundle([file('x.txt', 'nope')]);
    expect(result.bundle).toBeNull();
    expect(result.errors).toEqual(['x.txt']);
    expect(await filesToBundle([])).toEqual({ bundle: null, errors: [] });
  });
});
