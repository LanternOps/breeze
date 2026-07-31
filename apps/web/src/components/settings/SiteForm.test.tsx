import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SiteForm from './SiteForm';

// Issue #2856: this form's timezone control was a 10-entry hardcoded <select>
// with no Europe/Paris, so a French self-hoster creating their first site could
// not pick their own zone. TimezoneSelect covers the picker's own behaviour;
// what these tests pin is the wiring — that the picked zone actually reaches
// onSubmit through react-hook-form's Controller, and that a stored zone
// arriving via defaultValues survives (the invariant the removed `zones`
// workaround effect used to hold).

describe('SiteForm timezone', () => {
  it('submits a zone that was absent from the old hardcoded list', async () => {
    const onSubmit = vi.fn();
    render(<SiteForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Site name'), { target: { value: 'Paris HQ' } });
    fireEvent.click(screen.getByTestId('site-timezone-trigger'));
    fireEvent.change(screen.getByTestId('site-timezone-search'), { target: { value: 'paris' } });
    fireEvent.click(screen.getByTestId('site-timezone-option-Europe/Paris'));

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      name: 'Paris HQ',
      timezone: 'Europe/Paris',
    });
  });

  it('defaults to UTC and submits it unchanged when the user picks nothing', async () => {
    const onSubmit = vi.fn();
    render(<SiteForm onSubmit={onSubmit} />);

    expect(screen.getByTestId('site-timezone-trigger')).toHaveTextContent('UTC');
    fireEvent.change(screen.getByLabelText('Site name'), { target: { value: 'HQ' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ timezone: 'UTC' });
  });

  it('renders and preserves a defaultValue zone the old list did not contain', async () => {
    const onSubmit = vi.fn();
    render(<SiteForm onSubmit={onSubmit} defaultValues={{ name: 'Madrid', timezone: 'Europe/Madrid' }} />);

    // The removed workaround effect existed because a native <select> silently
    // fell back to its first option here; the value must still show up as-is.
    expect(screen.getByTestId('site-timezone-trigger')).toHaveTextContent('Europe/Madrid');

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ timezone: 'Europe/Madrid' });
  });
});
