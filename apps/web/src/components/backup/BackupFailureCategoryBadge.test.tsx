import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BACKUP_FAILURE_CATEGORIES, type BackupFailureCategory } from '@breeze/shared';

import BackupFailureCategoryBadge from './BackupFailureCategoryBadge';

const EN_COPY: Record<BackupFailureCategory, { label: string; hint: string }> = {
  device_offline: {
    label: 'Device offline',
    hint: 'The device lost its connection to Breeze during the backup. Keep it powered on and online through the backup window.',
  },
  timeout: {
    label: 'Stalled or timed out',
    hint: "The backup stopped making progress or ran past its time limit. Very large backups can need more than one window. Check the device's load and the size of the backup selection.",
  },
  storage: {
    label: 'Storage problem',
    hint: 'Breeze could not write to the backup destination, or the upload authorization expired. Test the storage configuration and check its credentials and free space.',
  },
  agent: {
    label: 'Agent problem',
    hint: "The backup component on the device stopped unexpectedly. Update the agent and run the backup again. If it keeps happening, check the device's agent logs.",
  },
  configuration: {
    label: 'Configuration problem',
    hint: "There was nothing valid to back up, or the backup configuration changed while the job was starting. Review the device's backup profile.",
  },
  source_access: {
    label: 'Files could not be read',
    hint: 'Some files were locked, in use, or not readable by the agent. Check the files listed below and the VSS status.',
  },
  cancelled: {
    label: 'Cancelled',
    hint: 'Stopped by a user, or by Breeze, before it finished.',
  },
  unknown: {
    label: 'Other error',
    hint: 'Breeze does not recognise this error yet. The full message is shown below.',
  },
};

describe('BackupFailureCategoryBadge (#11027)', () => {
  it.each([...BACKUP_FAILURE_CATEGORIES])('renders label and hint for every category: %s', (category) => {
    render(<BackupFailureCategoryBadge category={category} />);

    const badge = screen.getByTestId('backup-failure-category');
    expect(badge.getAttribute('data-category')).toBe(category);
    expect(badge.textContent).toBe(EN_COPY[category].label);
    expect(badge.getAttribute('title')).toBe(EN_COPY[category].hint);
  });

  it('keeps the hint out of the visible text unless showHint is set', () => {
    render(<BackupFailureCategoryBadge category="storage" />);

    expect(screen.queryByText(EN_COPY.storage.hint)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows the hint and links the troubleshooting doc with showHint', () => {
    render(<BackupFailureCategoryBadge category="storage" showHint />);

    expect(screen.getByText(EN_COPY.storage.hint)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Troubleshooting guide' });
    expect(link.getAttribute('href')).toBe(
      'https://docs.breezermm.com/backup/troubleshooting/#reading-a-failed-backups-category',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it.each([null, undefined])('renders nothing for %s (nothing failed, or an older API)', (category) => {
    const { container } = render(<BackupFailureCategoryBadge category={category} showHint />);

    expect(container.firstChild).toBeNull();
  });
});
