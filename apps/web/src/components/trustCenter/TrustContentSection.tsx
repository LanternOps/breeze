import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TRUST_INTRO_MAX_CHARS } from '@breeze/shared';
import RichTextEditor from '@/components/common/RichTextEditor';
import { updateTrustPage, type TrustSectionProps } from '@/lib/api/trustPage';
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

export default function TrustContentSection({ orgId, orgFetch, state, canWrite, onReload }: TrustSectionProps) {
  const page = state.page;
  const { t } = useTranslation('organizations');
  const tr = useCallback(
    (key: string, vars?: Record<string, unknown>) => t(/* i18n-dynamic */ `orgRecord.trust.${key}`, vars ?? {}),
    [t],
  );
  // Seeded once from the server page: other sections bump the revision and
  // reload, which must not clobber unsaved edits here. The intro shows the EFFECTIVE value (it may come
  // from the partner template, W02g); saving writes it as the page's own value.
  const [intro, setIntro] = useState(state.effective.values.introHtml ?? '');
  const [email, setEmail] = useState(page.securityContactEmail ?? '');
  const [website, setWebsite] = useState(page.websiteUrl ?? '');
  const [busy, setBusy] = useState(false);

  const emailTrim = email.trim();
  const websiteTrim = website.trim();
  const emailInvalid = emailTrim !== '' && !EMAIL_RE.test(emailTrim);
  const websiteInvalid = websiteTrim !== '' && !isHttpsUrl(websiteTrim);
  const introLength = intro.length;
  const introTooLong = introLength > TRUST_INTRO_MAX_CHARS;
  const invalid = emailInvalid || websiteInvalid || introTooLong;

  const save = async () => {
    if (!canWrite || invalid) return;
    setBusy(true);
    try {
      await runAction({
        request: () => updateTrustPage(orgFetch, orgId, {
          // An emptied editor is the page's explicit "no intro" (''), not "inherit" (null): null would let a
          // partner template's intro reappear on a page whose publisher cleared it.
          introHtml: isEmptyHtml(intro) ? '' : intro,
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

      {/* `inert` removes the editor from focus/typing; pointer-events alone would not. */}
      <div className={canWrite ? '' : 'opacity-60'} aria-disabled={!canWrite} inert={!canWrite} data-testid="trust-content-intro-wrap">
        <div className="mb-1 text-sm font-medium">{tr('content.introLabel')}</div>
        <RichTextEditor value={intro} onChange={setIntro} ariaLabel={tr('content.introLabel')} testId="trust-content-intro" />
        <div
          className={`mt-1 text-xs ${introLength > TRUST_INTRO_MAX_CHARS ? 'text-destructive' : 'text-muted-foreground'}`}
          data-testid="trust-content-counter"
        >
          {introLength.toLocaleString('en-US')} / {TRUST_INTRO_MAX_CHARS.toLocaleString('en-US')}
        </div>
        {introTooLong && <p className="mt-1 text-xs text-destructive" data-testid="trust-content-intro-error">{tr('errors.introTooLong')}</p>}
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
