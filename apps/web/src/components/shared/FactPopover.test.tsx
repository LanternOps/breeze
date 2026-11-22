import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { FactPopover } from './FactPopover';

function Two() {
  return (
    <div>
      <FactPopover testId="a" icon={<span />} panel={<p>panel a</p>}>A</FactPopover>
      <FactPopover testId="b" icon={<span />} panel={<p>panel b <a href="#x">link b</a></p>}>B</FactPopover>
      <button type="button">elsewhere</button>
    </div>
  );
}

describe('FactPopover', () => {
  it('keeps one panel open at a time: opening another closes the first', () => {
    render(<Two />);
    fireEvent.click(screen.getByTestId('a'));
    expect(screen.getByTestId('a-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('b'));
    expect(screen.queryByTestId('a-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('b-panel')).toBeInTheDocument();
    expect(screen.getByTestId('a')).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes when keyboard focus leaves the chip and its panel, but not when it moves into the panel', () => {
    render(<Two />);
    const chip = screen.getByTestId('b');
    fireEvent.click(chip);
    const link = screen.getByRole('link', { name: 'link b' });
    fireEvent.blur(chip, { relatedTarget: link });
    expect(screen.getByTestId('b-panel')).toBeInTheDocument();
    fireEvent.blur(link, { relatedTarget: screen.getByRole('button', { name: 'elsewhere' }) });
    expect(screen.queryByTestId('b-panel')).not.toBeInTheDocument();
  });

  it('a click on panel text moves focus into the panel and keeps it open', async () => {
    const user = userEvent.setup();
    render(<Two />);
    await user.click(screen.getByTestId('b'));
    expect(screen.getByTestId('b')).toHaveFocus();
    await user.click(screen.getByText(/panel b/));
    // Focus lands on the panel itself, not <body>, so the chip's blur has a
    // relatedTarget inside the popover and does not count as leaving it.
    expect(screen.getByTestId('b-panel')).toHaveFocus();
    expect(screen.getByTestId('b-panel')).toBeInTheDocument();
  });

  it('activating a link or button in the panel closes it (the action takes the user elsewhere)', () => {
    render(<Two />);
    fireEvent.click(screen.getByTestId('b'));
    fireEvent.click(screen.getByRole('link', { name: 'link b' }));
    expect(screen.queryByTestId('b-panel')).not.toBeInTheDocument();
  });

  it('a click on plain panel text does not close it', () => {
    render(<Two />);
    fireEvent.click(screen.getByTestId('b'));
    fireEvent.click(screen.getByText(/panel b/));
    expect(screen.getByTestId('b-panel')).toBeInTheDocument();
  });

  it('a mousedown outside closes the open panel; one inside the panel does not', () => {
    render(<Two />);
    fireEvent.click(screen.getByTestId('a'));
    fireEvent.mouseDown(screen.getByText('panel a'));
    expect(screen.getByTestId('a-panel')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('a-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('a')).toHaveAttribute('aria-expanded', 'false');
  });

  it('Escape closes the open panel and returns focus to its chip', () => {
    render(<Two />);
    fireEvent.click(screen.getByTestId('a'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('a-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('a')).toHaveFocus();
  });
});
