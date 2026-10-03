import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import RemindersSettingsSection, {
  reminderDraft, reminderPatch, reminderDraftInvalid, type ReminderEffective,
} from './RemindersSettingsSection';

const inherited: ReminderEffective = {
  remindersEnabled: { value: true, source: 'partner' },
  reminderBeforeDueDays: { value: 3, source: 'partner' },
  reminderRepeatDays: { value: 2, source: 'partner' },
  overdueReminderEveryDays: { value: 7, source: 'default' },
};
describe('RemindersSettingsSection', () => {
  it('keeps explicit false distinct from blank and shows inherited values', () => {
    const value = reminderDraft({ ...inherited, remindersEnabled: { value: false, source: 'org' } }, 'org');
    const onChange = vi.fn();
    render(<I18nextProvider i18n={i18n}><RemindersSettingsSection scope="org" value={value}
      inherited={inherited} onChange={onChange} /></I18nextProvider>);
    expect(screen.getByTestId('autopay-reminders-enabled')).toHaveValue('false');
    expect(screen.getByTestId('autopay-reminders-before')).toHaveAttribute('placeholder', '3');
    expect(screen.getByTestId('autopay-reminders-repeat')).toHaveAttribute('placeholder', '2');
    fireEvent.change(screen.getByTestId('autopay-reminders-enabled'), { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith({ ...value, remindersEnabled: '' });
    expect(reminderPatch(value).remindersEnabled).toBe(false);
    expect(reminderPatch({ ...value, remindersEnabled: '' }).remindersEnabled).toBeNull();
    expect(screen.getByTestId('autopay-reminders-repeat-help')).toHaveTextContent('cannot disable');
  });
  it('disables controlled fields and exposes no second Save', () => {
    render(<I18nextProvider i18n={i18n}><RemindersSettingsSection scope="partner"
      value={reminderDraft(inherited, 'partner')} inherited={inherited} onChange={vi.fn()} disabled /></I18nextProvider>);
    expect(screen.getByTestId('autopay-reminders-enabled')).toBeDisabled();
    expect(screen.getByTestId('autopay-reminders-before')).toBeDisabled();
    expect(screen.queryByTestId('autopay-reminders-save')).toBeNull();
  });
  it.each(['0', '32', '1.5', '-1', 'NaN'])('rejects an invalid interval %s', (value) => {
    const draft = { ...reminderDraft(inherited, 'org'), reminderBeforeDueDays: value };
    expect(reminderDraftInvalid(draft)).toBe(true);
    expect(() => reminderPatch(draft)).toThrow(RangeError);
  });
  it.each(['', '1', '31'])('accepts blank inheritance or boundary %s', value => {
    const draft = { ...reminderDraft(inherited, 'org'), reminderRepeatDays: value };
    expect(reminderDraftInvalid(draft)).toBe(false);
    expect(reminderPatch(draft).reminderRepeatDays).toBe(value === '' ? null : Number(value));
  });
});
