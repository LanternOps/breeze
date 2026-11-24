import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/lib/i18n';
import UnavailableFeaturePanel from './UnavailableFeaturePanel';

describe('UnavailableFeaturePanel (plan D17, W05b K3)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('OneDrive Helper on an MSP-managed policy offers Copy to one organization', () => {
    const onCopyToOrganization = vi.fn();
    render(
      <UnavailableFeaturePanel
        featureType="onedrive_helper"
        hasLink={false}
        readOnly
        removing={false}
        removeError={null}
        onRemove={vi.fn()}
        onCopyToOrganization={onCopyToOrganization}
      />,
    );

    expect(screen.getByTestId('config-policy-feature-unavailable')).toHaveTextContent('OneDrive Helper');
    fireEvent.click(screen.getByRole('button', { name: 'Copy to one organization' }));
    expect(onCopyToOrganization).toHaveBeenCalledTimes(1);
  });

  it('a leftover link keeps its removal control for an editor, and none for a read-only viewer', () => {
    const onRemove = vi.fn();
    const { rerender } = render(
      <UnavailableFeaturePanel
        featureType="onedrive_helper"
        hasLink
        readOnly={false}
        removing={false}
        removeError={null}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove configuration' }));
    expect(onRemove).toHaveBeenCalledTimes(1);

    rerender(
      <UnavailableFeaturePanel featureType="onedrive_helper" hasLink readOnly removing={false} removeError={null} onRemove={onRemove} />,
    );
    expect(screen.queryByRole('button', { name: 'Remove configuration' })).toBeNull();
    // No Copy handler: no Copy control.
    expect(screen.queryByRole('button', { name: 'Copy to one organization' })).toBeNull();
  });
});
