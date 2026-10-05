import { useTranslation } from 'react-i18next';
import InheritedField from '../shared/InheritedField';

type Source = 'org' | 'partner' | 'default';
type Effective<T> = { value: T; source: Source };
export interface ReminderEffective {
  remindersEnabled: Effective<boolean>;
  reminderBeforeDueDays: Effective<number>;
  reminderRepeatDays: Effective<number | null>;
  overdueReminderEveryDays: Effective<number>;
}
export interface ReminderDraft {
  remindersEnabled: '' | 'true' | 'false';
  reminderBeforeDueDays: string;
  reminderRepeatDays: string;
  overdueReminderEveryDays: string;
}
const dayKeys = ['reminderBeforeDueDays', 'reminderRepeatDays', 'overdueReminderEveryDays'] as const;
export function reminderDraft(effective: ReminderEffective, scope: 'partner' | 'org'): ReminderDraft {
  const own = <T,>(field: Effective<T>) => field.source === scope && field.value !== null ? String(field.value) : '';
  return {
    remindersEnabled: own(effective.remindersEnabled) as ReminderDraft['remindersEnabled'],
    reminderBeforeDueDays: own(effective.reminderBeforeDueDays),
    reminderRepeatDays: own(effective.reminderRepeatDays),
    overdueReminderEveryDays: own(effective.overdueReminderEveryDays),
  };
}
export function reminderDraftInvalid(value: ReminderDraft): boolean {
  return dayKeys.some(key => value[key] !== '' &&
    (!/^\d+$/.test(value[key]) || Number(value[key]) < 1 || Number(value[key]) > 31));
}
export function reminderPatch(value: ReminderDraft) {
  if (reminderDraftInvalid(value)) throw new RangeError('Invalid reminder interval');
  const day = (text: string) => text === '' ? null : Number(text);
  return {
    remindersEnabled: value.remindersEnabled === '' ? null : value.remindersEnabled === 'true',
    reminderBeforeDueDays: day(value.reminderBeforeDueDays),
    reminderRepeatDays: day(value.reminderRepeatDays),
    overdueReminderEveryDays: day(value.overdueReminderEveryDays),
  };
}
export default function RemindersSettingsSection({ scope, value, inherited, onChange, disabled = false }: {
  scope: 'partner' | 'org'; value: ReminderDraft; inherited: ReminderEffective;
  onChange: (value: ReminderDraft) => void; disabled?: boolean;
}) {
  const { t } = useTranslation('billing');
  const fields = [
    ['reminderBeforeDueDays', 'before'], ['reminderRepeatDays', 'repeat'], ['overdueReminderEveryDays', 'overdue'],
  ] as const;
  const source = (key: keyof ReminderEffective) => t(/* i18n-dynamic */ `reminders.sources.${inherited[key].source}`);
  return <section className="space-y-4 rounded-lg border bg-card p-6" data-testid="autopay-reminders-section">
    <h2 className="text-lg font-semibold">{t('reminders.title')}</h2>
    <p className="text-sm text-muted-foreground">{t('reminders.description')}</p>
    <div>
      <label htmlFor={`reminders-${scope}-enabled`} className="text-sm font-medium">{t('reminders.enabled')}</label>
      <select id={`reminders-${scope}-enabled`} data-testid="autopay-reminders-enabled"
        className="mt-1 block rounded-md border bg-background px-3 py-2 text-sm"
        value={value.remindersEnabled} disabled={disabled}
        onChange={event => onChange({ ...value, remindersEnabled: event.target.value as ReminderDraft['remindersEnabled'] })}>
        <option value="">{t('reminders.inherit', {
          value: inherited.remindersEnabled.value ? t('reminders.on') : t('reminders.off'), source: source('remindersEnabled'),
        })}</option>
        <option value="true">{t('reminders.on')}</option>
        <option value="false">{t('reminders.off')}</option>
      </select>
    </div>
    <div className="grid gap-4 sm:grid-cols-3">
      {fields.map(([key, id]) => <InheritedField key={key} id={`reminders-${scope}-${id}`}
        data-testid={`autopay-reminders-${id}`} label={t(/* i18n-dynamic */ `reminders.${id}`)} value={value[key]}
        onChange={text => onChange({ ...value, [key]: text })} disabled={disabled}
        inheritedValue={inherited[key].value === null ? t('reminders.noRepeat') : String(inherited[key].value)}
        inheritedSource={source(key)} type="number" min={1} max={31} step="1" />)}
    </div>
    <p className="text-xs text-muted-foreground" data-testid="autopay-reminders-repeat-help">
      {scope === 'org' ? t('reminders.orgRepeatHelp') : t('reminders.partnerRepeatHelp')}
    </p>
    <p className="text-xs text-muted-foreground">{t('reminders.cadenceHelp')}</p>
    {reminderDraftInvalid(value) && <p role="alert" className="text-sm text-destructive"
      data-testid="autopay-reminders-validation">{t('reminders.invalid')}</p>}
  </section>;
}
