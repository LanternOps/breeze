import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * #3705 — the failure this file exists for.
 *
 * A ConfirmDialog closes by tearing its portal out of the DOM. On a REAL
 * double-click the second physical press is hit-tested AFTER that teardown,
 * against whatever now occupies those coordinates — a device row, a bulk
 * action bar, a grid card. So the hazard is not a duplicate of the action the
 * user just confirmed; it is an UNRELATED action firing from the second half
 * of the gesture.
 *
 * jsdom has no layout and no hit-testing, so it cannot decide for itself which
 * element the second press lands on. What it CAN pin is the part that is
 * actually ours: the browser hands that press to the element underneath
 * carrying `detail === 2` (the platform click counter is derived from the
 * button, time and distance between presses, never from the hit-test target),
 * and the guard must swallow it. These tests deliver that press explicitly,
 * which is what a browser does — only without asking jsdom to compute the
 * target.
 */

/** A brand-new, deliberate press. */
function firstPress(el: HTMLElement) {
  fireEvent.mouseDown(el, { detail: 1 });
  fireEvent.mouseUp(el, { detail: 1 });
  fireEvent.click(el, { detail: 1 });
}

/** The second half of a double-click, as the browser delivers it. */
function secondPress(el: HTMLElement) {
  fireEvent.mouseDown(el, { detail: 2 });
  fireEvent.mouseUp(el, { detail: 2 });
  fireEvent.click(el, { detail: 2 });
}

