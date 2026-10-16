import { useEffect, useRef, useState } from 'react';
import { Loader2, Mail, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { OrgPickerField, type ReportTargetOrg } from './OrgPickerField';
import type { ReportSchedule } from './ReportsList';
import { CoversControl } from './series/CoversControl';
import { SeriesScheduleField } from './series/SeriesScheduleField';
import { isReportRecipientEmail, isSeriesSchedule } from './series/seriesConfig';
import type { CoversValue, SeriesSchedule } from './series/types';

/**
 * Who a template-created report is for and where it is sent (#8796): the
 * Covers choice (one organization, or one report per organization) and, for a
 * single-organization report, its schedule, the organization contacts it is
 * sent to, and any extra email addresses. Shared by every curated template
 * dialog so each one asks the same questions in the same place.
 */
export type TemplateDeliveryValue = {
  covers: CoversValue;
  /** Series mode only: recurring, never defaulted from a one-time template. */
  seriesSchedule: SeriesSchedule | '';
  /** Single-organization mode. */
  schedule: ReportSchedule;
  contactIds: string[];
  emailRecipients: string[];
};

/** Fresh state for a dialog opening on a template with this cadence. */
export function initialTemplateDelivery(schedule: ReportSchedule | undefined): TemplateDeliveryValue {
  const resolved = schedule ?? 'one_time';
  return {
    covers: { mode: 'org' },
    seriesSchedule: isSeriesSchedule(resolved) ? resolved : '',
    schedule: resolved,
    contactIds: [],
    emailRecipients: [],
  };
}

/**
 * What a single-organization create actually delivers. A one-time report is
 * never emailed (the schedule worker skips it, runs.ts records no delivery),
 * so recipients picked before switching to one-time are dropped rather than
 * stored where nothing will ever read them.
 */
export function singleOrgDeliveryOf(value: TemplateDeliveryValue): {
  schedule: ReportSchedule;
  contactIds: string[];
  emailRecipients: string[];
} {
  if (value.schedule === 'one_time') return { schedule: 'one_time', contactIds: [], emailRecipients: [] };
  return { schedule: value.schedule, contactIds: value.contactIds, emailRecipients: value.emailRecipients };
}

const SCHEDULES: ReportSchedule[] = ['one_time', 'daily', 'weekly', 'monthly'];

type ContactOption = { id: string; name: string | null; email: string };
type ContactsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; contacts: ContactOption[] }
  | { status: 'failed' };

