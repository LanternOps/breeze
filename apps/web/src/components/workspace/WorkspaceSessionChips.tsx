import { Building2, Monitor, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useOrgStore } from "@/stores/orgStore";
import { useAiStore } from "@/stores/aiStore";

interface WorkspaceSessionChipsProps {
  orgId: string | null;
  deviceLabel: string | null;
  m365ConnectionId: string | null;
}

const chipClass =
  "inline-flex max-w-[220px] items-center gap-1 truncate rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300";

/**
 * #9427 W3 (Gate B #13): what a workspace tab's conversation is bound to.
 * The org chip shows when the user has more than one org or the session's org
 * is not the current one — reactive, since the org list arrives after mount
 * (Advisor finding 10); "Another organization" until the name is known. The
 * customer chip shows only once the connection's name is loaded.
 */
export default function WorkspaceSessionChips({ orgId, deviceLabel, m365ConnectionId }: WorkspaceSessionChipsProps) {
  const { t } = useTranslation("ai");
  const organizations = useOrgStore((s) => s.organizations);
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const customerName = useAiStore((s) =>
    m365ConnectionId
      ? (s.m365Connections ?? []).find((c) => c.id === m365ConnectionId)?.customerDisplayName ?? null
      : null,
  );

  const orgs = organizations ?? [];
  const showOrg = !!orgId && (orgs.length > 1 || orgId !== currentOrgId);
  const orgName = showOrg ? orgs.find((o) => o.id === orgId)?.name ?? t("aiConversationMove.anotherOrg") : null;

  if (!showOrg && !deviceLabel && !customerName) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="workspace-session-chips">
      {orgName && (
        <span className={chipClass} data-testid="workspace-chip-org" title={orgName}>
          <Building2 className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{orgName}</span>
        </span>
      )}
      {deviceLabel && (
        <span className={chipClass} data-testid="workspace-chip-device" title={t("aiConversationMove.device")}>
          <Monitor className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{deviceLabel}</span>
        </span>
      )}
      {customerName && (
        <span className={chipClass} data-testid="workspace-chip-customer" title={customerName}>
          <Users className="h-3 w-3 shrink-0" aria-hidden />
          <span className="truncate">{customerName}</span>
        </span>
      )}
    </div>
  );
}
