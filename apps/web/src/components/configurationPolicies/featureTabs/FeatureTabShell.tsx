import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2, Trash2, RotateCcw, PenLine } from "lucide-react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { FeatureDirtyContext, FeatureDirtyReporterContext, useFeatureReadOnly } from "./featureEditing";
import { featureStateLabel } from "../page/featureState";
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
   * When true, the Save button is disabled independent of the
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
  /**
   * An inherited tab the user unlocked with Change for this policy
   * (useChangeForPolicy): the form is live and Save creates this policy's own
   * link. Nothing is written until Save.
   */
  unlocked?: boolean;
  /** Change for this policy. Writes nothing; offered only with this. */
  onUnlock?: () => void;
  /** Called when user clicks "Reset to parent" on an overridden tab */
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
  unlocked,
  onUnlock,
  onRevert,
  children,
}: FeatureTabShellProps) {
  useTranslation("policies");
  // A read-only viewer (#12469) gets the form disabled and no footer action:
  // Save, Remove, Reset and Change for this policy are not rendered at all.
  const readOnly = useFeatureReadOnly();
  // An inherited feature shows the parent's values, locked, until Change for
  // this policy unlocks it (#12470).
  const locked = !!isInherited && !unlocked;
  // #5314: Reset to parent and Remove both fire an irreversible
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

  const [thrownMessage, setThrownMessage] = useState<string | null>(null);
  const awaitingSettle = useRef(false);

  // D16 (#12469): unsaved changes. The feature is dirty after any of:
  // - a bubbling native input/change event in the body;
  // - a click on a button in the body (a toggle, an Add/Remove row, a
  //   segmented choice), unless it is a disclosure (aria-expanded), opens a
  //   popup (aria-haspopup), or sits inside [data-feature-dirty-ignore] (a
  //   status panel, a Test or Refresh action);
  // - useFeatureDirty().markDirty(), for a picker or drag that emits neither.
  // Native listeners (not React's onChange) so a portaled sub-form that saves
  // on its own (a ring or destination editor dialog) does not count.
  // Only a Save that really sent a request (`saving` went true), settled with
  // no field error, banner or throw, and saw no edit after the click clears it.
  const reportDirty = useContext(FeatureDirtyReporterContext);
  const [dirty, setDirty] = useState(false);
  const editSeq = useRef(0);
  const noteEdit = useCallback(() => {
    editSeq.current += 1;
    setDirty(true);
  }, []);
  const saveRun = useRef({ editSeqAtClick: 0, sentRequest: false, threw: false });
  const markDirty = noteEdit;
  const dirtyApi = useMemo(() => ({ markDirty }), [markDirty]);
  useEffect(() => {
    reportDirty(dirty);
  }, [dirty, reportDirty]);
  useEffect(() => () => reportDirty(false), [reportDirty]);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onEdit = (e: Event) => {
      if ((e.target as Element | null)?.closest?.("[data-feature-dirty-ignore]")) return;
      noteEdit();
    };
    const onClick = (e: MouseEvent) => {
      const control = (e.target as Element | null)?.closest?.(
        'button, [role="switch"], [role="checkbox"], [role="radio"], [role="option"], [aria-pressed]',
      );
      if (!control || !body.contains(control)) return;
      if (control.matches(":disabled, [aria-expanded], [aria-haspopup]")) return;
      if (control.closest("[data-feature-dirty-ignore]")) return;
      noteEdit();
    };
    body.addEventListener("input", onEdit);
    body.addEventListener("change", onEdit);
    body.addEventListener("click", onClick);
    return () => {
      body.removeEventListener("input", onEdit);
      body.removeEventListener("change", onEdit);
      body.removeEventListener("click", onClick);
    };
  }, [noteEdit]);

  const handleSaveClick = async () => {
    awaitingSettle.current = true;
    saveRun.current = { editSeqAtClick: editSeq.current, sentRequest: false, threw: false };
    setBlockedHint(null);
    setThrownMessage(null);
    try {
      const result = onSave();
      if (result && typeof (result as Promise<unknown>).then === "function") {
        await result;
      } else {
        // Tabs that wrap their async persist in `() => void persist()` give us
        // nothing to await: let a synchronous validation failure render, and
        // reveal again below when `saving` settles.
        await new Promise((r) => setTimeout(r, 0));
      }
    } catch (err) {
      // A throwing tab save must not be a mute click either.
      console.error("[FeatureTabShell] save failed", err);
      saveRun.current.threw = true;
      setThrownMessage(err instanceof Error ? err.message : "");
    } finally {
      setRevealTick((t) => t + 1);
    }
  };

  // Void-returning tabs: reveal once the in-flight save settles.
  useEffect(() => {
    if (saving) {
      setBlockedHint(null);
      if (awaitingSettle.current) saveRun.current.sentRequest = true;
    } else if (awaitingSettle.current) {
      setRevealTick((t) => t + 1);
    }
  }, [saving]);

  // Drop the hint once whatever it described is gone (field fixed, banner cleared).
  useEffect(() => {
    if (blockedHint === null) return;
    const stillInvalid =
      !!bodyRef.current?.querySelector("[data-field-error]") || !!bannerRef.current;
    if (!stillInvalid) setBlockedHint(null);
  });

  useEffect(() => {
    if (revealTick === 0) return;
    if (!saving) awaitingSettle.current = false;
    const fieldError = bodyRef.current?.querySelector<HTMLElement>("[data-field-error]");
    const banner = bannerRef.current;
    const target = fieldError ?? banner;
    if (!target) {
      setBlockedHint(null);
      // A save that sent a request and settled with nothing wrong: the form
      // matches what is saved. Not while it is still in flight (a
      // void-returning tab reveals once before `saving` settles), not after a
      // throw, not when the tab refused before sending (a validation return
      // with no marked error), and not when an edit arrived after the click.
      const run = saveRun.current;
      if (!saving && run.sentRequest && !run.threw && editSeq.current === run.editSeqAtClick) {
        setDirty(false);
      }
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
  // The rail's words (plan D7, #12469): Set here, From parent, Not set.
  const badgeText = isInherited
    ? featureStateLabel("from_parent")
    : savedInactive
      ? i18n.t("policies:configurationPolicies.featureTabs.featureTabShell.badgeSavedNotDeployed")
      : isConfigured
        ? featureStateLabel("set_here")
        : featureStateLabel("not_set");
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
            className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium ${badgeClass}`}
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
          className={`mt-6 ${locked ? "opacity-60 pointer-events-none" : ""}`}
        >
          <fieldset disabled={readOnly || locked} className="min-w-0">
            <FeatureDirtyContext.Provider value={dirtyApi}>{children}</FeatureDirtyContext.Provider>
          </fieldset>
        </div>

        {/* Footer */}
        {!readOnly && (
        <div data-testid="feature-tab-footer" className="mt-6 flex items-center justify-between border-t pt-4">
          <div>
            {locked && onUnlock && (
              <button
                type="button"
                data-testid="feature-tab-change-for-policy"
                onClick={onUnlock}
                className="inline-flex items-center gap-2 rounded-md border border-primary/40 px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/10 disabled:opacity-50"
              >
                <PenLine className="h-4 w-4" />
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.featureTabShell.unlockAction",
                )}
              </button>
            )}
            {isInherited && !locked && (
              <p
                data-testid="feature-tab-changing-hint"
                className="max-w-xs text-sm text-muted-foreground"
              >
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.featureTabShell.unlockedHint",
                )}
              </p>
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
          {!locked && (
            <div className="flex items-center gap-3">
            {(blockedHint ?? thrownMessage) !== null && !saving && (
              <p
                data-testid="save-blocked-hint"
                role="status"
                className="max-w-md text-right text-sm text-destructive"
              >
                {(blockedHint ?? thrownMessage)
                  ? i18n.t(
                      "policies:configurationPolicies.featureTabs.featureTabShell.notSaved",
                      { reason: blockedHint ?? thrownMessage },
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
        )}
      </div>

      <ConfirmDialog
        open={pendingAction === "revert"}
        onClose={() => setPendingAction(null)}
        onConfirm={() => {
          setPendingAction(null);
          // Reverting discards this feature's edits on purpose.
          setDirty(false);
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
          // Removing discards this feature's edits on purpose.
          setDirty(false);
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
