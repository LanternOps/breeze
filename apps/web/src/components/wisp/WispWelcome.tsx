import { useTranslation } from 'react-i18next';

type SuggestionKey = 'needsMe' | 'offline' | 'sweep' | 'overnight';

const SUGGESTIONS: readonly SuggestionKey[] = ['needsMe', 'offline', 'sweep', 'overnight'];

export default function WispWelcome({
  scopeLabel,
  onSuggest,
}: {
  scopeLabel: string;
  onSuggest: (prompt: string) => void;
}) {
  const { t } = useTranslation('ai');

  return (
    <div data-testid="wisp-welcome" className="space-y-2">
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">{t('wisp.name')}</p>
        <p className="text-sm">{t('wisp.welcome.title', { scope: scopeLabel })}</p>
        <p className="mt-1 text-sm">{t('wisp.welcome.body')}</p>
      </div>
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
