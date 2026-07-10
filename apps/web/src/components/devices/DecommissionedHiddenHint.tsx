// Discoverability hint (#2251): decommissioned devices are hidden from the
// Devices page by default, and nothing on the page used to say so — the only
// unhide mechanism was knowing the status filter has a "Decommissioned"
// option. This renders a lightweight "N decommissioned hidden — show" line
// next to the device count (list view) / above the grid (grid view), where
// "show" applies the existing Decommissioned status filter upstream. Callers
// gate rendering on the hidden count being non-zero and on decommissioned
// devices not already being visible.
export default function DecommissionedHiddenHint({
  count,
  onShow,
}: {
  count: number;
  onShow: () => void;
}) {
  if (count <= 0) return null;
  return (
    <span
      data-testid="decommissioned-hidden-hint"
      className="text-sm text-muted-foreground"
    >
      {count} decommissioned hidden
      {' — '}
      <button
        type="button"
        data-testid="decommissioned-hidden-show"
        onClick={onShow}
        className="underline underline-offset-2 transition hover:text-foreground"
      >
        show
      </button>
    </span>
  );
}
