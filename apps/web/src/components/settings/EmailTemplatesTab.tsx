import { useCallback, useEffect, useState } from 'react';
import {
  EMAIL_TEMPLATE_IDS,
  emailTemplateLabel,
  type EmailTemplateId,
} from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import EmailTemplateEditor, { type EmailTemplateOverride } from './EmailTemplateEditor';

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

type TemplatesMap = Partial<Record<EmailTemplateId, EmailTemplateOverride>>;

const AUTOPAY_TEMPLATE_IDS=new Set<EmailTemplateId>(['autopay_request','autopay_enrolled','autopay_stopped', 'autopay_paused', 'autopay_resumed','card_expiring']);
const BILLING_TEMPLATE_IDS=new Set<EmailTemplateId>(['quote_send','invoice_send',...AUTOPAY_TEMPLATE_IDS]);
BILLING_TEMPLATE_IDS.add('payment_reminder');
BILLING_TEMPLATE_IDS.add('invoice_autopay');
BILLING_TEMPLATE_IDS.add('payment_overdue');
BILLING_TEMPLATE_IDS.add('payment_receipt');
BILLING_TEMPLATE_IDS.add('payment_failed');

function asOverride(row: unknown): EmailTemplateOverride | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const r = row as Record<string, unknown>;
  return {
    subject: typeof r.subject === 'string' ? r.subject : null,
    heading: typeof r.heading === 'string' ? r.heading : null,
    buttonLabel: typeof r.buttonLabel === 'string' ? r.buttonLabel : null,
    html: typeof r.html === 'string' ? r.html : null,
  };
}

function isCustom(row: EmailTemplateOverride | undefined): boolean {
  if (!row) return false;
  return row.subject != null || row.heading != null || row.buttonLabel != null || row.html != null;
}

function readTemplates(settings: unknown): TemplatesMap {
  if (!settings || typeof settings !== 'object') return {};
  const raw = (settings as { emailTemplates?: unknown }).emailTemplates;
  if (!raw || typeof raw !== 'object') return {};
  const bag = raw as Record<string, unknown>;
  const out: TemplatesMap = {};
  for (const id of EMAIL_TEMPLATE_IDS) {
    const parsed = asOverride(bag[id]);
    if (parsed) out[id] = parsed;
  }
  return out;
}

export default function EmailTemplatesTab() {
  const { t } = useTranslation('settings');
  const { t: tBilling } = useTranslation('billing');
  const [templates, setTemplates] = useState<TemplatesMap>({});
  const [selectedId, setSelectedId] = useState<EmailTemplateId | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetchWithAuth('/orgs/partners/me');
      if (res.status === 401) {
        UNAUTHORIZED();
        return;
      }
      if (!res.ok) {
        setError(true);
        return;
      }
      const partner = (await res.json()) as { settings?: unknown };
      setTemplates(readTemplates(partner.settings));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="email-templates-loading">
        {t('common:states.loading')}
      </p>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="email-templates-error">
        {t('emailTemplates.loadFailed')}{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">
          {t('common:actions.retry')}
        </button>
      </p>
    );
  }

  if (selectedId) {
    return (
      <EmailTemplateEditor
        templateId={selectedId}
        value={templates[selectedId]}
        onBack={() => setSelectedId(null)}
        onSaved={(next) => setTemplates((prev) => ({ ...prev, [selectedId]: next }))}
      />
    );
  }

  return (
    <div className="max-w-3xl space-y-4" data-testid="email-templates-tab">
      <div>
        <h2 className="text-sm font-semibold">{t('emailTemplates.title')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('emailTemplates.description')}</p>
      </div>
      <div className="space-y-4" data-testid="email-templates-list">
        {[
          {billing:false,ids:EMAIL_TEMPLATE_IDS.filter(id=>!BILLING_TEMPLATE_IDS.has(id))},
          {billing:true,ids:EMAIL_TEMPLATE_IDS.filter(id=>BILLING_TEMPLATE_IDS.has(id))},
        ].map(group=>(
          <section key={String(group.billing)} data-testid={group.billing?'autopay-email-template-group':'email-template-other-group'}>
            <h3 className="mb-2 text-sm font-semibold">
              {group.billing?t('emailTemplates.billingPayments'):t('emailTemplates.supportPortal')}
            </h3>
            <ul className="divide-y rounded-lg border">
              {group.ids.map(id=>(
                <li key={id}>
                  <button type="button" onClick={()=>setSelectedId(id)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/40"
                    data-testid={AUTOPAY_TEMPLATE_IDS.has(id)?`autopay-email-template-${id}`:id === 'payment_reminder' || id === 'payment_overdue' ? `autopay-template-${id}` : `email-template-row-${id}`}>
                    <span className="text-sm font-medium">
                      {AUTOPAY_TEMPLATE_IDS.has(id)?t(/* i18n-dynamic */ `emailTemplates.labels.${id}`):id === 'payment_reminder' ? tBilling('reminders.templates.paymentReminder')
                        :id === 'payment_overdue' ? tBilling('reminders.templates.paymentOverdue')
                        :id === 'invoice_autopay' ? tBilling('autopay.noticeTemplate') : t(/* i18n-dynamic */ `emailTemplates.labels.${id}`, { defaultValue: emailTemplateLabel(id) })}
                    </span>
                    <span className="text-xs text-muted-foreground" data-testid={`email-template-status-${id}`}>
                      {isCustom(templates[id])?t('emailTemplates.custom'):t('emailTemplates.usingDefault')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
