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

  // The check mark -- not a curly quote -- is what actually broke every
  // reported script. U+2713 is E2 9C 93; PowerShell 5.1 reading a BOM-less
  // .ps1 as CP1252 turns the trailing 0x93 into U+201C, which it honours as a
  // closing double quote, so the string ends mid-line.
  it('transliterates the check mark that terminated PowerShell strings early', () => {
    const input = 'Write-Host "\u2713 Download completed successfully ($fileSizeRounded MB)" -ForegroundColor Green';
    expect(normalizeScriptCode(input)).toBe(
      'Write-Host "[OK] Download completed successfully ($fileSizeRounded MB)" -ForegroundColor Green'
    );
  });

  it('transliterates the full status-glyph set the model emits', () => {
    expect(normalizeScriptCode('\u2713 \u2714 \u2705 \u2611')).toBe('[OK] [OK] [OK] [OK]');
    expect(normalizeScriptCode('\u2717 \u2718 \u2716 \u274c \u2612')).toBe('[X] [X] [X] [X] [X]');
    expect(normalizeScriptCode('\u26a0 \u26d4 \u2757')).toBe('[!] [!] [!]');
    expect(normalizeScriptCode('a \u2192 b \u2190 c')).toBe('a -> b <- c');
    expect(normalizeScriptCode('\u2022 item')).toBe('* item');
  });

  it('strips emoji and decorative glyphs, including the variation selector', () => {
    expect(normalizeScriptCode('Write-Host "\u{1f680}Deploying\u2728"')).toBe('Write-Host "Deploying"');
    // Warning sign + VS16 is the common emoji-presentation spelling.
    expect(normalizeScriptCode('\u26a0\ufe0f check')).toBe('[!] check');
  });

  it('strips the word joiner and soft hyphen alongside zero-widths', () => {
    // U+2060 appeared in a saved production script next to a narrow NBSP.
    expect(normalizeScriptCode('Get-\u2060Service\u00ad Name\u202fx')).toBe('Get-Service Name x');
  });

  it('leaves arrows and glyphs out of otherwise ASCII code untouched', () => {
    const script = 'if ($x -eq 1) { Write-Host "[OK] done" } else { Write-Host "[X] failed" }';
    expect(normalizeScriptCode(script)).toBe(script);
  });
});
