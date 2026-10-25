import { useTranslation } from 'react-i18next';

/** The Wisp home's sections (W08 Task 9 composes them here). */
export default function WispHomeContent() {
  const { t } = useTranslation('pages');
  return (
    <div className="mx-auto max-w-6xl p-4" data-testid="wisp-home">
      <h1 className="text-lg font-semibold">{t('titles.wisp')}</h1>
    </div>
  );
}
