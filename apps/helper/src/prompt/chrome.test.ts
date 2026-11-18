import { describe, expect, it } from 'vitest';

import common from '@prompt-catalog/catalog/common.json';
import { chromeString } from './chrome';

describe('chromeString', () => {
  it("chrome strings render in the prompt's locale", () => {
    expect(chromeString('chrome.working', 'de-DE')).toBe('Wird bearbeitet…');
    expect(chromeString('chrome.notificationsCount', 'de-DE', { count: 3 })).toBe('Benachrichtigungen (3)');
    expect(chromeString('identity.generic', 'de-DE')).toBe('Ihr IT-Support-Team');
    expect(chromeString('chrome.working', 'en')).toBe('Working…');
  });

  it('negotiates the tag first (de-AT, POSIX fr_CA.UTF-8) and falls back to en', () => {
    expect(chromeString('chrome.hide', 'de-AT')).toBe(common.messages['chrome.hide']['de-DE']);
    expect(chromeString('chrome.hide', 'fr_CA.UTF-8')).toBe(common.messages['chrome.hide']['fr-CA']);
    expect(chromeString('chrome.hide', 'zh-CN')).toBe('Hide');
    expect(chromeString('chrome.hide', '')).toBe('Hide');
    expect(chromeString('chrome.hide', null)).toBe('Hide');
  });

  it('substitutes {name} parameters in a single pass and leaves the rest literal', () => {
    // A value that looks like a placeholder is never re-read as one.
    expect(chromeString('native.windowTitle', 'en', { partner: '{partner} {count}' })).toBe('{partner} {count} · Message');
    // A missing parameter stays literal rather than throwing in a UI path.
    expect(chromeString('chrome.remainingAnnounce', 'en')).toBe('{seconds} seconds remaining');
    expect(chromeString('chrome.remainingAnnounce', 'en', { seconds: 30 })).toBe('30 seconds remaining');
  });
});
