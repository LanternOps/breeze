import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Dialog } from './Dialog';

function backdrop() {
  return document.querySelector('.dialog-backdrop') as HTMLElement;
}

describe('Dialog', () => {
  it('closes on a backdrop click and on Escape by default', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Example">
        <p>Body</p>
      </Dialog>,
    );

    fireEvent.click(backdrop());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('does not close on a click inside the panel', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Example">
        <p>Body</p>
      </Dialog>,
    );

    fireEvent.click(screen.getByText('Body'));

    expect(onClose).not.toHaveBeenCalled();
  });

  // #12305: a stray click outside a long form must not throw the form away.
  it('ignores backdrop clicks when dismissOnBackdrop is false, but Escape still calls onClose', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Example" dismissOnBackdrop={false}>
        <p>Body</p>
      </Dialog>,
    );

    fireEvent.click(backdrop());
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
