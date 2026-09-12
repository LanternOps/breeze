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

  // Every class fires on representative content. A regex that silently stops
  // matching (a broken `\b`, a typo) would otherwise drop a hard-denied class
  // from the lane's enforcement set with every other test still green.
  it.each([
    ['registry', 'Set-ItemProperty -Path HKLM:\\SOFTWARE\\X -Name Y -Value 1'],
    ['services', 'systemctl restart nginx'],
    ['processes', 'taskkill /IM notepad.exe /F'],
    ['files_system', 'Copy-Item C:\\Windows\\System32\\drivers\\etc\\hosts .'],
    ['files_system', 'sed -i s/a/b/ /etc/hosts'],
    ['files_user', 'rm -rf /home/alice/.cache'],
    ['temp_files', 'Remove-Item $env:TEMP\\*.tmp'],
    ['network_egress', 'Invoke-WebRequest https://example.com/x.zip -OutFile x.zip'],
    ['firewall', 'netsh advfirewall set allprofiles state off'],
    ['credentials', 'cat /etc/shadow'],
    ['users_groups', 'net user backdoor P@ss /add'],
    ['packages', 'winget install --id Mozilla.Firefox'],
    ['scheduled_tasks', 'schtasks /Create /TN x /TR cmd.exe'],
    ['disk', 'diskpart /s clean.txt'],
    ['boot', 'bcdedit /set {default} safeboot minimal'],
    ['security_tooling', 'Set-MpPreference -DisableRealtimeMonitoring $true'],
    ['dns_cache', 'ipconfig /flushdns'],
    ['printing', 'Get-Printer | Remove-Printer'],
    ['browser', 'Remove-Item "C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\User Data\\Default"'],
    ['shell_eval', 'Invoke-Expression (Get-Content x.ps1)'],
  ] as const)('classifies %s', (touchClass, content) => {
    expect(scanScriptContent(content, 'powershell').touchClasses).toContain(touchClass);
  });

  it('exposes exactly the 19 spec classes and a hard-denied subset of 7', () => {
    expect(TOUCH_CLASSES).toHaveLength(19);
    expect([...LANE_HARD_DENIED_CLASSES].sort()).toEqual(
      ['boot', 'credentials', 'disk', 'firewall', 'security_tooling', 'shell_eval', 'users_groups'],
    );
  });
});
