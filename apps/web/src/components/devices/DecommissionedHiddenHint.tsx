// Discoverability hint (#2251): decommissioned devices are hidden from the
// Devices page by default, and nothing on the page used to say so — the only
// unhide mechanism was knowing the status filter has a "Removed" option.
// This renders a lightweight "N removed hidden — show" line next to the
// device count (list view) / above the grid (grid view), where "show"
// applies the existing decommissioned status filter upstream. The upstream
// count memos return 0 when decommissioned devices are already visible
// (includeDecommissioned), and the component renders nothing for count <= 0
// — so it self-dismisses once the rows are shown.
import { useTranslation } from 'react-i18next';

export default function DecommissionedHiddenHint({
  count,
  onShow,
}: {
  count: number;
  onShow: () => void;
}) {
  const { t } = useTranslation('devices');
  if (count <= 0) return null;
  return (
    <span
      data-testid="decommissioned-hidden-hint"
      className="text-sm text-muted-foreground"
    >
      {t('decommissionedHiddenHint.label', { count })}
      {' — '}
      <button
        type="button"
        data-testid="decommissioned-hidden-show"
        onClick={onShow}
        className="underline underline-offset-2 transition hover:text-foreground"
      >
        {t('decommissionedHiddenHint.show')}
      </button>
    </span>
  );
}
