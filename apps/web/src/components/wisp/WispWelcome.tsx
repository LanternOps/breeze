import { useTranslation } from 'react-i18next';
import type { WispBriefSchedule, WispFirstLookProgress, WispFirstLookState } from '@breeze/shared';

type SuggestionKey = 'needsMe' | 'offline' | 'sweep' | 'overnight';

const SUGGESTIONS: readonly SuggestionKey[] = ['needsMe', 'offline', 'sweep', 'overnight'];

export default function WispWelcome({
  scopeLabel,
  onSuggest,
  intro = true,
  briefNote = true,
  firstLookState = 'looking',
  firstLookProgress = null,
  briefSchedule = null,
}: {
  scopeLabel: string;
  onSuggest: (prompt: string) => void;
  /** False when a brief is already in the thread: "your first brief arrives" would contradict it, so only the chips show. */
  intro?: boolean;
  /**
   * False on a chat surface (side panel, /ai/chat tab): a new conversation in a
   * thread that may already have briefs only greets; "your first brief arrives"
   * is the home's first-visit line (#10195).
   */
  briefNote?: boolean;
  /**
   * `done`: the first-look post exists (#10402), so "looking around" and "once I
   * have had a look" are over. `couldnt_look`: only the post saying no org could
   * be looked at exists (#11145), so neither that nor "first look" is true.
   */
  firstLookState?: WispFirstLookState;
  /** "N of M orgs looked at" while looking (#11146); only the home has it. */
  firstLookProgress?: WispFirstLookProgress | null;
  /** When and where the brief goes out; null on surfaces with no home payload. */
  briefSchedule?: WispBriefSchedule | null;
}) {
  const { t } = useTranslation('ai');
  const firstLook = firstLookState === 'done';
  const couldntLook = firstLookState === 'couldnt_look';
  const progress = firstLookState === 'looking' ? firstLookProgress : null;
  const title = firstLook ? 'firstLookTitle' : couldntLook ? 'couldntLookTitle' : 'title';

  return (
    <div data-testid="wisp-welcome" className="space-y-2">
      {intro && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">{t('wisp.title')}</p>
          <p className="text-sm">{t(/* i18n-dynamic */ `wisp.welcome.${title}`, { scope: scopeLabel })}</p>
          {couldntLook ? (
            <p data-testid="wisp-welcome-couldnt-look" className="mt-1 text-sm">
              {briefNote ? t('wisp.welcome.couldntLookBody') : t('wisp.welcome.couldntLookChat')}
            </p>
          ) : briefNote && (
            <p className="mt-1 text-sm">{firstLook ? t('wisp.welcome.firstLookBody') : t('wisp.welcome.body')}</p>
          )}
          {progress && (
            <p data-testid="wisp-welcome-progress" role="status" className="mt-1 text-sm text-muted-foreground">
              <span data-testid="wisp-welcome-progress-looked">
                {t('wisp.welcome.progress', { count: progress.totalOrgs, lookedAt: progress.lookedAtOrgs })}
              </span>
              {progress.queuedOrgs > 0 && (
                <span data-testid="wisp-welcome-progress-queued">
                  {' · '}{t('wisp.welcome.progressQueued', { count: progress.queuedOrgs })}
                </span>
              )}
              {progress.failedOrgs > 0 && (
                <span data-testid="wisp-welcome-progress-failed">
                  {' · '}{t('wisp.welcome.progressFailed', { count: progress.failedOrgs })}
                </span>
              )}
            </p>
          )}
          {briefNote && briefSchedule?.timeLocal && (
            <p data-testid="wisp-welcome-brief-at" className="mt-1 text-sm text-muted-foreground">
              {t('wisp.welcome.briefAt', { time: briefSchedule.timeLocal, timezone: briefSchedule.timezone })}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {SUGGESTIONS.map((key) => (
          <button
            key={key}
            type="button"
            data-testid="wisp-suggestion"
            className="rounded-full border px-3 py-1 text-xs hover:bg-muted"
            onClick={() => onSuggest(t(/* i18n-dynamic */ `wisp.welcome.suggestions.${key}.prompt`, { scope: scopeLabel }))}
          >
            {t(/* i18n-dynamic */ `wisp.welcome.suggestions.${key}.label`)}
          </button>
        ))}
      </div>
    </div>
  );
}
