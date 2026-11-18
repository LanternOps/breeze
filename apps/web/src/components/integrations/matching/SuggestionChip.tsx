import { useTranslation } from "react-i18next";
import "@/lib/i18n";

export function SuggestionChip(p: {
  label: string;
  detail?: string;
  onAccept?: () => void;
  disabled?: boolean;
  testId: string;
}) {
  const { t } = useTranslation("integrations");
  return (
    <span
      data-testid={p.testId}
      className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-0.5 text-xs"
    >
      <span className="font-medium">{p.label}</span>
      {p.detail && <span className="text-muted-foreground">{p.detail}</span>}
      {p.onAccept && (
        <button
          type="button"
          data-testid={`${p.testId}-accept`}
          disabled={p.disabled}
          onClick={p.onAccept}
          className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {t("externalMatch.accept")}
        </button>
      )}
    </span>
  );
}
