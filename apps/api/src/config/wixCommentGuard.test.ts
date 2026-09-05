import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * WiX v4 refuses any XML comment that contains `--` (WIX0104), and the MSI is
 * only ever built by the release workflow — PR CI never compiles the .wxs.
 * v0.110.0's first tag build died on exactly this (a prose comment with
 * " -- " added in #4688), so the rule is asserted here, in the unit job.
 */
const INSTALLER_DIR = resolve(__dirname, '../../../../agent/installer');

function commentsWithDoubleDash(source: string): string[] {
  const offenders: string[] = [];
  const re = /<!--([\s\S]*?)-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const body = m[1];
    if (body.includes('--') || body.endsWith('-')) {
      const line = source.slice(0, m.index).split('\n').length;
      offenders.push(`line ${line}: ${body.trim().split('\n')[0].slice(0, 80)}`);
    }
  }
  return offenders;
}

describe('WiX installer sources', () => {
  const wxsFiles = readdirSync(INSTALLER_DIR).filter((f) => f.endsWith('.wxs'));

  it('has at least one .wxs to guard', () => {
    expect(wxsFiles.length).toBeGreaterThan(0);
  });

  it.each(wxsFiles)('%s has no XML comment containing "--" (WIX0104)', (file) => {
    const source = readFileSync(join(INSTALLER_DIR, file), 'utf8');
    expect(commentsWithDoubleDash(source)).toEqual([]);
  });

  it('the guard itself catches a double dash', () => {
    expect(commentsWithDoubleDash('<!-- a -- b -->')).toHaveLength(1);
    expect(commentsWithDoubleDash('<!-- a - b -->')).toHaveLength(0);
  });
});
