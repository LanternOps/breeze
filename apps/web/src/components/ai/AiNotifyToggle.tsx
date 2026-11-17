import { useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import {
  currentUserId,
  getNotifyPermission,
  isNotificationSupported,
  isNotifyOptedIn,
  requestNotifyOptIn,
  setNotifyOptIn,
  type AiNotifyPermission,
} from "@/lib/aiNotifications";

/**
 * #9429: the AI chat header bell (side panel and workspace). The only place
 * the browser's notification permission is ever requested — inside this
 * click, never on mount. Hidden where the Notification API is unavailable;
 * disabled when the site's permission is blocked (only browser settings can
 * undo that). The opt-in is per browser and per user (localStorage).
 */
export default function AiNotifyToggle() {
  const { t } = useTranslation("ai");
  // Read on every render (one store read, one localStorage read, one property
  // read) so a change of user, or a permission changed in browser settings,
  // shows on the next render. Not a hook subscription: the chat headers
  // re-render often, and this keeps the bell out of the auth store's render
  // path (and of the many tests that stub that store).
  const userId = currentUserId();
  const permission: AiNotifyPermission = getNotifyPermission();
  const [, setRevision] = useState(0);
  const optedIn = isNotifyOptedIn(userId);
  const [busy, setBusy] = useState(false);

  if (!userId || !isNotificationSupported()) return null;

  const blocked = permission === "denied";
  const on = optedIn && permission === "granted";
  const label = blocked
    ? t("aiNotifications.blocked")
    : on
      ? t("aiNotifications.disable")
      : t("aiNotifications.enable");

  const handleClick = async () => {
    if (on) {
      setNotifyOptIn(userId, false);
      setRevision((r) => r + 1);
      return;
    }
    setBusy(true);
    try {
      await requestNotifyOptIn(userId);
    } finally {
      setRevision((r) => r + 1);
      setBusy(false);
    }
  };

  const Icon = on ? Bell : BellOff;
  return (
    <button
      type="button"
      onClick={() => { void handleClick(); }}
      disabled={blocked || busy}
      aria-pressed={on}
      aria-label={label}
      title={label}
      data-testid="ai-notify-toggle"
      className={`rounded p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        on
          ? "text-primary hover:bg-muted"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
