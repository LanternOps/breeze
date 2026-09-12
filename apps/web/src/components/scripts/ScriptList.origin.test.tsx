import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@/lib/i18n';

import ScriptList, { type Script } from './ScriptList';

const aiScript: Script = {
  id: 'script-ai',
  name: 'AI Script',
  language: 'bash',
  category: 'maintenance',
  osTypes: ['linux'],
  createdAt: '2026-02-09T10:00:00.000Z',
  updatedAt: '2026-02-09T10:00:00.000Z',
  origin: 'ai_proposal',
  reviewedAtHead: true,
};

const humanScript: Script = {
  id: 'script-human',
  name: 'Human Script',
  language: 'bash',
  category: 'maintenance',
  osTypes: ['linux'],
  createdAt: '2026-02-09T10:00:00.000Z',
  updatedAt: '2026-02-09T10:00:00.000Z',
  origin: 'human',
};

describe('ScriptList origin column (Task 22)', () => {
  it('renders an Origin column header', () => {
    render(<ScriptList scripts={[aiScript, humanScript]} />);
    expect(screen.getByTestId('script-col-origin')).toBeInTheDocument();
  });

  it('shows the origin label per row', () => {
    render(<ScriptList scripts={[aiScript, humanScript]} />);
    expect(screen.getByTestId(`script-origin-${aiScript.id}`)).toHaveTextContent('AI proposal');
    expect(screen.getByTestId(`script-origin-${humanScript.id}`)).toHaveTextContent('Human');
  });

  it('filters by origin', () => {
    render(<ScriptList scripts={[aiScript, humanScript]} />);
    fireEvent.change(screen.getByTestId('script-origin-filter'), { target: { value: 'ai_proposal' } });
    expect(screen.getByTestId(`script-row-${aiScript.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`script-row-${humanScript.id}`)).not.toBeInTheDocument();
  });

  it('badges a reviewed AI script and an edited-since-review one differently', () => {
    render(<ScriptList scripts={[aiScript, { ...aiScript, id: 's3', reviewedAtHead: false }]} />);
    expect(screen.getByTestId(`script-badge-reviewed-${aiScript.id}`)).toBeInTheDocument();
    expect(screen.getByTestId('script-badge-edited-since-review-s3')).toBeInTheDocument();
  });

  it('keeps the empty-state row spanning every column', () => {
    render(<ScriptList scripts={[]} />);
    expect(screen.getByTestId('script-empty-row').querySelector('td')).toHaveAttribute('colspan', '8');
  });
});
