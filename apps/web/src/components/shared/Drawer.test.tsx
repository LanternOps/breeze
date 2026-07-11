import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../lib/i18n';
import { Drawer } from './Drawer';

describe('Drawer', () => {
  it('renders nothing when closed', () => {
    render(
      <Drawer open={false} onClose={() => {}} title="Details">
        <p>body</p>
      </Drawer>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders title, children, and dialog semantics when open', () => {
    render(
      <Drawer open onClose={() => {}} title="Details" dataTestId="my-drawer">
        <p>body</p>
      </Drawer>,
    );
    const panel = screen.getByTestId('my-drawer');
    expect(panel).toHaveAttribute('role', 'dialog');
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('Details')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('calls onClose on Escape and on backdrop click, but not on panel click', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="T" dataTestId="my-drawer">
        <button type="button">inner</button>
      </Drawer>,
    );
    fireEvent.click(screen.getByText('inner'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('my-drawer-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByTestId('my-drawer'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('suppresses backdrop close when closeDisabled', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="T" dataTestId="my-drawer" closeDisabled>
        <p>body</p>
      </Drawer>,
    );
    fireEvent.click(screen.getByTestId('my-drawer-backdrop'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('applies a custom width class and the close button works', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="T" width="max-w-xl" dataTestId="my-drawer">
        <p>body</p>
      </Drawer>,
    );
    expect(screen.getByTestId('my-drawer').className).toContain('max-w-xl');
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
