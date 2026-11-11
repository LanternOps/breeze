// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MicrosoftSignInButton } from './MicrosoftSignInButton';

afterEach(cleanup);

describe('MicrosoftSignInButton', () => {
  it('renders the default label and testid and fires onClick', () => {
    const onClick = vi.fn();
    render(<MicrosoftSignInButton onClick={onClick} />);
    const button = screen.getByTestId('portal-login-microsoft');
    expect(button.textContent).toContain('Sign in with Microsoft');
    expect(button.querySelector('svg')).not.toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('overrides label and testid', () => {
    render(<MicrosoftSignInButton onClick={() => {}} label="Continue with Microsoft" testId="x-ms" />);
    expect(screen.getByTestId('x-ms').textContent).toContain('Continue with Microsoft');
  });

  it('is disabled while busy', () => {
    const onClick = vi.fn();
    render(<MicrosoftSignInButton onClick={onClick} busy />);
    const button = screen.getByTestId('portal-login-microsoft') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
