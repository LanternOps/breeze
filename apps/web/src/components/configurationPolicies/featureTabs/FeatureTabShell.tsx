import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, Trash2, RotateCcw, PenLine } from "lucide-react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
type FeatureTabShellProps = {
  title: string;
  description: string;
  icon: ReactNode;
  isConfigured: boolean;
  /**
   * When the tab is configured (a feature link exists) but the feature is not
   * actually being deployed/enabled, pass true so the badge reflects "saved but
   * inactive" instead of a green "Configured". Optional; does not affect the
   * Remove control, which still keys off isConfigured (#1863).
   */
  configuredButInactive?: boolean;
  saving: boolean;
  /**
   * When true, the Save (and Override) button is disabled independent of the
   * saving state — used by tabs with client-side validation (e.g. an invalid
   * library targeting row) to block a save the server would 400 on anyway.
   */
  saveDisabled?: boolean;
  /** data-testid for the Save button, for tabs whose tests or E2E need to target it. */
  saveTestId?: string;
  error?: string;
  /** May be async; the shell reveals any validation error once it settles. */
  onSave: () => void | Promise<unknown>;
  onRemove?: () => void;
  /** True when this tab is showing inherited settings from a parent policy */
  isInherited?: boolean;
  /** Called when user clicks "Override" on an inherited tab */
  onOverride?: () => void;
  /** Called when user clicks "Revert to Parent" on an overridden tab */
  onRevert?: () => void;
  children: ReactNode;
};
export default function FeatureTabShell({
  title,
  description,
  icon,
  isConfigured,
  configuredButInactive,
  saving,
  saveDisabled,
  saveTestId,
  error,
  onSave,
  onRemove,
  isInherited,
  onOverride,
  onRevert,
  children,
}: FeatureTabShellProps) {
  useTranslation("policies");
  // #5314: Revert to Parent and Remove both fire an irreversible
  // DELETE .../features/:id that destroys this policy's override. The shell
  // renders the footer for every feature tab, so guarding here covers all of
  // them at once rather than per-tab.
  const [pendingAction, setPendingAction] = useState<"revert" | "remove" | null>(
    null,
  );
  // #11554: a Save that is blocked by validation used to be a silent no-op when
  // the error sat far above the footer. After every Save click settles we look
  // for the first inline field error (else the banner), scroll it into view and
  // move focus there, and echo the reason next to the Save button.
  const bodyRef = useRef<HTMLDivElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const [revealTick, setRevealTick] = useState(0);
  const [blockedHint, setBlockedHint] = useState<string | null>(null);

  const handleSaveClick = async () => {
    try {
      await onSave();
    } finally {
      setRevealTick((t) => t + 1);
    }
  };

  useEffect(() => {
    if (revealTick === 0) return;
    const fieldError = bodyRef.current?.querySelector<HTMLElement>("[data-field-error]");
    const banner = bannerRef.current;
    const target = fieldError ?? banner;
    if (!target) {
      setBlockedHint(null);
      return;
    }
    setBlockedHint(
      fieldError?.textContent?.trim() || banner?.textContent?.trim() || "",
    );
    let focusTarget: HTMLElement = target;
    if (fieldError && bodyRef.current) {
      // The control the message belongs to: the last focusable element that
      // precedes the message in document order.
      const focusables = Array.from(
        bodyRef.current.querySelectorAll<HTMLElement>(
          "input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])",
        ),
      ).filter(
        (el) =>
          !!(fieldError.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING),
      );
      // Prefer a text-entry control (a path input beats its "Add" button).
      const fields = focusables.filter((el) => el.tagName !== "BUTTON");
      focusTarget =
        fields[fields.length - 1] ?? focusables[focusables.length - 1] ?? fieldError;
    }
    if (!focusTarget.hasAttribute("tabindex") && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(focusTarget.tagName)) {
      focusTarget.setAttribute("tabindex", "-1");
    }
    focusTarget.scrollIntoView?.({ block: "center", behavior: "smooth" });
    focusTarget.focus({ preventScroll: true });
    // Only re-run per Save click, not on every error text change.
  }, [revealTick]);

  const savedInactive = !isInherited && isConfigured && !!configuredButInactive;
  const badgeText = isInherited
    ? "Configured (inherited)"
    : savedInactive
      ? "Saved (not deployed)"
      : isConfigured
        ? "Configured"
        : "Not configured";
  const badgeClass = isInherited
    ? "border-blue-500/40 bg-blue-500/20 text-blue-700"
    : savedInactive
      ? "border-amber-500/40 bg-amber-500/20 text-amber-700"
      : isConfigured
        ? "border-green-500/40 bg-green-500/20 text-green-700"
        : "border-muted bg-muted/50 text-muted-foreground";
  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border bg-muted/50">
              {icon}
            </div>
            <div>
              <h2 className="text-lg font-semibold">{title}</h2>
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
          </div>
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${badgeClass}`}
          >
            {badgeText}
          </span>
        </div>

        {/* Error banner */}
        {error && (
          <div
            ref={bannerRef}
            data-testid="feature-tab-error"
            role="alert"
            tabIndex={-1}
            className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}

        {/* Inline settings form */}
        <div
          ref={bodyRef}
          className={`mt-6 ${isInherited ? "opacity-60 pointer-events-none" : ""}`}
        >
          {children}
        </div>

        {/* Footer */}
        <div className="mt-6 flex items-center justify-between border-t pt-4">
          <div>
            {isInherited && onOverride && (
              <button
                type="button"
                onClick={onOverride}
                disabled={saving || saveDisabled}
                className="inline-flex items-center gap-2 rounded-md border border-primary/40 px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/10 disabled:opacity-50"
              >
                <PenLine className="h-4 w-4" />
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.featureTabShell.override",
                )}
              </button>
            )}
            {!isInherited && onRevert && (
              <button
                type="button"
                onClick={() => setPendingAction("revert")}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-md border border-blue-500/40 px-3 py-2 text-sm font-medium text-blue-700 transition hover:bg-blue-500/10 disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4" />
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.featureTabShell.revertToParent",
                )}
              </button>
            )}
            {!isInherited && !onRevert && isConfigured && onRemove && (
              <button
                type="button"
                onClick={() => setPendingAction("remove")}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                {i18n.t("common:actions.remove")}
              </button>
            )}
          </div>
          {!isInherited && (
            <div className="flex items-center gap-3">
            {blockedHint !== null && !saving && (
              <p
                data-testid="save-blocked-hint"
                role="status"
                className="max-w-md text-right text-sm text-destructive"
              >
                {blockedHint
                  ? i18n.t(
                      "policies:configurationPolicies.featureTabs.featureTabShell.notSaved",
                      { reason: blockedHint },
                    )
                  : i18n.t(
                      "policies:configurationPolicies.featureTabs.featureTabShell.saveBlocked",
                    )}
              </p>
            )}
            <button
              type="button"
              data-testid={saveTestId}
              onClick={() => void handleSaveClick()}
              disabled={saving || saveDisabled}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {saving
                ? i18n.t(
                    "policies:configurationPolicies.featureTabs.featureTabShell.saving",
                  )
                : i18n.t("common:actions.save")}
            </button>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={pendingAction === "revert"}
        onClose={() => setPendingAction(null)}
        onConfirm={() => {
          setPendingAction(null);
          onRevert?.();
        }}
        title={i18n.t(
          "policies:configurationPolicies.featureTabs.featureTabShell.revertConfirmTitle",
        )}
        message={i18n.t(
          "policies:configurationPolicies.featureTabs.featureTabShell.revertConfirmMessage",
          { feature: title },
        )}
        confirmLabel={i18n.t(
          "policies:configurationPolicies.featureTabs.featureTabShell.revertToParent",
        )}
        confirmTestId="feature-tab-revert-confirm"
      />

      <ConfirmDialog
        open={pendingAction === "remove"}
        onClose={() => setPendingAction(null)}
        onConfirm={() => {
          setPendingAction(null);
          onRemove?.();
        }}
        title={i18n.t(
          "policies:configurationPolicies.featureTabs.featureTabShell.removeConfirmTitle",
        )}
        message={i18n.t(
          "policies:configurationPolicies.featureTabs.featureTabShell.removeConfirmMessage",
          { feature: title },
        )}
        confirmLabel={i18n.t("common:actions.remove")}
        confirmTestId="feature-tab-remove-confirm"
      />
    </div>
  );
}
