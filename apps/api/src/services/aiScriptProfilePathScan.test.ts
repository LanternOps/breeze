import { describe, expect, it } from 'vitest';
import { findProfilePathInScript } from './aiScriptProfilePathScan';

describe('findProfilePathInScript', () => {
  it.each([
    'Get-Content "C:\\Users\\bob\\Documents\\notes.txt"',
    'cat /home/bob/.bash_history',
    'type D:\\Users\\alice\\Desktop\\x.txt',
    'ls /Users/alice/Documents',
    'Get-ChildItem C:\\Users -Recurse',
    'Get-ChildItem "C:\\Documents and Settings\\bob\\Desktop"',
    "Get-Content '\\Users\\bob\\Desktop\\a.txt'",
    'cat /var/home/bob/notes',
    'tail -n 50 /root/install.log',
    'Get-ChildItem $env:USERPROFILE\\Documents',
    'dir %USERPROFILE%\\Desktop',
    'ls $HOME/Documents',
    'cat ~/notes.txt',
    'cp /var/log/app.log /home/bob/',
  ])('finds a profile path in %s', (s) => expect(findProfilePathInScript(s)).not.toBeNull());

  it.each([
    'Get-Content C:\\ProgramData\\Vendor\\Logs\\app.log',
    'cat /var/log/syslog',
    'Get-Service | Where-Object Status -eq Stopped',
    'echo "no paths here"',
    'ls /homebrew/bin',
    'Get-Item C:\\UsersData\\x',
    'curl https://example.com/users/list',
    'echo $HOMEBREW_PREFIX',
  ])('passes %s', (s) => expect(findProfilePathInScript(s)).toBeNull());

  it('returns the offending spelling, not a normalized form', () => {
    expect(findProfilePathInScript('Get-Content "C:\\Users\\bob\\Documents\\notes.txt" | Out-Null')).toBe('C:\\Users\\bob\\Documents\\notes.txt');
  });
});
