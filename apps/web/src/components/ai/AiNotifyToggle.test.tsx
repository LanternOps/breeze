import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ user: { id: 'u1' } as { id: string } | null }));
vi.mock('@/stores/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (s: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  ),
}));

import AiNotifyToggle from './AiNotifyToggle';
import { isNotifyOptedIn, resetAiNotificationsForTests, setNotifyOptIn } from '@/lib/aiNotifications';

class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async (): Promise<NotificationPermission> => FakeNotification.permission);
}
const g = globalThis as unknown as { Notification?: unknown };
const button = () => screen.getByTestId('ai-notify-toggle');

beforeEach(() => {
  FakeNotification.permission = 'default';
  FakeNotification.requestPermission.mockReset();
  FakeNotification.requestPermission.mockImplementation(async () => FakeNotification.permission);
  g.Notification = FakeNotification;
  authState.user = { id: 'u1' };
  localStorage.clear();
  resetAiNotificationsForTests();
});

afterEach(() => {
  delete g.Notification;
});

describe('AiNotifyToggle (#9429)', () => {
  it('renders nothing without the Notification API', () => {
    delete g.Notification;
    const { container } = render(<AiNotifyToggle />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing without a signed-in user', () => {
    authState.user = null;
    const { container } = render(<AiNotifyToggle />);
    expect(container).toBeEmptyDOMElement();
  });

  it('never asks for permission on mount (never on page load)', () => {
    render(<AiNotifyToggle />);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(button()).toHaveAttribute('aria-pressed', 'false');
  });

  it('off → click asks once and turns on when granted', async () => {
    FakeNotification.requestPermission.mockImplementationOnce(async () => {
      FakeNotification.permission = 'granted';
      return 'granted';
    });
    render(<AiNotifyToggle />);
    await act(async () => { fireEvent.click(button()); });
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(button()).toHaveAttribute('aria-pressed', 'true'));
    expect(isNotifyOptedIn('u1')).toBe(true);
  });

  it('off → click stays off when the prompt is refused, then shows the blocked state', async () => {
    FakeNotification.requestPermission.mockImplementationOnce(async () => {
      FakeNotification.permission = 'denied';
      return 'denied';
    });
    render(<AiNotifyToggle />);
    await act(async () => { fireEvent.click(button()); });
    await waitFor(() => expect(button()).toBeDisabled());
    expect(button()).toHaveAttribute('aria-pressed', 'false');
    expect(isNotifyOptedIn('u1')).toBe(false);
  });

  it('on → click turns off and never prompts', async () => {
    FakeNotification.permission = 'granted';
    setNotifyOptIn('u1', true);
    render(<AiNotifyToggle />);
    expect(button()).toHaveAttribute('aria-pressed', 'true');
    await act(async () => { fireEvent.click(button()); });
    expect(button()).toHaveAttribute('aria-pressed', 'false');
    expect(isNotifyOptedIn('u1')).toBe(false);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it('permission denied in the browser → disabled, with the browser-settings hint', () => {
    FakeNotification.permission = 'denied';
    setNotifyOptIn('u1', true);
    render(<AiNotifyToggle />);
    expect(button()).toBeDisabled();
    expect(button()).toHaveAttribute('aria-pressed', 'false');
    expect(button()).toHaveAttribute('title', 'Notifications are blocked for this site. Allow them in your browser settings.');
  });

  it('an opt-in whose permission was reset to "ask" shows as off', () => {
    FakeNotification.permission = 'default';
    setNotifyOptIn('u1', true);
    render(<AiNotifyToggle />);
    expect(button()).toHaveAttribute('aria-pressed', 'false');
  });

  it('labels say what a click does', async () => {
    FakeNotification.permission = 'granted';
    render(<AiNotifyToggle />);
    expect(button()).toHaveAttribute('aria-label', 'Notify me when a response is ready');
    await act(async () => { fireEvent.click(button()); });
    await waitFor(() => expect(button()).toHaveAttribute('aria-label', 'Turn off Breeze AI notifications'));
  });
});
