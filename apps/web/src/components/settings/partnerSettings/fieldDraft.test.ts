import { describe, expect, it } from 'vitest';
import { isFieldDraftDirty } from './fieldDraft';
import type { PartnersMeState } from './usePartnersMeUnit';

const base = {
  dateFormat: 'MM/DD/YYYY',
  defaults: { defaultEnrollmentDeviceCount: 10, agentVersionPins: { agent: '1.0.0' } },
  eventLogs: { enabled: true, elasticsearchUrl: 'https://logs.example.test' },
  remoteAccess: { providers: [], defaultProviderId: '' },
} as unknown as PartnersMeState;

describe('isFieldDraftDirty', () => {
  it('compares only the field’s own catalog paths', () => {
    const draft = { ...base, defaults: { ...base.defaults, defaultEnrollmentDeviceCount: 20 } } as PartnersMeState;
    expect(isFieldDraftDirty('defaults.defaultEnrollmentDeviceCount', draft, base)).toBe(true);
    expect(isFieldDraftDirty('defaults.agentVersionPins.agent', draft, base)).toBe(false);
  });

  it('a group entry is dirty when any of its paths changed', () => {
    const draft = { ...base, eventLogs: { ...base.eventLogs, indexPrefix: 'breeze' } } as PartnersMeState;
    expect(isFieldDraftDirty('eventLogs', draft, base)).toBe(true);
  });

  it('maps remoteAccessProviders onto the remoteAccess form branch', () => {
    const draft = { ...base, remoteAccess: { ...base.remoteAccess, defaultProviderId: 'p1' } } as unknown as PartnersMeState;
    expect(isFieldDraftDirty('remoteAccessProviders.defaultProviderId', draft, base)).toBe(true);
    expect(isFieldDraftDirty('remoteAccessProviders.providers', draft, base)).toBe(false);
  });

  it('regional fields live at the top of the form state', () => {
    expect(isFieldDraftDirty('regional.dateFormat', { ...base, dateFormat: 'YYYY-MM-DD' } as PartnersMeState, base)).toBe(true);
  });

  it('unknown ids and a missing baseline are clean', () => {
    expect(isFieldDraftDirty('nope', base, base)).toBe(false);
    expect(isFieldDraftDirty('regional.dateFormat', base, null)).toBe(false);
  });
});