export function TemplateDeliveryFields({
  reportType,
  value,
  onChange,
  orgTarget,
  seriesScheduleMissing,
}: {
  reportType: string;
  value: TemplateDeliveryValue;
  onChange: (next: TemplateDeliveryValue) => void;
  orgTarget: ReportTargetOrg;
  seriesScheduleMissing: boolean;
}) {
  const { t } = useTranslation('reports');
  const orgId = orgTarget.orgId;
  const singleOrg = value.covers.mode === 'org';
  const recurring = value.schedule !== 'one_time';
  const [contactsState, setContactsState] = useState<ContactsState>({ status: 'idle' });
  const [emailInput, setEmailInput] = useState('');
  const [emailInvalid, setEmailInvalid] = useState(false);

  // Contacts belong to one organization: a contact picked for the previous
  // organization must never be attached to a report for the next one.
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const lastOrgId = useRef(orgId);
  useEffect(() => {
    if (lastOrgId.current === orgId) return;
    lastOrgId.current = orgId;
    const { value: current, onChange: emit } = latest.current;
    if (current.contactIds.length > 0) emit({ ...current, contactIds: [] });
  }, [orgId]);

  useEffect(() => {
    if (!singleOrg || !recurring || !orgId) {
      setContactsState({ status: 'idle' });
      return;
    }
    let active = true;
    setContactsState({ status: 'loading' });
    fetchWithAuth(`/orgs/organizations/${orgId}/contacts`, { orgIdOverride: orgId })
      .then(async (response) => {
        if (!response.ok) throw new Error(`contacts ${response.status}`);
        const payload = (await response.json()) as { data?: ContactOption[] };
        if (!active) return;
        setContactsState({
          status: 'ready',
          contacts: (payload.data ?? []).filter((contact) => Boolean(contact.email)),
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        console.warn('[TemplateDeliveryFields] could not load organization contacts', err);
        setContactsState({ status: 'failed' });
      });
    return () => {
      active = false;
    };
  }, [orgId, singleOrg, recurring]);

  const toggleContact = (contactId: string) =>
    onChange({
      ...value,
      contactIds: value.contactIds.includes(contactId)
        ? value.contactIds.filter((id) => id !== contactId)
        : [...value.contactIds, contactId],
    });

  const addEmail = () => {
    const trimmed = emailInput.trim();
    if (!trimmed) return;
    if (!isReportRecipientEmail(trimmed)) {
      setEmailInvalid(true);
      return;
    }
    setEmailInvalid(false);
    setEmailInput('');
    if (!value.emailRecipients.includes(trimmed)) {
      onChange({ ...value, emailRecipients: [...value.emailRecipients, trimmed] });
    }
  };

  return (
    <div className="space-y-4">
      <div data-testid={`template-covers-${reportType}`}>
        <CoversControl
          reportType={reportType}
          value={value.covers}
          onChange={(covers) => onChange({ ...latest.current.value, covers })}
          withSeriesRecipients
          seriesExtra={
            <SeriesScheduleField
              value={value.seriesSchedule}
              onChange={(seriesSchedule) => onChange({ ...value, seriesSchedule })}
              showRequired={seriesScheduleMissing}
            />
          }
          orgField={
            orgTarget.pickerVisible ? (
              <OrgPickerField
                testId="template-org-picker"
                id="template-dialog-target-org"
                value={orgTarget.pickedOrgId}
                onChange={orgTarget.setPickedOrgId}
                options={orgTarget.options}
              />
            ) : null
          }
        />
      </div>

      {singleOrg && (
        <fieldset data-testid="template-delivery" className="space-y-4 rounded-md border p-4">
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
            {t('reports.reportBuilder.sections.delivery.title')}
          </legend>

          <div className="space-y-1">
            <label htmlFor="template-delivery-schedule" className="text-sm font-medium">
              {t('reports.reportBuilder.schedule')}
            </label>
            <select
              id="template-delivery-schedule"
              data-testid="template-delivery-schedule"
              value={value.schedule}
              onChange={(event) => onChange({ ...value, schedule: event.target.value as ReportSchedule })}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            >
              {SCHEDULES.map((schedule) => (
                <option key={schedule} value={schedule}>
                  {t(/* i18n-dynamic */ `reports.reportBuilder.scheduleOptions.${schedule}.label`)}
                </option>
              ))}
            </select>
          </div>

          {!recurring ? (
            <p data-testid="template-delivery-one-time-note" className="text-xs text-muted-foreground">
              {t('reports.reportBuilder.recipients.oneTimeNotEmailed')}
            </p>
          ) : (
            <>
              {orgId && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('reports.reportBuilder.recipients.contacts')}
                  </p>
                  {contactsState.status === 'loading' && (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {t('reports.reportTemplates.delivery.contactsLoading')}
                    </p>
                  )}
                  {contactsState.status === 'failed' && (
                    <p data-testid="template-delivery-contacts-failed" role="alert" className="text-xs text-destructive">
                      {t('reports.reportTemplates.delivery.contactsFailed')}
                    </p>
                  )}
                  {contactsState.status === 'ready' && contactsState.contacts.length === 0 && (
                    <p data-testid="template-delivery-no-contacts" className="text-xs text-muted-foreground">
                      {t('reports.reportTemplates.delivery.noContacts')}
                    </p>
                  )}
                  {contactsState.status === 'ready' && contactsState.contacts.length > 0 && (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {contactsState.contacts.map((contact) => (
                        <label
                          key={contact.id}
                          data-testid={`template-delivery-contact-${contact.id}`}
                          className="flex items-center gap-2 rounded-md border p-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={value.contactIds.includes(contact.id)}
                            onChange={() => toggleContact(contact.id)}
                          />
                          <span className="min-w-0 break-all">
                            {contact.name || contact.email}
                            {contact.name && (
                              <span className="block text-xs text-muted-foreground">{contact.email}</span>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('reports.reportBuilder.recipients.emailAddresses')}
                  </p>
                </div>
                {value.emailRecipients.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {value.emailRecipients.map((email) => (
                      <span
                        key={email}
                        data-testid={`template-delivery-email-chip-${email}`}
                        className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                      >
                        {email}
                        <button
                          type="button"
                          aria-label={t('reports.reportTemplates.delivery.removeEmail', { email })}
                          onClick={() =>
                            onChange({ ...value, emailRecipients: value.emailRecipients.filter((e) => e !== email) })
                          }
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    type="email"
                    data-testid="template-delivery-email-input"
                    aria-label={t('reports.reportBuilder.recipients.emailAddresses')}
                    value={emailInput}
                    onChange={(event) => {
                      setEmailInput(event.target.value);
                      setEmailInvalid(false);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addEmail();
                      }
                    }}
                    placeholder={t('reports.reportBuilder.placeholders.email')}
                    className="h-9 flex-1 rounded-md border bg-background px-2 text-sm"
                  />
                  <button
                    type="button"
                    data-testid="template-delivery-email-add"
                    onClick={addEmail}
                    className="h-9 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                  >
                    {t('reports.reportBuilder.addRecipient')}
                  </button>
                </div>
                {emailInvalid && (
                  <p data-testid="template-delivery-email-error" role="alert" className="text-xs text-destructive">
                    {t('reports.reportBuilder.errors.validEmail')}
                  </p>
                )}
              </div>
            </>
          )}
        </fieldset>
      )}
    </div>
  );
}
