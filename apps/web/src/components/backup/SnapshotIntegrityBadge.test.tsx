import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import SnapshotIntegrityBadge from './SnapshotIntegrityBadge';

describe('SnapshotIntegrityBadge', () => {
  it.each([
    ['attested', 'Verified'],
    ['producer_only', 'Verified'],
    ['pending', 'Checking'],
    ['unattested', 'Not verified'],
    ['unattested_legacy', 'Not verified'],
    ['attestation_failed', 'Failed integrity check'],
  ])('labels %s as %s', (status, label) => {
    render(<SnapshotIntegrityBadge status={status} />);
    const badge = screen.getByTestId('snapshot-integrity-badge');
    expect(badge.textContent).toBe(label);
    expect(badge.getAttribute('data-status')).toBe(status);
  });

  it.each([undefined, null, 'something_new'])('renders nothing for %s (an older API, or a status this client does not know)', (status) => {
    const { container } = render(<SnapshotIntegrityBadge status={status as string | null | undefined} />);
    expect(container.firstChild).toBeNull();
  });
});