describe('ConfirmDialog — double-click safety (#3705)', () => {
  beforeEach(() => {
    // Testing Library unmounts the previous test's tree between tests, and an
    // unmounting Dialog can arm the guard. Retire it with a fresh single press
    // so no test inherits an armed guard from its predecessor.
    fireEvent.mouseDown(document.body, { detail: 1 });
  });

  describe('the confirm button itself fires once per open dialog', () => {
    function StayOpen({ onConfirm, isLoading }: { onConfirm: () => void; isLoading?: boolean }) {
      // Deliberately does NOT close on confirm — this isolates the latch from
      // the unmount. A call site that unmounts is protected by the unmount too;
      // one that keeps the dialog mounted behind a spinner has only the latch.
      return (
        <ConfirmDialog
          open
          onClose={() => {}}
          onConfirm={onConfirm}
          title="Reboot the fleet"
          message="This reboots every selected device."
          confirmTestId="confirm"
          isLoading={isLoading}
        />
      );
    }

    it('ignores the second click of a double-click on a dialog that stays mounted', () => {
      const onConfirm = vi.fn();
      render(<StayOpen onConfirm={onConfirm} />);

      const confirm = screen.getByTestId('confirm');
      firstPress(confirm);
      secondPress(confirm);

      // `disabled={isLoading}` cannot hold here — it reads a value captured at
      // render, still false on the second click. The ref reads current.
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('releases the latch when an in-flight action settles, so a failure is retryable', () => {
      const onConfirm = vi.fn();
      const { rerender } = render(<StayOpen onConfirm={onConfirm} isLoading={false} />);

      firstPress(screen.getByTestId('confirm'));
      expect(onConfirm).toHaveBeenCalledTimes(1);

      // Action runs, then fails and leaves the dialog open. The call sites that
      // do this (ContractEditor, InvoiceActions, QuoteActions, …) rely on the
      // user being able to press Confirm again.
      rerender(<StayOpen onConfirm={onConfirm} isLoading />);
      rerender(<StayOpen onConfirm={onConfirm} isLoading={false} />);

      firstPress(screen.getByTestId('confirm'));
      expect(onConfirm).toHaveBeenCalledTimes(2);
    });

    // React 19 does not propagate a handler throw back through dispatchEvent —
    // it re-reports it as a window `error` event. Swallowing that event keeps
    // the throw from failing the worker while still exercising the real path.
    it('releases the latch when onConfirm throws, instead of killing the button', () => {
      const swallow = (e: ErrorEvent) => e.preventDefault();
      window.addEventListener('error', swallow);
      try {
        const onConfirm = vi.fn(() => {
          throw new Error('boom');
        });
        render(<StayOpen onConfirm={onConfirm} />);
        const confirm = screen.getByTestId('confirm');

        // A synchronous throw never reaches the close or the isLoading toggle,
        // so a latch left set would make Confirm dead for the rest of its life.
        firstPress(confirm);
        firstPress(confirm);
        expect(onConfirm).toHaveBeenCalledTimes(2);
      } finally {
        window.removeEventListener('error', swallow);
      }
    });
  });

  describe('the tail of the gesture cannot reach what was underneath', () => {
    function Harness({ underneath }: { underneath: () => void }) {
      const [open, setOpen] = useState(true);
      return (
        <>
          {/* Stands in for the list the confirm button is centred over. */}
          <button type="button" data-testid="underneath" onClick={underneath}>
            wake
          </button>
          <ConfirmDialog
            open={open}
            onClose={() => setOpen(false)}
            onConfirm={() => setOpen(false)}
            title="Reboot host-alpha"
            message="This reboots host-alpha."
            confirmTestId="confirm"
          />
        </>
      );
    }

    it('swallows the second press after the dialog is torn down', () => {
      const underneath = vi.fn();
      render(<Harness underneath={underneath} />);

      firstPress(screen.getByTestId('confirm'));
      expect(screen.queryByTestId('confirm')).toBeNull();

      secondPress(screen.getByTestId('underneath'));

      // Without the guard this is 1: an unrelated fleet Wake, queued by the
      // half of a double-click the user never aimed at anything.
      expect(underneath).not.toHaveBeenCalled();
    });

    it('still lets the next deliberate click through', () => {
      const underneath = vi.fn();
      render(<Harness underneath={underneath} />);

      firstPress(screen.getByTestId('confirm'));
      firstPress(screen.getByTestId('underneath'));

      expect(underneath).toHaveBeenCalledTimes(1);
    });

    it('does not eat a deliberate double-click aimed at the list afterwards', () => {
      const underneath = vi.fn();
      render(<Harness underneath={underneath} />);

      firstPress(screen.getByTestId('confirm'));

      // A NEW gesture opens with detail 1, which stands the guard down before
      // its own second press arrives — so both clicks land.
      const target = screen.getByTestId('underneath');
      firstPress(target);
      secondPress(target);

      expect(underneath).toHaveBeenCalledTimes(2);
    });

    it('leaves keyboard-driven clicks alone (they report detail 0)', () => {
      const underneath = vi.fn();
      render(<Harness underneath={underneath} />);

      firstPress(screen.getByTestId('confirm'));
      fireEvent.click(screen.getByTestId('underneath'), { detail: 0 });

      expect(underneath).toHaveBeenCalledTimes(1);
    });

    it('guards a Cancel press too — same teardown, same hole', () => {
      const underneath = vi.fn();
      render(<Harness underneath={underneath} />);

      firstPress(screen.getByText('Cancel'));
      expect(screen.queryByTestId('confirm')).toBeNull();

      secondPress(screen.getByTestId('underneath'));
      expect(underneath).not.toHaveBeenCalled();
    });

    // The guard is scoped to teardowns a completed click could have caused. An
    // Escape close has no gesture in flight, so arming there would only create
    // the opposite bug: eating a deliberate click that the platform happens to
    // count as the second of a pair. Same reasoning covers an async settle and
    // a route change, and it is what keeps StrictMode's extra cleanup inert.
    //
    // The interesting ordering is a press that starts INSIDE the dialog and
    // never completes a click there — dragging out a text selection, then
    // dismissing with Escape. Keying the arm condition on `mousedown` would arm
    // here and eat the user's next click; keying it on `click` does not. A test
    // that reaches Escape without any preceding press inside the dialog passes
    // under either rule and so proves nothing, which is why this one presses
    // first.
    it('does NOT arm after a press inside the dialog that ends in Escape', () => {
      const underneath = vi.fn();
      render(<Harness underneath={underneath} />);

      const backdrop = document.querySelector('.dialog-backdrop') as HTMLElement;
      const message = screen.getByText('This reboots host-alpha.');
      fireEvent.mouseDown(message, { detail: 1 });
      fireEvent.mouseUp(message, { detail: 1 });

      fireEvent.keyDown(backdrop, { key: 'Escape' });
      expect(screen.queryByTestId('confirm')).toBeNull();

      secondPress(screen.getByTestId('underneath'));
      expect(underneath).toHaveBeenCalledTimes(1);
    });

    // The module keeps a single active guard (`disarmActiveGestureTailGuard`),
    // so two dialogs closing back to back must not leave a stale listener
    // behind or double-suppress.
    it('survives two dialogs closing back to back', () => {
      const underneath = vi.fn();
      const { unmount } = render(<Harness underneath={underneath} />);
      firstPress(screen.getByTestId('confirm'));
      unmount();

      render(<Harness underneath={underneath} />);
      firstPress(screen.getByTestId('confirm'));

      secondPress(screen.getByTestId('underneath'));
      expect(underneath).not.toHaveBeenCalled();

      firstPress(screen.getByTestId('underneath'));
      expect(underneath).toHaveBeenCalledTimes(1);
    });
  });
});
