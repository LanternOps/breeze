import { Loader2, Plug } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { ACCOUNTING_PROVIDER_NAMES, ACCOUNTING_PROVIDER_UI, type AccountingProviderId } from "../../lib/accountingProviders";

interface Props { provider: AccountingProviderId; reconnect: boolean; busy: boolean; disabled: boolean; onClick: () => void }

/**
 * The connect/reconnect button. QuickBooks keeps the exact pre-W02 markup
 * (test id and classes unchanged). Xero uses a branded treatment in line
 * with Xero's app-certification guidance ("Connect to Xero", Xero blue
 * #13B5EA on white text); a lab pass checks it against Xero's current brand
 * guidelines before certification.
 */
export default function AccountingConnectButton({ provider, reconnect, busy, disabled, onClick }: Props) {
  const { t } = useTranslation("integrations");
  const providerName = ACCOUNTING_PROVIDER_NAMES[provider];
  const label = reconnect
    ? t("accountingConnection.reconnectProvider", { provider: providerName })
    : t("accountingConnection.connectToProvider", { provider: providerName });
  const branded = ACCOUNTING_PROVIDER_UI[provider].brandedConnect;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      data-testid={`${provider}-connect`}
      data-brand={branded ? provider : undefined}
      className={branded
        ? "mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-[#13B5EA] px-4 text-sm font-semibold text-white hover:bg-[#0f9fcd] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#13B5EA] disabled:opacity-50"
        : "inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
      {label}
    </button>
  );
}
