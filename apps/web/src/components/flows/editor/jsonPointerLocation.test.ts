import { describe, expect, it } from 'vitest';
import { locateJsonPointer } from './jsonPointerLocation';

describe('locateJsonPointer', () => {
  it('locates the root as the whole document', () => {
    expect(locateJsonPointer('{"a":1}', '')).toEqual({ line: 1, column: 1, endLine: 1, endColumn: 8 });
    expect(locateJsonPointer('  [1, 2]  ', '')).toEqual({ line: 1, column: 3, endLine: 1, endColumn: 9 });
  });

  it('locates a top-level value on a single line', () => {
    //                        123456789012345
    expect(locateJsonPointer('{"a": 12, "b": "x"}', '/a')).toEqual({ line: 1, column: 7, endLine: 1, endColumn: 9 });
    expect(locateJsonPointer('{"a": 12, "b": "x"}', '/b')).toEqual({ line: 1, column: 16, endLine: 1, endColumn: 19 });
  });

  it('locates nested object and array paths across lines', () => {
    const text = [
      '{',
      '  "trigger": { "event": "device.offline" },',
      '  "steps": [',
      '    {',
      '      "id": "run",',
      '      "input": {',
      '        "scriptId": "abc"',
      '      }',
      '    },',
      '    { "id": "two", "input": { "list": [true, null, -1.5e3] } }',
      '  ]',
      '}',
    ].join('\n');
    expect(locateJsonPointer(text, '/trigger/event')).toEqual({ line: 2, column: 25, endLine: 2, endColumn: 41 });
    expect(locateJsonPointer(text, '/steps/0/input/scriptId')).toEqual({ line: 7, column: 21, endLine: 7, endColumn: 26 });
    // A multi-line value spans start to end lines.
    expect(locateJsonPointer(text, '/steps/0/input')).toEqual({ line: 6, column: 16, endLine: 8, endColumn: 8 });
    expect(locateJsonPointer(text, '/steps/1/input/list/0')).toEqual({ line: 10, column: 40, endLine: 10, endColumn: 44 });
    expect(locateJsonPointer(text, '/steps/1/input/list/1')).toEqual({ line: 10, column: 46, endLine: 10, endColumn: 50 });
    expect(locateJsonPointer(text, '/steps/1/input/list/2')).toEqual({ line: 10, column: 52, endLine: 10, endColumn: 58 });
  });

  it('treats CRLF as a single line break', () => {
    const text = '{\r\n  "a": [\r\n    1\r\n  ]\r\n}';
    expect(locateJsonPointer(text, '/a/0')).toEqual({ line: 3, column: 5, endLine: 3, endColumn: 6 });
  });

  it('unescapes ~1 and ~0 in pointer segments', () => {
    const text = '{"a/b": 1, "m~n": 2, "": 3}';
    expect(locateJsonPointer(text, '/a~1b')).toEqual({ line: 1, column: 9, endLine: 1, endColumn: 10 });
    expect(locateJsonPointer(text, '/m~0n')).toEqual({ line: 1, column: 19, endLine: 1, endColumn: 20 });
    expect(locateJsonPointer(text, '/')).toEqual({ line: 1, column: 26, endLine: 1, endColumn: 27 });
  });

  it('matches keys written with JSON escapes, and strings containing escaped quotes', () => {
    const text = '{"k\\u0065y": "a \\"q\\" \\\\", "z": 0}';
    expect(locateJsonPointer(text, '/key')).toEqual({ line: 1, column: 14, endLine: 1, endColumn: 26 });
    expect(locateJsonPointer(text, '/z')).toEqual({ line: 1, column: 33, endLine: 1, endColumn: 34 });
  });

  it('uses the last duplicate key, like JSON.parse', () => {
    expect(locateJsonPointer('{"a": 1, "a": 2}', '/a')).toEqual({ line: 1, column: 15, endLine: 1, endColumn: 16 });
  });

  it('returns null for a missing path', () => {
    const text = '{"steps": [{"id": "x"}], "n": 1}';
    expect(locateJsonPointer(text, '/nope')).toBeNull();
    expect(locateJsonPointer(text, '/steps/1')).toBeNull();
    expect(locateJsonPointer(text, '/steps/-')).toBeNull();
    expect(locateJsonPointer(text, '/steps/01')).toBeNull();
    expect(locateJsonPointer(text, '/steps/id')).toBeNull();
    expect(locateJsonPointer(text, '/n/0')).toBeNull();
    expect(locateJsonPointer(text, 'steps')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    for (const bad of ['', '   ', '{', '{"a":1,}', '[1,]', '{"a" 1}', '{a:1}', '01', '"\n"', '{"a":1} x', 'tru', "{'a':1}", '1.', '-', '"\\x"']) {
      expect(locateJsonPointer(bad, ''), JSON.stringify(bad)).toBeNull();
    }
  });
});
