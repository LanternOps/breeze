import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import PolicyEditPage from './PolicyEditPage';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

beforeEach(() => {
  fetchMock.mockReset();
  // Sites/groups/tags/scripts fetches fired on mount regardless of isNew — a
  // generic empty-list response keeps them inert for this a11y-only test.
  fetchMock.mockImplementation(async () => json({ data: [] }));
});

describe('PolicyEditPage back link (#7158 a11y)', () => {
  it('gives the icon-only back-to-policies link an accessible name', () => {
    render(<PolicyEditPage isNew />);

    expect(screen.getByRole('link', { name: 'Back to Policies' })).toHaveAttribute('href', '/policies');
  });
});
