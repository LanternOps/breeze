import { describe, expect, it } from 'vitest';
import {
  parseDeviceDetailTabContextV1,
  parseExtensionPageContextV1,
  parseOrganizationSettingsSectionContextV1,
} from './contracts';
import {
  EXTENSION_HOST_EVENT_NAME,
  dispatchExtensionHostEvent,
  parseExtensionHostEventV1,
} from './events';

describe('parseDeviceDetailTabContextV1', () => {
  const valid = {
    contractVersion: 1 as const,
    deviceId: 'device-1',
    organizationId: 'org-1',
    siteId: 'site-1',
  };

  it('accepts the minimum valid device context', () => {
    expect(parseDeviceDetailTabContextV1(valid)).toEqual(valid);
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => parseDeviceDetailTabContextV1({ ...valid, extra: 'nope' })).toThrow();
  });

  it('rejects missing required fields', () => {
    const { deviceId, ...missing } = valid;
    expect(() => parseDeviceDetailTabContextV1(missing)).toThrow();
  });

  it('rejects wrong contractVersion', () => {
    expect(() => parseDeviceDetailTabContextV1({ ...valid, contractVersion: 2 })).toThrow();
  });
});

describe('parseExtensionPageContextV1', () => {
  const valid = {
    contractVersion: 1 as const,
    extensionName: 'worktrack',
    path: '/extensions/worktrack/dashboard',
    organizationId: 'org-1',
  };

  it('accepts the happy path', () => {
    expect(parseExtensionPageContextV1(valid)).toEqual(valid);
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => parseExtensionPageContextV1({ ...valid, extra: 'nope' })).toThrow();
  });
});

describe('parseOrganizationSettingsSectionContextV1', () => {
  const valid = {
    contractVersion: 1 as const,
    organizationId: 'org-1',
  };

  it('accepts the happy path', () => {
    expect(parseOrganizationSettingsSectionContextV1(valid)).toEqual(valid);
  });

  it('rejects unknown keys (strict)', () => {
    expect(() => parseOrganizationSettingsSectionContextV1({ ...valid, extra: 'nope' })).toThrow();
  });
});

describe('parseExtensionHostEventV1', () => {
  const extensionName = 'worktrack';

  it('accepts a namespaced navigate event', () => {
    const event = { version: 1 as const, type: 'navigate' as const, path: '/extensions/worktrack/jobs/42' };
    expect(parseExtensionHostEventV1(event, { extensionName })).toEqual(event);
  });

  it('accepts a bare namespace root navigate event', () => {
    const event = { version: 1 as const, type: 'navigate' as const, path: '/extensions/worktrack' };
    expect(parseExtensionHostEventV1(event, { extensionName })).toEqual(event);
  });

  it('rejects an out-of-namespace navigate event', () => {
    const event = { version: 1, type: 'navigate', path: '/extensions/other-extension/jobs' };
    expect(() => parseExtensionHostEventV1(event, { extensionName })).toThrow(/namespace/);
  });

  it('rejects a navigate path outside /extensions entirely', () => {
    const event = { version: 1, type: 'navigate', path: '/devices/123' };
    expect(() => parseExtensionHostEventV1(event, { extensionName })).toThrow(/namespace/);
  });

  it('rejects an extension name that is a prefix but not an exact segment match', () => {
    const event = { version: 1, type: 'navigate', path: '/extensions/worktrack-evil/jobs' };
    expect(() => parseExtensionHostEventV1(event, { extensionName })).toThrow(/namespace/);
  });

  it.each([
    ['absolute http URL', 'http://evil.example.com/extensions/worktrack'],
    ['absolute https URL', 'https://evil.example.com/extensions/worktrack'],
    ['protocol-relative URL', '//evil.example.com/extensions/worktrack'],
    ['backslash', '/extensions\\worktrack/jobs'],
    ['mixed backslash traversal', '\\extensions\\worktrack'],
    ['literal traversal', '/extensions/worktrack/../../etc/passwd'],
    ['encoded traversal lowercase', '/extensions/worktrack/%2e%2e/%2e%2e/etc/passwd'],
    ['encoded traversal uppercase', '/extensions/worktrack/%2E%2E/%2E%2E/etc/passwd'],
    ['encoded traversal mixed case', '/extensions/worktrack/%2e%2E/etc/passwd'],
    ['encoded slash', '/extensions/worktrack%2f..%2f..%2fetc%2fpasswd'],
    ['double-encoded traversal', '/extensions/worktrack/%252e%252e/%252e%252e/etc/passwd'],
    ['encoded backslash', '/extensions/worktrack/%5cetc%5cpasswd'],
    ['encoded backslash uppercase', '/extensions/worktrack/%5Cetc%5Cpasswd'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,<script>alert(1)</script>'],
  ])('rejects hostile navigate path: %s', (_label, path) => {
    const event = { version: 1, type: 'navigate', path };
    expect(() => parseExtensionHostEventV1(event, { extensionName })).toThrow(/namespace/);
  });

  it('accepts a toast event', () => {
    const event = { version: 1 as const, type: 'toast' as const, tone: 'success' as const, message: 'Saved' };
    expect(parseExtensionHostEventV1(event, { extensionName })).toEqual(event);
  });

  it('rejects a toast event with an invalid tone', () => {
    const event = { version: 1, type: 'toast', tone: 'wat', message: 'Saved' };
    expect(() => parseExtensionHostEventV1(event, { extensionName })).toThrow();
  });

  it('accepts a refresh-registry event', () => {
    const event = { version: 1 as const, type: 'refresh-registry' as const };
    expect(parseExtensionHostEventV1(event, { extensionName })).toEqual(event);
  });

  it('rejects an unknown event type', () => {
    const event = { version: 1, type: 'nonsense' };
    expect(() => parseExtensionHostEventV1(event, { extensionName })).toThrow();
  });

  it('rejects unknown keys (strict) on navigate', () => {
    const event = { version: 1, type: 'navigate', path: '/extensions/worktrack', extra: 'nope' };
    expect(() => parseExtensionHostEventV1(event, { extensionName })).toThrow();
  });
});

describe('dispatchExtensionHostEvent', () => {
  it('dispatches a bubbling, composed CustomEvent named breeze-extension-event with the event in detail', () => {
    const target = new EventTarget();
    const received: unknown[] = [];
    target.addEventListener(EXTENSION_HOST_EVENT_NAME, (evt) => {
      received.push(evt);
    });

    const event = { version: 1 as const, type: 'refresh-registry' as const };
    dispatchExtensionHostEvent(target, event);

    expect(received).toHaveLength(1);
    const customEvent = received[0] as CustomEvent;
    expect(customEvent.type).toBe(EXTENSION_HOST_EVENT_NAME);
    expect(customEvent.bubbles).toBe(true);
    expect(customEvent.composed).toBe(true);
    expect(customEvent.detail).toEqual(event);
  });
});
