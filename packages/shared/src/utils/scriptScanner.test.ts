import { describe, expect, it } from 'vitest';
import {
  LANE_HARD_DENIED_CLASSES, SCANNER_VERSION, TOUCH_CLASSES, scanScriptContent,
} from './scriptSecurityPatterns';

describe('scanScriptContent', () => {
  it('stamps the scanner version and returns an empty, sorted, unique class set for inert content', () => {
    const result = scanScriptContent('Write-Output "hello"', 'powershell');
    expect(result.scannerVersion).toBe(SCANNER_VERSION);
    expect(result.basicHits).toEqual([]);
    expect(result.strictHits).toEqual([]);
    expect(result.touchClasses).toEqual([]);
    expect(result.touchedNames).toEqual({ services: [], paths: [], registryKeys: [] });
  });

  it('classifies a service restart and extracts the service name', () => {
    const result = scanScriptContent('Restart-Service -Name Spooler -Force', 'powershell');
    expect(result.touchClasses).toContain('services');
    expect(result.touchedNames.services).toEqual(['Spooler']);
  });

  it('classifies a registry write and extracts the key', () => {
    const result = scanScriptContent(
      'reg add "HKLM\\SOFTWARE\\Breeze\\Agent" /v Mode /d fast /f', 'cmd');
    expect(result.touchClasses).toContain('registry');
    expect(result.touchedNames.registryKeys).toEqual(['HKLM\\SOFTWARE\\Breeze\\Agent']);
  });

  it('classifies an encoded PowerShell command as shell_eval, which is hard-denied for the lane', () => {
    const result = scanScriptContent('powershell -EncodedCommand SQBFAFgA', 'powershell');
    expect(result.touchClasses).toContain('shell_eval');
    expect(LANE_HARD_DENIED_CLASSES.has('shell_eval')).toBe(true);
  });

  it('reports a BASIC hit alongside its classes rather than short-circuiting', () => {
    const result = scanScriptContent('Format-Volume -DriveLetter D', 'powershell');
    expect(result.basicHits).toEqual(['PowerShell volume format']);
    expect(result.touchClasses).toContain('disk');
  });

  it('is insensitive to case, surrounding whitespace and CRLF line endings', () => {
    const crlf = scanScriptContent('  STOP-SERVICE -Name Spooler\r\nnet stop Spooler\r\n', 'powershell');
    const lf = scanScriptContent('stop-service -Name Spooler\nnet stop Spooler\n', 'powershell');
    expect(crlf.touchClasses).toEqual(lf.touchClasses);
    expect(crlf.touchClasses).toContain('services');
  });

  it('returns classes sorted and unique even when several patterns of one class match', () => {
    const result = scanScriptContent(
      'Stop-Service Spooler; Start-Service Spooler; Remove-Item C:\\Windows\\Temp\\x', 'powershell');
    expect(result.touchClasses).toEqual([...new Set(result.touchClasses)].sort());
  });

  it('exposes exactly the 19 spec classes and a hard-denied subset of 7', () => {
    expect(TOUCH_CLASSES).toHaveLength(19);
    expect([...LANE_HARD_DENIED_CLASSES].sort()).toEqual(
      ['boot', 'credentials', 'disk', 'firewall', 'security_tooling', 'shell_eval', 'users_groups'],
    );
  });
});
