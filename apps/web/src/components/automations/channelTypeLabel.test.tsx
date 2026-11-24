// @vitest-environment jsdom
import { render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useChannelTypeLabel } from './channelTypeLabel';
import { MockDeviceTargetSelector } from '../flows/editor/formTestUtils';

vi.mock('../filters/DeviceTargetSelector', () => ({ DeviceTargetSelector: MockDeviceTargetSelector }));

import { ActionsSection } from '../flows/editor/ActionsSection';

describe('useChannelTypeLabel (#12497)', () => {
  it.each([
    ['email', 'Email'],
    ['slack', 'Slack'],
    ['teams', 'Microsoft Teams'],
    ['pagerduty', 'PagerDuty'],
    ['webhook', 'Webhook'],
    ['sms', 'SMS'],
    ['pushover', 'Pushover'],
  ])('names the %s channel type', (type, label) => {
    const { result } = renderHook(() => useChannelTypeLabel());
    expect(result.current(type)).toBe(label);
  });

  it('falls back to the raw type for one it does not know', () => {
    const { result } = renderHook(() => useChannelTypeLabel());
    expect(result.current('carrier_pigeon')).toBe('carrier_pigeon');
  });
});

describe('channel pickers use the label', () => {
  it('the flow editor notify action shows the named type, not the raw one', () => {
    render(
      <ActionsSection
        actions={[{ type: 'notify', channelId: 'c1', title: 't', message: 'm', severity: 'info' }]}
        onChange={vi.fn()}
        scripts={[]}
        channels={[{ id: 'c1', name: 'Ops', type: 'email' }]}
      />,
    );
    expect(screen.getByRole('option', { name: 'Ops (Email)' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Ops (email)' })).toBeNull();
  });
});
