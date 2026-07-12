import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";
interface SecurityPageHeaderProps {
  title: string;
  subtitle?: string;
  loading?: boolean;
  onRefresh?: () => void;
}
export default function SecurityPageHeader({
  title,
  subtitle,
  loading,
  onRefresh,
}: SecurityPageHeaderProps) {
  const { t } = useTranslation("security");
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div>
        <a
          href="/security"
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t("securitySecurityPageHeader.security")}
        </a>
        <h2 className="text-xl font-semibold">{title}</h2>
        {subtitle && (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm hover:bg-muted"
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {t("securitySecurityPageHeader.refresh")}
        </button>
      )}
    </div>
  );
}
