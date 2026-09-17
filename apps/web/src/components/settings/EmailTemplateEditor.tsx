import { useEffect, useMemo, useState } from 'react';
import {
  emailTemplateFieldDefaults,
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
  quote_number: 'Q-2026-0001',
  total: '$1,200.00',
  expiry_date: '2026-07-01',
  accept_url: 'https://portal.example.com/quote/TOKEN',
  invoice_number: 'INV-0001',
  due_date: '2026-09-01',
  invite_url: 'https://portal.example.com/accept-invite?token=abc',
  cta_button: 'Button',
};

/** Same tags as apps/api/src/services/richTextSanitize.ts RICH_TEXT_ALLOWED_TAGS. */
const PREVIEW_ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'em', 'u', 'h3', 'h4', 'ul', 'ol', 'li', 'a',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
]);
const PREVIEW_DISCARD_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'base', 'form', 'link', 'meta', 'svg',
]);

function isSafePreviewHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.startsWith('//')) return false;
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):/i)?.[1];
  if (!scheme) return true;
  return scheme.toLowerCase() === 'http' || scheme.toLowerCase() === 'https';
}

function isBlankHtml(html: string): boolean {
  const trimmed = html.trim();
  return trimmed === '' || trimmed === '<p></p>' || trimmed === '<p><br></p>';
}

function shownFields(templateId: EmailTemplateId, stored: EmailTemplateOverride | undefined) {
  const defaults = emailTemplateFieldDefaults(templateId);
  const pick = (value: string | null | undefined, fallback: string, html = false) => {
    if (value == null) return fallback;
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    if (html && isBlankHtml(trimmed)) return fallback;
    return value;
  };
  return {
    subject: pick(stored?.subject, defaults.subject),
    heading: pick(stored?.heading, defaults.heading),
    buttonLabel: pick(stored?.buttonLabel, defaults.buttonLabel),
    html: pick(stored?.html, defaults.html, true),
  };
}

function storedFromForm(
  templateId: EmailTemplateId,
  form: { subject: string; heading: string; buttonLabel: string; html: string },
  hasCta: boolean,
): EmailTemplateOverride {
  const defaults = emailTemplateFieldDefaults(templateId);
  const nullIfDefault = (value: string, fallback: string, html = false) => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (html && isBlankHtml(trimmed)) return null;
    if (trimmed === fallback.trim()) return null;
    return value;
  };
  return {
    subject: nullIfDefault(form.subject, defaults.subject),
    heading: nullIfDefault(form.heading, defaults.heading),
    buttonLabel: hasCta ? nullIfDefault(form.buttonLabel, defaults.buttonLabel) : null,
    html: nullIfDefault(form.html, defaults.html, true),
  };
}

function previewSafeHtml(html: string): string {
  const filled = renderTemplate(html, SAMPLE_VARS as TicketTemplateVars);
  if (typeof DOMParser === 'undefined') return filled;
  const doc = new DOMParser().parseFromString(filled, 'text/html');
  const sanitizeNode = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType !== 1) continue;
      const el = child as HTMLElement;
      const tag = el.tagName.toLowerCase();
      sanitizeNode(el);
      if (PREVIEW_DISCARD_TAGS.has(tag)) {
        el.remove();
        continue;
      }
      if (!PREVIEW_ALLOWED_TAGS.has(tag)) {
        el.replaceWith(...el.childNodes);
        continue;
      }
      for (const attr of [...el.attributes]) {
        if (tag === 'a' && attr.name === 'href' && isSafePreviewHref(attr.value)) continue;
        el.removeAttribute(attr.name);
      }
    }
  };
  sanitizeNode(doc.body);
  return doc.body.innerHTML;
}

function overrideFromPartnerResponse(data: unknown, id: EmailTemplateId): EmailTemplateOverride | null {
  if (!data || typeof data !== 'object') return null;
  const settings = (data as { settings?: unknown }).settings;
  if (!settings || typeof settings !== 'object') return null;
  const bag = (settings as { emailTemplates?: unknown }).emailTemplates;
  if (!bag || typeof bag !== 'object') return null;
  const raw = (bag as Record<string, unknown>)[id];
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    subject: typeof o.subject === 'string' ? o.subject : null,
    heading: typeof o.heading === 'string' ? o.heading : null,
    buttonLabel: typeof o.buttonLabel === 'string' ? o.buttonLabel : null,
    html: typeof o.html === 'string' ? o.html : null,
  };
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
  const initial = shownFields(templateId, value);
  const [subject, setSubject] = useState(initial.subject);
  const [heading, setHeading] = useState(initial.heading);
  const [buttonLabel, setButtonLabel] = useState(initial.buttonLabel);
  const [html, setHtml] = useState(initial.html);
  const [saving, setSaving] = useState(false);

  const applyStored = (stored: EmailTemplateOverride | undefined) => {
    const next = shownFields(templateId, stored);
    setSubject(next.subject);
    setHeading(next.heading);
    setButtonLabel(next.buttonLabel);
    setHtml(next.html);
  };

  useEffect(() => {
    applyStored(value);
  }, [templateId, value]);

  const preview = useMemo(() => previewSafeHtml(html), [html]);

  const persist = async (fields: EmailTemplateOverride) => {
    setSaving(true);
    try {
      const saved = await runAction({
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
      const stored = overrideFromPartnerResponse(saved, templateId) ?? fields;
      onSaved(stored);
      applyStored(stored);
    } catch (err) {
      handleActionError(err, t('emailTemplates.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const save = () =>
    void persist(storedFromForm(templateId, { subject, heading, buttonLabel, html }, hasCta));

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
