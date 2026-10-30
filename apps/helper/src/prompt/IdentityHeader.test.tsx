// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { IdentityHeader } from './IdentityHeader';
import type { PromptIdentity } from './identity';

const identity: PromptIdentity = {
  partnerName: 'Example IT Services',
  primaryColor: '#1F5FAD',
  logo: null,
};

describe('IdentityHeader', () => {
  it('IdentityHeader falls back to the generic name when identity is cleared', () => {
    const { rerender } = render(<IdentityHeader identity={identity} logoUrl={null} locale="en" />);
    expect(screen.getByTestId('prompt-identity')).toHaveTextContent('Example IT Services');
    rerender(<IdentityHeader identity={null} logoUrl={null} locale="en" />);
    expect(screen.getByTestId('prompt-identity')).toHaveTextContent('Your IT support team');
    rerender(<IdentityHeader identity={null} logoUrl={null} locale="de-DE" />);
    expect(screen.getByTestId('prompt-identity')).toHaveTextContent('Ihr IT-Support-Team');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders the name as text, never as markup', () => {
    const hostile = { ...identity, partnerName: '<img src=x onerror=alert(1)>Example' };
    const { container } = render(<IdentityHeader identity={hostile} logoUrl={null} locale="en" />);
    expect(screen.getByTestId('prompt-identity')).toHaveTextContent('<img src=x onerror=alert(1)>Example');
    expect(container.querySelector('img')).toBeNull();
  });

  it('shows the logo from its blob URL only', () => {
    const { container, rerender } = render(<IdentityHeader identity={identity} logoUrl="blob:assist/1" locale="en" />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'blob:assist/1');
    rerender(<IdentityHeader identity={identity} logoUrl="https://example.invalid/logo.png" locale="en" />);
    expect(container.querySelector('img')).toBeNull();
  });

  it('uses a readable brand colour as the accent', () => {
    render(<IdentityHeader identity={identity} logoUrl={null} locale="en" />);
    const header = screen.getByTestId('prompt-identity');
    expect(header.style.getPropertyValue('--prompt-brand-accent')).toBe('#1F5FAD');
    expect(header).toHaveAttribute('data-accent', 'brand');
  });

  it('unreadable brand colour replaced by the default', () => {
    // #777777 is below 4.5:1 on both the light and the dark Assist canvas.
    render(<IdentityHeader identity={{ ...identity, primaryColor: '#777777' }} logoUrl={null} locale="en" />);
    const header = screen.getByTestId('prompt-identity');
    expect(header.style.getPropertyValue('--prompt-brand-accent')).toBe('');
    expect(header).toHaveAttribute('data-accent', 'default');
  });

  it('uses the brand colour only when it is readable in the active theme (W04)', () => {
    // #1F5FAD passes on the light canvas and fails on the dark one.
    const { rerender } = render(<IdentityHeader identity={identity} logoUrl={null} locale="en" theme="light" />);
    const header = () => screen.getByTestId('prompt-identity');
    expect(header()).toHaveAttribute('data-accent', 'brand');
    for (const theme of ['dark', 'forced', 'more'] as const) {
      rerender(<IdentityHeader identity={identity} logoUrl={null} locale="en" theme={theme} />);
      expect(header(), theme).toHaveAttribute('data-accent', 'default');
      expect(header().style.getPropertyValue('--prompt-brand-accent'), theme).toBe('');
    }
    // A light colour is the reverse.
    rerender(<IdentityHeader identity={{ ...identity, primaryColor: '#FFD166' }} logoUrl={null} locale="en" theme="dark" />);
    expect(header()).toHaveAttribute('data-accent', 'brand');
    rerender(<IdentityHeader identity={{ ...identity, primaryColor: '#FFD166' }} logoUrl={null} locale="en" theme="light" />);
    expect(header()).toHaveAttribute('data-accent', 'default');
  });

  it('ignores a colour that is not strict #RRGGBB', () => {
    render(<IdentityHeader identity={{ ...identity, primaryColor: 'red; background:url(x)' }} logoUrl={null} locale="en" />);
    expect(screen.getByTestId('prompt-identity')).toHaveAttribute('data-accent', 'default');
  });
});
