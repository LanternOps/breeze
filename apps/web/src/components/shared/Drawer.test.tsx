import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

  // Review finding #4: every drawer used to focus its header Close button
  // first, because it's first in DOM under the FOCUSABLE query — initial
  // focus should land inside the body content instead, so a keyboard user
  // starts on the actual task, not on the exit.
  it('focuses the first focusable element in the body content, not the header close button', async () => {
    render(
      <Drawer open onClose={() => {}} title="T" dataTestId="my-drawer">
        <div>
          <button type="button">Body button</button>
        </div>
      </Drawer>,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Body button' })),
    );
    expect(document.activeElement).not.toBe(screen.getByTestId('my-drawer-close'));
  });

  it('falls back to focusing the panel when the body has no focusable content', async () => {
    render(
      <Drawer open onClose={() => {}} title="T" dataTestId="my-drawer">
        <p>Nothing focusable here.</p>
      </Drawer>,
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('my-drawer')));
    expect(document.activeElement).not.toBe(screen.getByTestId('my-drawer-close'));
  });

  // Review finding #4 (round 2): FOCUSABLE's `button:not([disabled])` clause
  // matches a button REGARDLESS of its tabindex, so the first node it found in
  // a body that opens with a roving-tabindex radiogroup was a `tabindex="-1"`
  // radio. Focus landed on an UNSELECTED option, and the group's own
  // ArrowRight handler then moved selection off it — one arrow key away from
  // silently selecting the most privileged mode in the AI-agent form.
  it('skips a tabindex="-1" node and focuses the first genuinely tabbable one', async () => {
    render(
      <Drawer open onClose={() => {}} title="T" dataTestId="my-drawer">
        <div>
          <button type="button" tabIndex={-1}>Roving radio</button>
          <button type="button">Real tab stop</button>
        </div>
      </Drawer>,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Real tab stop' })),
    );
  });

  // Review finding #2: `closeDisabled` guarded ONLY the backdrop, so the two
  // other ways out of a drawer — Escape and the header X — sailed straight
  // past a call site's unsaved-work guard.
  it('suppresses Escape close when closeDisabled', () => {
    const onClose = vi.fn();
    render(
      <Drawer open onClose={onClose} title="T" dataTestId="my-drawer" closeDisabled>
        <p>body</p>
      </Drawer>,
    );
    fireEvent.keyDown(screen.getByTestId('my-drawer'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders the close button as aria-disabled with a readable reason when closeDisabled', () => {
    const onClose = vi.fn();
    render(
      <Drawer
        open
        onClose={onClose}
        title="T"
        dataTestId="my-drawer"
        closeDisabled
        closeDisabledReason="Finish the unsaved schedule first."
      >
        <p>body</p>
      </Drawer>,
    );

    const close = screen.getByTestId('my-drawer-close');
    fireEvent.click(close);
    expect(onClose).not.toHaveBeenCalled();
    // aria-disabled, not `disabled`: the control must stay focusable so the
    // reason below is reachable, and so it stays inside the focus trap.
    expect(close).toHaveAttribute('aria-disabled', 'true');
    expect(close).not.toBeDisabled();
    // The reason is a real described-by node, never a `title=` tooltip.
    expect(close).not.toHaveAttribute('title');
    const describedBy = close.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent('Finish the unsaved schedule first.');
  });

  it('does not mark the close button disabled when closing is allowed', () => {
    render(
      <Drawer open onClose={() => {}} title="T" dataTestId="my-drawer">
        <p>body</p>
      </Drawer>,
    );
    expect(screen.getByTestId('my-drawer-close')).not.toHaveAttribute('aria-disabled');
  });
});
