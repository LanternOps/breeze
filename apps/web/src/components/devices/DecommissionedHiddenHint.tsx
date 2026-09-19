// Discoverability hint (#2251): decommissioned devices are hidden from the
// Devices page by default, and nothing on the page used to say so — the only
// unhide mechanism was knowing the status filter has a "Removed" option.
// This renders a lightweight "N removed hidden — show" line next to the
// device count (list view) / above the grid (grid view). "show" flips a
// page-level showRemoved flag upstream, which ADDS the removed rows to
// whatever is on screen (#5023 paper cut: it used to swap the view to a
// removed-only status filter). Once the rows are visible the same slot
// renders the mirror line, "N removed shown — hide", so the default view is
// one click away again. The component renders nothing for count <= 0.
import { useTranslation } from 'react-i18next';

type Props =
  | { mode?: 'hidden'; count: number; onShow: () => void; onHide?: never }
  | { mode: 'shown'; count: number; onHide: () => void; onShow?: never };

export default function DecommissionedHiddenHint(props: Props) {
  const { t } = useTranslation('devices');
  if (props.count <= 0) return null;
  const shown = props.mode === 'shown';
  return (
    <span
      data-testid={shown ? 'decommissioned-shown-hint' : 'decommissioned-hidden-hint'}
      className="text-sm text-muted-foreground"
    >
      {shown
        ? t('decommissionedHiddenHint.shownLabel', { count: props.count })
        : t('decommissionedHiddenHint.label', { count: props.count })}
      {' — '}
      <button
        type="button"
        data-testid={shown ? 'decommissioned-hidden-hide' : 'decommissioned-hidden-show'}
        onClick={shown ? props.onHide : props.onShow}
        className="underline underline-offset-2 transition hover:text-foreground"
      >
        {shown ? t('decommissionedHiddenHint.hide') : t('decommissionedHiddenHint.show')}
      </button>
    </span>
  );
}
