import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyDiagnosticPath, diagnosticPathFormError, diagnosticPathKey, diagnosticPathWithin } from './classification';

type Fixture = { cases: Array<{ path: string; restricted: boolean; hardDenied: boolean; classes: string[] }> };

const fixture: Fixture = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../../../agent/internal/remote/tools/testdata/diagnostic_path_classes.json'),
    'utf8',
  ),
);

describe('classifyDiagnosticPath (shared with the agent)', () => {
  it('reads a non-trivial fixture', () => {
    expect(fixture.cases.length).toBeGreaterThan(20);
  });

  it.each(fixture.cases)('$path', (c) => {
    const got = classifyDiagnosticPath(c.path);
    expect({ hardDenied: got.hardDenied, classes: got.classes, restricted: got.restricted }).toEqual({
      hardDenied: c.hardDenied,
      classes: c.classes,
      restricted: c.restricted,
    });
  });
});

describe('diagnosticPathFormError', () => {
  it.each([
    'C:\\Users\\Alice\\AppData\\Local\\NVIDIA Corporation\\GeForceNOW',
    'C:\\Users\\Alice\\AppData\\Local\\Battle.net\\Logs',
    '/var/log/syslog',
  ])('accepts %s', (p) => {
    expect(diagnosticPathFormError(p)).toBeNull();
  });

  it.each([
    'relative\\path',
    'C:relative',
    'C:\\a\\..\\b',
    'C:\\a\\.\\b',
    '\\\\server\\share\\x',
    '\\\\?\\C:\\x',
    '\\\\.\\PhysicalDrive0',
    'C:\\x\\file.txt::$DATA',
    'C:\\x\\dir.\\f',
    'C:\\x\\dir \\f',
    '/a/b\u0000c',
    '/a/b\nc',
    '',
  ])('rejects %j', (p) => {
    expect(diagnosticPathFormError(p)).not.toBeNull();
  });
});

describe('diagnosticPathWithin', () => {
  const root = diagnosticPathKey('C:\\Users\\Alice\\AppData\\Local\\Battle.net', true);
  it('covers the root and descendants, not prefix siblings', () => {
    expect(diagnosticPathWithin(root, diagnosticPathKey('c:/users/alice/appdata/local/battle.net/Logs/x.log', true))).toEqual({ within: true, directChild: false });
    expect(diagnosticPathWithin(root, diagnosticPathKey('C:\\Users\\Alice\\AppData\\Local\\Battle.net\\Logs', true))).toEqual({ within: true, directChild: true });
    expect(diagnosticPathWithin(root, diagnosticPathKey('C:\\Users\\Alice\\AppData\\Local\\Battle.net2\\x', true)).within).toBe(false);
  });
});
