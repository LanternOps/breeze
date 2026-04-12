import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import FileActivityPanel, { type FileActivity } from './FileActivityPanel';

function base(overrides: Partial<FileActivity>): FileActivity {
  return {
    id: 'a1',
    timestamp: new Date('2026-04-11T12:00:00Z').toISOString(),
    action: 'copy',
    paths: ['/tmp/foo'],
    result: 'success',
    ...overrides,
  };
}

function renderPanel(activities: FileActivity[]) {
  return render(
    <FileActivityPanel
      deviceId="dev-1"
      open
      onToggle={() => {}}
      activities={activities}
    />,
  );
}

describe('FileActivityPanel badges', () => {
  it('renders a green Success badge for result=success', () => {
    renderPanel([base({ result: 'success' })]);
    expect(screen.getByText('Success')).toBeInTheDocument();
  });

  it('renders a red Failed badge for result=failure', () => {
    renderPanel([base({ result: 'failure', error: '2 failed' })]);
    const badge = screen.getByText('Failed');
    expect(badge).toBeInTheDocument();
    expect(screen.getByText('2 failed')).toBeInTheDocument();
  });

  it('renders an amber Unverified badge for result=unverified', () => {
    renderPanel([
      base({
        result: 'unverified',
        error: '1 unverified — refresh to verify',
      }),
    ]);
    const badge = screen.getByText('Unverified');
    expect(badge).toBeInTheDocument();
    expect(badge.className).toMatch(/amber/);
    expect(screen.getByText('1 unverified — refresh to verify')).toBeInTheDocument();
  });
});
