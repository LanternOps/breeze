import { describe, expect, it } from 'vitest';
import { aiPathRefusal, isUserProfilePath, PATH_BLOCKED_MESSAGE, USER_PROFILE_BLOCKED_MESSAGE } from './aiPathRestriction';

// AI data policy (spec 2026-10-15): the tenant's device file read level adds a
// user-profile layer on top of the always-on floor. Without a level only the
// floor applies, so `safePath` (which never passes one) is unchanged.
describe('user profile roots by level', () => {
  const profilePaths = [
    'C:\\Users\\bob\\Documents\\x.docx',
    'D:\\Users\\bob\\Desktop',
    '\\Users\\bob',
    '/home/bob/notes.txt',
    '/Users/bob/Desktop',
    '/root/todo',
    'C:\\Users',
    '/home',
    'C:\\Documents and Settings\\bob',
    '/var/home/bob',
    'C:\\Users\\Public\\x',
  ];

  it.each(profilePaths)('%s is refused under no_user_profiles', (p) => {
    expect(aiPathRefusal(p, { level: 'no_user_profiles' })).toBe(USER_PROFILE_BLOCKED_MESSAGE);
  });

  it.each(profilePaths)('%s is refused under off', (p) => {
    expect(aiPathRefusal(p, { level: 'off' })).toBe(USER_PROFILE_BLOCKED_MESSAGE);
  });

  it.each(profilePaths)('%s is allowed under any_with_approval (floor only)', (p) => {
    expect(aiPathRefusal(p, { level: 'any_with_approval' })).toBeNull();
  });

  it('without a level only the floor applies (unchanged safePath behaviour)', () => {
    expect(aiPathRefusal('C:\\Users\\bob\\Documents')).toBeNull();
    expect(aiPathRefusal('C:\\Users\\bob\\AppData\\Local')).toBe(PATH_BLOCKED_MESSAGE);
  });

  it('the floor wins over the level', () => {
    expect(aiPathRefusal('/home/bob/.ssh/id_rsa', { level: 'any_with_approval' })).toBe(PATH_BLOCKED_MESSAGE);
    expect(aiPathRefusal('/home/bob/.ssh/id_rsa', { level: 'no_user_profiles' })).toBe(PATH_BLOCKED_MESSAGE);
  });

  it('non-profile paths pass under no_user_profiles', () => {
    expect(aiPathRefusal('C:\\ProgramData\\Vendor\\Logs', { level: 'no_user_profiles' })).toBeNull();
    expect(aiPathRefusal('/var/log/syslog', { level: 'no_user_profiles' })).toBeNull();
    // A folder that merely starts with a profile root's letters is not one.
    expect(aiPathRefusal('/homebrew/bin', { level: 'no_user_profiles' })).toBeNull();
    expect(aiPathRefusal('C:\\UsersData\\x', { level: 'no_user_profiles' })).toBeNull();
  });

  it('isUserProfilePath matches normalized forms at component boundaries', () => {
    expect(isUserProfilePath('c:/users')).toBe(true);
    expect(isUserProfilePath('c:/users/bob/desktop')).toBe(true);
    expect(isUserProfilePath('/root')).toBe(true);
    expect(isUserProfilePath('/rootfs')).toBe(false);
    expect(isUserProfilePath('c:/programdata')).toBe(false);
  });
});
