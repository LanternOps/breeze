import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { Dialog } from "../../shared/Dialog";

export interface MatchReviewItem {
  key: string;
  externalName: string;
  targetLabel: string;
  tier: "exact" | "normalized";
  matchKey: string;
}
export interface MatchReviewBlockedItem {
  key: string;
  externalName: string;
  reason: "ambiguous" | "contested" | "pick_site";
}

export function SuggestedMatchReviewModal(p: {
  open: boolean;
  items: MatchReviewItem[];
  blocked: MatchReviewBlockedItem[];
  onConfirm: (keys: string[]) => Promise<void>;
  onClose: () => void;
  testIdPrefix: string;
}) {
  const { t } = useTranslation("integrations");
  const { open, items, blocked, onConfirm, onClose, testIdPrefix } = p;
  const [checked, setChecked] = useState<Set<string>>(() => new Set(items.map((i) => i.key)));
  const [pending, setPending] = useState(false);
  const titleId = useId();

  // Reset to "all checked" on open and whenever the caller reloads the list.
  useEffect(() => {
    if (open) setChecked(new Set(items.map((i) => i.key)));
  }, [open, items]);

  if (!open) return null;

  const selected = items.filter((i) => checked.has(i.key)).map((i) => i.key);
  const count = selected.length;

  const toggle = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const confirm = async () => {
    if (pending || count === 0) return;
    setPending(true);
    try {
      await onConfirm(selected);
    } catch {
      // The caller owns error handling and open state; just re-enable.
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("externalMatch.reviewTitle")}
      labelledBy={titleId}
      maxWidth="2xl"
      className="flex max-h-[90vh] flex-col p-6"
    >
      <div data-testid={`${testIdPrefix}-review-modal`} className="flex min-h-0 flex-1 flex-col">
        <h3 id={titleId} className="text-lg font-semibold">{t("externalMatch.reviewTitle")}</h3>

        <ul className="mt-4 flex-1 divide-y overflow-y-auto text-sm">
          {items.map((i) => (
            <li key={i.key} className="py-2">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  data-testid={`${testIdPrefix}-review-item-${i.key}`}
                  checked={checked.has(i.key)}
                  onChange={() => toggle(i.key)}
                  className="mt-1"
                />
                <span className="min-w-0">
                  <span className="font-medium">
                    {i.externalName} → {i.targetLabel}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {i.tier === "exact" ? t("externalMatch.tierExact") : t("externalMatch.tierNormalized")}
                    {" · "}
                    {t("externalMatch.matchedOn", { key: i.matchKey })}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>

        {blocked.length > 0 && (
          <div className="mt-4 rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium">{t("externalMatch.resolveInTable")}</p>
            <ul className="mt-1 space-y-1 text-muted-foreground">
              {blocked.map((b) => (
                <li key={b.key} data-testid={`${testIdPrefix}-review-blocked-${b.key}`} data-reason={b.reason}>
                  {b.externalName}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            data-testid={`${testIdPrefix}-review-cancel`}
            onClick={onClose}
            className="h-9 rounded-md border px-4 text-sm font-medium hover:bg-muted"
          >
            {t("common:actions.cancel")}
          </button>
          <button
            type="button"
            data-testid={`${testIdPrefix}-review-confirm`}
            disabled={count === 0 || pending}
            onClick={() => void confirm()}
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {t("externalMatch.confirm", { count })}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
