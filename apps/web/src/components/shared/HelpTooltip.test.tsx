import '@/lib/i18n';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import HelpTooltip from './HelpTooltip';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
}

describe('HelpTooltip positioning', () => {
  let triggerRect: DOMRect;

  beforeEach(() => {
    triggerRect = rect(260, 300, 20, 20);
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(800);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'tooltip' ? rect(0, 0, 224, 64) : triggerRect;
    });
  });

  it('escapes clipping and transformed ancestors through a body portal', () => {
    const { container } = render(
      <div style={{ overflow: 'hidden', transform: 'translateX(0)' }}>
        <HelpTooltip text="Complete reliability score explanation" ariaLabel="About the score" />
      </div>,
    );
    const trigger = screen.getByRole('button', { name: 'About the score' });
    fireEvent.mouseEnter(trigger);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.parentElement).toBe(document.body);
    expect(container).not.toContainElement(tooltip);
    expect(tooltip).toHaveClass('fixed');
    expect(tooltip).toHaveStyle({ left: '158px', top: '228px', visibility: 'visible' });
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id);
    expect(tooltip).toHaveTextContent('Complete reliability score explanation');
  });

  it.each([
    { left: 0, expectedLeft: '8px', arrowLeft: '8px' },
    { left: 780, expectedLeft: '568px', arrowLeft: '216px' },
  ])('keeps the bubble inside the viewport for a trigger at $left', ({ left, expectedLeft, arrowLeft }) => {
    triggerRect = rect(left, 300, 20, 20);
    render(<HelpTooltip text="Explanation" />);
    fireEvent.mouseEnter(screen.getByRole('button'));
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveStyle({ left: expectedLeft });
    expect(tooltip.querySelector('[aria-hidden="true"]')).toHaveStyle({ left: arrowLeft });
  });

  it.each([
    { side: 'top' as const, top: 10, expectedTop: '38px' },
    { side: 'bottom' as const, top: 570, expectedTop: '498px' },
    { side: 'bottom' as const, top: 300, expectedTop: '328px' },
  ])('positions a $side tooltip at trigger height $top', ({ side, top, expectedTop }) => {
    triggerRect = rect(260, top, 20, 20);
    render(<HelpTooltip text="Explanation" side={side} />);
    fireEvent.focus(screen.getByRole('button'));
    expect(screen.getByRole('tooltip')).toHaveStyle({ top: expectedTop });
  });

  it('follows nested scrolling and viewport resizing while open', () => {
    const { container } = render(<div><HelpTooltip text="Explanation" /></div>);
    fireEvent.focus(screen.getByRole('button'));
    triggerRect = rect(400, 200, 20, 20);
    fireEvent.scroll(container.firstElementChild!);
    expect(screen.getByRole('tooltip')).toHaveStyle({ left: '298px', top: '128px' });
    triggerRect = rect(780, 200, 20, 20);
    fireEvent.resize(window);
    expect(screen.getByRole('tooltip')).toHaveStyle({ left: '568px', top: '128px' });
  });

  it('dismisses on Escape, blur, mouse leave, and outside click', () => {
    render(<HelpTooltip text="Explanation" />);
    const trigger = screen.getByRole('button');
    fireEvent.focus(trigger);
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(trigger).not.toHaveAttribute('aria-describedby');
    fireEvent.focus(trigger);
    fireEvent.blur(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.mouseEnter(trigger);
    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
