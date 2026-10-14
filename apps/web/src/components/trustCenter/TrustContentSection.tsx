import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TRUST_INTRO_MAX_CHARS } from '@breeze/shared';
import RichTextEditor from '@/components/common/RichTextEditor';
import type { OrgFetch } from '@/components/organizations/record/orgRecordFetch';
import { updateTrustPage, type TrustPageDraft } from '@/lib/api/trustPage';
import { handleActionError, runAction } from '@/lib/runAction';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isHttpsUrl(v: string): boolean {
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The editor emits `<p></p>` for an empty document; that is "no intro". */
function isEmptyHtml(html: string): boolean {
  return html.replace(/<[^>]*>/g, '').trim() === '' && !/<(img|table|hr)\b/i.test(html);
}

interface Props {
  orgId: string;
  orgFetch: OrgFetch;
  page: TrustPageDraft;
  canWrite: boolean;
  onReload: () => Promise<void>;
}

export default function TrustContentSection({ orgId, orgFetch, page, canWrite, onReload }: Props) {
  const { t } = useTranslation('organizations');
  const tr = useCallback(
    (key: string, vars?: Record<string, unknown>) => t(/* i18n-dynamic */ `orgRecord.trust.${key}`, vars ?? {}),
    [t],
  );
  // Seeded once from the server page: other sections bump the revision and
  // reload, which must not clobber unsaved edits here.
  const [intro, setIntro] = useState(page.introHtml ?? '');
  const [email, setEmail] = useState(page.securityContactEmail ?? '');
  const [website, setWebsite] = useState(page.websiteUrl ?? '');
  const [busy, setBusy] = useState(false);

  const emailTrim = email.trim();
  const websiteTrim = website.trim();
  const emailInvalid = emailTrim !== '' && !EMAIL_RE.test(emailTrim);
  const websiteInvalid = websiteTrim !== '' && !isHttpsUrl(websiteTrim);
  const introLength = intro.length;
  const invalid = emailInvalid || websiteInvalid;

  const save = async () => {
    if (!canWrite || invalid) return;
    setBusy(true);
    try {
      await runAction({
        request: () => updateTrustPage(orgFetch, orgId, {
          introHtml: isEmptyHtml(intro) ? null : intro,
          securityContactEmail: emailTrim === '' ? null : emailTrim,
          websiteUrl: websiteTrim === '' ? null : websiteTrim,
        }),
        successMessage: tr('content.saved'),
        errorFallback: tr('content.saveFailed'),
        friendly: (code) => ({ INTRO_TOO_LONG: tr('errors.introTooLong') } as Record<string, string>)[code],
      });
      await onReload();
    } catch (err) {
      handleActionError(err, tr('content.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" data-testid="trust-content-section">
      <h3 className="text-base font-semibold">{tr('sections.contentHeading')}</h3>

      <div className={canWrite ? '' : 'pointer-events-none opacity-60'} aria-disabled={!canWrite}>
        <div className="mb-1 text-sm font-medium">{tr('content.introLabel')}</div>
        <RichTextEditor value={intro} onChange={setIntro} ariaLabel={tr('content.introLabel')} testId="trust-content-intro" />
        <div
          className={`mt-1 text-xs ${introLength > TRUST_INTRO_MAX_CHARS ? 'text-destructive' : 'text-muted-foreground'}`}
          data-testid="trust-content-counter"
        >
          {introLength.toLocaleString('en-US')} / {TRUST_INTRO_MAX_CHARS.toLocaleString('en-US')}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium">{tr('content.contactLabel')}</span>
          <input
            type="email"
            value={email}
            disabled={!canWrite}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 disabled:opacity-60"
            data-testid="trust-content-contact"
          />
          {emailInvalid && <span className="text-xs text-destructive" data-testid="trust-content-contact-error">{tr('content.contactInvalid')}</span>}
        </label>
        <label className="block text-sm">
          <span className="font-medium">{tr('content.websiteLabel')}</span>
          <input
            type="url"
            value={website}
            disabled={!canWrite}
            placeholder="https://"
            onChange={(e) => setWebsite(e.target.value)}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 disabled:opacity-60"
            data-testid="trust-content-website"
          />
          {websiteInvalid && <span className="text-xs text-destructive" data-testid="trust-content-website-error">{tr('content.websiteInvalid')}</span>}
        </label>
      </div>

      <button
        type="button"
        disabled={!canWrite || invalid || busy}
        onClick={() => void save()}
        className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="trust-content-save"
      >
        {tr('content.save')}
      </button>
    </section>
  );
}
