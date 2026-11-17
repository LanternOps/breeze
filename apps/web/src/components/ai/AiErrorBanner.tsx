import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isRetryableAiError, type AiRetryTarget } from "@/lib/aiErrors";
import "@/lib/i18n";

interface AiErrorBannerProps {
  error: string;
  /** Already filtered with `activeRetryTarget`. */
  retryTarget: AiRetryTarget | null;
  busy: boolean;
  onRetry: () => void;
  onDismiss: () => void;
  dismissLabel: string;
  className: string;
  textClassName: string;
  buttonClassName: string;
  testId?: string;
  /** Surface-specific extra actions, rendered between the text and Dismiss. */
  children?: ReactNode;
}

/** #9428: the AI chat error banner shared by the side panel and the workspace. */
export default function AiErrorBanner({
  error,
  retryTarget,
  busy,
  onRetry,
  onDismiss,
  dismissLabel,
  className,
  textClassName,
  buttonClassName,
  testId,
  children,
}: AiErrorBannerProps) {
  const { t } = useTranslation("ai");
  const headline =
    retryTarget?.code === "timeout"
      ? t("aiErrorBanner.timedOut")
      : retryTarget?.code === "disconnect"
        ? t("aiErrorBanner.disconnected")
        : error;
  const canRetry = !!retryTarget && isRetryableAiError(retryTarget.code) && !busy;

  return (
    <div className={className} data-testid={testId}>
      <div className="flex min-w-0 flex-col">
        <span className={textClassName}>{headline}</span>
        {retryTarget?.detail && (
          <span className={`${textClassName} opacity-80`} data-testid="ai-error-detail">
            {retryTarget.detail}
          </span>
        )}
      </div>
      {canRetry && (
        <button
          type="button"
          data-testid="ai-error-retry"
          onClick={onRetry}
          className={`ml-2 shrink-0 ${buttonClassName}`}
        >
          {t("aiErrorBanner.tryAgain")}
        </button>
      )}
      {children}
      <button type="button" onClick={onDismiss} className={buttonClassName}>
        {dismissLabel}
      </button>
    </div>
  );
}
