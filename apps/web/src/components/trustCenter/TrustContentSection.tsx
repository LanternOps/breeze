import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TRUST_INTRO_MAX_CHARS } from '@breeze/shared';
import RichTextEditor from '@/components/common/RichTextEditor';
import { updateTrustPage, type TrustSectionProps } from '@/lib/api/trustPage';
import { handleActionError, runAction } from '@/lib/runAction';
import { InheritanceBadge } from './trustInheritance';

/** Where the page's intro comes from: inherited (null), explicitly none (''), or its own HTML. */
type IntroMode = 'template' | 'none' | 'custom';
const INTRO_MODES: IntroMode[] = ['template', 'none', 'custom'];

function introModeOf(pageIntro: string | null): IntroMode {
  if (pageIntro === null) return 'template';
  return pageIntro === '' ? 'none' : 'custom';
}

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
  // reload, which must not clobber unsaved edits here. The mode follows the page's OWN column (null = inherit,
  // '' = no intro); "Custom" starts from the effective intro so a publisher can edit the inherited one (W02g).
  const [mode, setMode] = useState<IntroMode>(introModeOf(page.introHtml));
  const [intro, setIntro] = useState(state.effective.values.introHtml ?? '');
  const introSource = state.effective.sources.introHtml;
  const inheritedIntro = introSource === 'page' ? null : state.effective.values.introHtml;
  const [email, setEmail] = useState(page.securityContactEmail ?? '');
  const [website, setWebsite] = useState(page.websiteUrl ?? '');
  const [busy, setBusy] = useState(false);

  const emailTrim = email.trim();
  const websiteTrim = website.trim();
  const emailInvalid = emailTrim !== '' && !EMAIL_RE.test(emailTrim);
  const websiteInvalid = websiteTrim !== '' && !isHttpsUrl(websiteTrim);
  const introLength = intro.length;
  const introTooLong = mode === 'custom' && introLength > TRUST_INTRO_MAX_CHARS;
  const invalid = emailInvalid || websiteInvalid || introTooLong;

  const save = async () => {
    if (!canWrite || invalid) return;
    setBusy(true);
    try {
      await runAction({
        request: () => updateTrustPage(orgFetch, orgId, {
          // "Use the partner template intro" = null (inherit). "No intro" and an emptied custom editor are the
          // page's explicit '' — never null, which would let a template intro reappear on a page that cleared it.
          introHtml: mode === 'template' ? null : mode === 'none' || isEmptyHtml(intro) ? '' : intro,
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
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium" id="trust-content-intro-label">{tr('content.introLabel')}</span>
          <InheritanceBadge source={introSource} testId="trust-inheritance-introHtml" />
        </div>
        <div role="radiogroup" aria-labelledby="trust-content-intro-label" className="mb-2 flex flex-wrap gap-3 text-sm">
          {INTRO_MODES.map((m) => (
            <label key={m} className="inline-flex items-center gap-1.5">
              <input
                type="radio"
                name="trust-content-intro-mode"
                value={m}
                checked={mode === m}
                disabled={!canWrite}
                onChange={() => setMode(m)}
                data-testid={`trust-content-intro-mode-${m}`}
              />
              {tr(`inheritance.intro.${m}`)}
            </label>
          ))}
        </div>
        {mode === 'template' && (inheritedIntro ? (
          // The inherited intro, read-only: `inert` keeps the editor out of focus and typing.
          <div className="opacity-70" inert data-testid="trust-content-intro-inherited-wrap">
            <RichTextEditor value={inheritedIntro} onChange={() => {}} ariaLabel={tr('content.introLabel')} testId="trust-content-intro-inherited" />
          </div>
        ) : introSource !== 'page' ? (
          <p className="text-xs text-muted-foreground" data-testid="trust-content-intro-inherited-empty">{tr('inheritance.intro.inheritedEmpty')}</p>
        ) : null)}
        {mode === 'custom' && (
          <>
            <RichTextEditor value={intro} onChange={setIntro} ariaLabel={tr('content.introLabel')} testId="trust-content-intro" />
            <div
              className={`mt-1 text-xs ${introLength > TRUST_INTRO_MAX_CHARS ? 'text-destructive' : 'text-muted-foreground'}`}
              data-testid="trust-content-counter"
            >
              {introLength.toLocaleString('en-US')} / {TRUST_INTRO_MAX_CHARS.toLocaleString('en-US')}
            </div>
            {introTooLong && <p className="mt-1 text-xs text-destructive" data-testid="trust-content-intro-error">{tr('errors.introTooLong')}</p>}
          </>
        )}
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
