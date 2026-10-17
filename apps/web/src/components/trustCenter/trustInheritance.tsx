// Owner: W02g (#8770). The org editor's inheritance UI (settings rule 4: "blank = inherit; the field always
// shows the inherited value and where it comes from"). A trust page setting resolves page → partner template →
// Breeze default (`resolveEffectiveTrustSettings`); `state.effective.sources` says which level supplied each.
import { useTranslation } from 'react-i18next';
import type { TrustSettingKey, TrustSettingSource } from '@breeze/shared';

const SOURCE_KEY: Record<TrustSettingSource, string> = {
  page: 'orgRecord.trust.inheritance.sources.page',
  template: 'orgRecord.trust.inheritance.sources.template',
  default: 'orgRecord.trust.inheritance.sources.default',
};

const SOURCE_CLASS: Record<TrustSettingSource, string> = {
  page: 'border-primary/40 bg-primary/10 text-primary',
  template: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  default: 'border-border bg-muted text-muted-foreground',
};

/** The PUT /trust-page patch that drops the page's own value, so the setting inherits again. */
export function resetToInherited<K extends TrustSettingKey>(key: K): { [P in K]: null } {
  return { [key]: null } as { [P in K]: null };
}

/** An optimistic local edit is the page's own value until the reload confirms it. */
export function sourceAfterLocalEdit(source: TrustSettingSource, editedLocally: boolean): TrustSettingSource {
  return editedLocally ? 'page' : source;
}

export function InheritanceBadge({ source, testId }: { source: TrustSettingSource; testId: string }) {
  const { t } = useTranslation('organizations');
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${SOURCE_CLASS[source]}`}
      data-testid={testId}
      data-source={source}
    >
      {t(/* i18n-dynamic */ SOURCE_KEY[source])}
    </span>
  );
}

/** Shown only when the page set the value itself; clicking sends `null` for that key (the caller saves). */
export function ResetToInheritedButton({ source, disabled, onReset, testId }: {
  source: TrustSettingSource; disabled: boolean; onReset: () => void; testId: string;
}) {
  const { t } = useTranslation('organizations');
  if (source !== 'page') return null;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onReset}
      className="text-[11px] text-primary underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
      data-testid={testId}
    >
      {t('orgRecord.trust.inheritance.reset')}
    </button>
  );
}
