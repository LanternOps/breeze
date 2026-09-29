import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SeriesScheduleField } from './SeriesScheduleField';

describe('SeriesScheduleField', () => {
  it('starts empty, offers only recurring schedules, and explains why', () => {
    render(<SeriesScheduleField value="" onChange={vi.fn()} showRequired={false} />);
    const select = screen.getByTestId('series-schedule-select');
    expect(select).toHaveValue('');
    expect(within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['', 'daily', 'weekly', 'monthly']);
    expect(screen.getByTestId('series-schedule-hint')).toHaveTextContent("can't be one-time");
    expect(screen.queryByTestId('series-schedule-required')).toBeNull();
  });

  it('emits the chosen schedule and shows the required message when asked', () => {
    const onChange = vi.fn();
    render(<SeriesScheduleField value="" onChange={onChange} showRequired />);
    expect(screen.getByTestId('series-schedule-required')).toHaveTextContent('Choose how often the report is sent.');
    fireEvent.change(screen.getByTestId('series-schedule-select'), { target: { value: 'weekly' } });
    expect(onChange).toHaveBeenCalledWith('weekly');
  });
});
