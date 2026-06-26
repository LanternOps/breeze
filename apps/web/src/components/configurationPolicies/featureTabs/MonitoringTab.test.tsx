import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MonitoringTab from './MonitoringTab';
import { fetchWithAuth } from '../../../stores/auth';

const saveMock = vi.fn();
const removeMock = vi.fn();
const clearErrorMock = vi.fn();

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: undefined,
    clearError: clearErrorMock,
  }),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

// The disclosure header is a role="button" wrapper around the section title.
function sectionHeader(title: string): HTMLElement {
  const header = screen.getByText(title).closest('[role="button"]');
  if (!header) throw new Error(`No disclosure header found for section "${title}"`);
  return header as HTMLElement;
}

function renderTab() {
  return render(
    <MonitoringTab
      policyId="policy-1"
      existingLink={undefined}
      linkedPolicyId={null}
      onLinkChanged={vi.fn()}
    />,
  );
}

describe('MonitoringTab disclosure keyboard toggle (issue #1932)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // known-services autocomplete fetch on mount
    fetchMock.mockResolvedValue(makeJsonResponse({ data: [] }));
  });

  it('wires aria-controls to the rendered region id when expanded', () => {
    renderTab();

    const header = sectionHeader('Service & Process Watches');
    expect(header.getAttribute('aria-expanded')).toBe('false');

    fireEvent.keyDown(header, { key: 'Enter' });

    const panelId = header.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    // The region the header controls is now rendered with the matching id.
    expect(document.getElementById(panelId!)).not.toBeNull();
  });

  it('toggles the section open and closed on Enter', () => {
    renderTab();

    const header = sectionHeader('Service & Process Watches');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/No watches configured yet/i)).toBeNull();

    fireEvent.keyDown(header, { key: 'Enter' });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/No watches configured yet/i)).toBeTruthy();

    fireEvent.keyDown(header, { key: 'Enter' });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/No watches configured yet/i)).toBeNull();
  });

  it('toggles the section on Space and calls preventDefault to avoid page scroll', () => {
    renderTab();

    const header = sectionHeader('Service & Process Watches');
    expect(header.getAttribute('aria-expanded')).toBe('false');

    // Dispatch a real, cancelable keydown so we can observe preventDefault.
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
    fireEvent(header, event);

    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });

  it('does not toggle when the keydown originates from a nested action button', () => {
    renderTab();

    const header = sectionHeader('Service & Process Watches');
    expect(header.getAttribute('aria-expanded')).toBe('false');

    // The "Add Watch" button lives inside the header; a keydown on it has
    // event.target !== event.currentTarget and must be ignored by the guard.
    // Exact name avoids matching the header role="button", whose accessible
    // name also contains the nested "Add Watch" button text.
    const addButton = screen.getByRole('button', { name: 'Add Watch' });
    fireEvent.keyDown(addButton, { key: 'Enter' });

    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/No watches configured yet/i)).toBeNull();
  });

  it('ignores keys other than Enter and Space', () => {
    renderTab();

    const header = sectionHeader('Service & Process Watches');
    expect(header.getAttribute('aria-expanded')).toBe('false');

    fireEvent.keyDown(header, { key: 'a' });
    fireEvent.keyDown(header, { key: 'ArrowDown' });

    expect(header.getAttribute('aria-expanded')).toBe('false');
  });
});
