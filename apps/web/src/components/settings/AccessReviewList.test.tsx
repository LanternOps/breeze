import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import AccessReviewList, { type AccessReview } from './AccessReviewList';

describe('AccessReviewList due date', () => {
  it('shows the picked calendar day regardless of browser timezone', () => {
    const review: AccessReview = {
      id: 'r1',
      name: 'Q4 review',
      status: 'pending',
      dueDate: '2026-10-20T00:00:00.000Z',
      createdAt: '2026-10-01T12:00:00.000Z'
    };
    render(<AccessReviewList reviews={[review]} />);
    expect(screen.getByText('Oct 20, 2026')).toBeTruthy();
  });
});
