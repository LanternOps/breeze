import { useEffect, useMemo, useState } from 'react';
import {
  emailTemplateHasCta,
  emailTemplateLabel,
  renderTemplate,
  varsForEmailTemplate,
  type EmailTemplateId,
  type TicketTemplateVars,
} from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { strippedTagsFrom } from '../../lib/richTextWarnings';
import { showToast } from '../shared/Toast';
import RichTextEditor from '../common/RichTextEditor';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

export type EmailTemplateOverride = {
  subject: string | null;
  heading: string | null;
  buttonLabel: string | null;
  html: string | null;
};

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

const SAMPLE_VARS: Record<string, string> = {
  ticket_number: 'T-2026-0001',
  ticket_subject: 'Email not syncing',
  requester_name: 'Sample Requester',
  requester_email: 'user@example.com',
  org_name: 'Acme Corp',
  partner_name: 'Your Company',
  portal_url: 'https://portal.example.com/tickets/1',
  email_only_hint: 'If you do not have a portal account, reply to this email instead.',
  resolution_note: 'Replaced the failing drive.',
};

function previewSafeHtml(html: string): string {
  const filled = renderTemplate(html, SAMPLE_VARS as TicketTemplateVars);
  if (typeof DOMParser === 'undefined') return filled;
  const doc = new DOMParser().parseFromString(filled, 'text/html');
  doc.querySelectorAll('script,iframe,object,embed').forEach((el) => el.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('on') || attr.name === 'srcdoc') el.removeAttribute(attr.name);
    }
  });
  return doc.body.innerHTML;
}

interface Props {
  templateId: EmailTemplateId;
  value: EmailTemplateOverride | undefined;
  onBack: () => void;
  onSaved: (next: EmailTemplateOverride) => void;
}

export default function EmailTemplateEditor({ templateId, value, onBack, onSaved }: Props) {
  const { t } = useTranslation('settings');
  const hasCta = emailTemplateHasCta(templateId);
  const [subject, setSubject] = useState(value?.subject ?? '');
  const [heading, setHeading] = useState(value?.heading ?? '');
  const [buttonLabel, setButtonLabel] = useState(value?.buttonLabel ?? '');
  const [html, setHtml] = useState(value?.html ?? '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSubject(value?.subject ?? '');
    setHeading(value?.heading ?? '');
    setButtonLabel(value?.buttonLabel ?? '');
    setHtml(value?.html ?? '');
  }, [templateId, value]);

  const preview = useMemo(() => previewSafeHtml(html), [html]);

  const persist = async (fields: EmailTemplateOverride) => {
    setSaving(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth('/orgs/partners/me', {
            method: 'PATCH',
            body: JSON.stringify({ settings: { emailTemplates: { [templateId]: fields } } }),
          }),
        errorFallback: t('emailTemplates.saveFailed'),
        onUnauthorized: UNAUTHORIZED,
        parseSuccess: (d) => {
          const tags = strippedTagsFrom(d);
          showToast(
            tags.length > 0
              ? { type: 'warning', message: t('emailTemplates.markupRemoved', { tags: tags.join(', ') }) }
              : { type: 'success', message: t('emailTemplates.saved') },
          );
          return d;
        },
      });
      onSaved(fields);
      setSubject(fields.subject ?? '');
      setHeading(fields.heading ?? '');
      setButtonLabel(fields.buttonLabel ?? '');
      setHtml(fields.html ?? '');
    } catch (err) {
      handleActionError(err, t('emailTemplates.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const save = () =>
    void persist({
      subject,
      heading,
      buttonLabel: hasCta ? buttonLabel : null,
      html,
    });

  const reset = () =>
    void persist({ subject: null, heading: null, buttonLabel: null, html: null });

  return (
    <div className="space-y-4" data-testid="email-template-editor">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{emailTemplateLabel(templateId)}</h2>
        <button
          type="button"
          onClick={onBack}
          className="text-sm text-primary hover:underline"
          data-testid="email-template-back"
        >
          {t('emailTemplates.back')}
        </button>
      </div>

      <label className="block text-xs font-medium" htmlFor="email-template-subject">
        {t('emailTemplates.subject')}
      </label>
      <input
        id="email-template-subject"
        type="text"
        maxLength={200}
        value={subject}
        disabled={saving}
        onChange={(e) => setSubject(e.target.value)}
        className="mt-0.5 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
        data-testid="email-template-subject"
      />

      <label className="block text-xs font-medium" htmlFor="email-template-heading">
        {t('emailTemplates.heading')}
      </label>
      <input
        id="email-template-heading"
        type="text"
        maxLength={200}
        value={heading}
        disabled={saving}
        onChange={(e) => setHeading(e.target.value)}
        className="mt-0.5 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
        data-testid="email-template-heading"
      />

      {hasCta && (
        <>
          <label className="block text-xs font-medium" htmlFor="email-template-button-label">
            {t('emailTemplates.buttonLabel')}
          </label>
          <input
            id="email-template-button-label"
            type="text"
            maxLength={80}
            value={buttonLabel}
            disabled={saving}
            onChange={(e) => setButtonLabel(e.target.value)}
            className="mt-0.5 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="email-template-button-label"
          />
        </>
      )}

      <label className="block text-xs font-medium">{t('emailTemplates.html')}</label>
      <RichTextEditor
        value={html}
        onChange={setHtml}
        ariaLabel={t('emailTemplates.htmlAria')}
        testId="email-template-html"
      />

      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-muted-foreground">{t('emailTemplates.insert')}</span>
        {varsForEmailTemplate(templateId).map((key) => (
          <button
            key={key}
            type="button"
            disabled={saving}
            onClick={() => setHtml((current) => `${current}{{${key}}}`)}
            className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            data-testid={`email-template-var-${key}`}
          >
            {t(/* i18n-dynamic */ `emailTemplates.variables.${key}`)}
          </button>
        ))}
      </div>

      <div>
        <p className="text-xs font-medium text-muted-foreground">{t('emailTemplates.preview')}</p>
        <div
          className="prose prose-sm mt-1 max-w-none rounded-md border bg-background p-3"
          data-testid="email-template-preview"
          dangerouslySetInnerHTML={{ __html: preview }}
        />
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={save}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          data-testid="email-template-save"
        >
          {t('emailTemplates.save')}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={reset}
          className="rounded-md border px-3 py-1.5 text-sm"
          data-testid="email-template-reset"
        >
          {t('emailTemplates.reset')}
        </button>
      </div>
    </div>
  );
}
