import { describe, it, expect } from 'vitest';
import { normalizeScriptCode } from './scriptCodeNormalize';

describe('normalizeScriptCode', () => {
  it('replaces curly double quotes so PowerShell strings parse', () => {
    const input = 'Write-Host \u201cDownload completed successfully ($([math]::Round($fileSize, 2)) MB)\u201d';
    expect(normalizeScriptCode(input)).toBe(
      'Write-Host "Download completed successfully ($([math]::Round($fileSize, 2)) MB)"'
    );
  });

  it('replaces curly single quotes and apostrophes', () => {
    expect(normalizeScriptCode('echo \u2018hi\u2019 don\u2019t')).toBe("echo 'hi' don't");
  });

  it('replaces en/em dashes and minus sign with ASCII hyphen', () => {
    expect(normalizeScriptCode('a \u2013 b \u2014 c \u2212 d \u2010 e')).toBe('a - b - c - d - e');
  });

  it('replaces ellipsis and non-breaking spaces', () => {
    expect(normalizeScriptCode('Waiting\u2026 done\u00a0now\u202fok')).toBe('Waiting... done now ok');
  });

  it('strips zero-width characters and BOMs', () => {
    expect(normalizeScriptCode('a\u200bb\u200cc\u200dd\ufeffe')).toBe('abcde');
  });

  it('leaves plain ASCII code untouched', () => {
    const script = 'try {\n  Invoke-WebRequest -Uri $url -OutFile $tempPath\n} catch {\n  throw "failed: $_"\n}';
    expect(normalizeScriptCode(script)).toBe(script);
  });

  it('leaves legitimate non-ASCII content (accents, CJK) untouched', () => {
    expect(normalizeScriptCode('echo "r\u00e9sum\u00e9 \u65e5\u672c\u8a9e"')).toBe('echo "r\u00e9sum\u00e9 \u65e5\u672c\u8a9e"');
  });
});
