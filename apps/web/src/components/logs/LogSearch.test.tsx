import { describe, expect, it } from 'vitest';

import { escapeLogCsv } from './LogSearch';

describe('escapeLogCsv', () => {
  it('neutralizes spreadsheet formula prefixes before CSV quoting', () => {
    for (const value of ['=cmd', '+cmd', '-cmd', '@cmd', '\tcmd', '\rcmd', '\ncmd']) {
      expect(escapeLogCsv(value)).toBe(`"'${value.replaceAll('"', '""')}"`);
    }
  });

  it('escapes quotes while preserving ordinary values', () => {
    expect(escapeLogCsv('plain "value"')).toBe('"plain ""value"""');
  });
});
