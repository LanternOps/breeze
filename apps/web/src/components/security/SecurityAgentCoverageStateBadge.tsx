import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import {
  coverageStateClass,
  coverageStateLabel,
} from "@/lib/securityAgentCoverage";

export default function SecurityAgentCoverageStateBadge({
  state,
}: {
  state: string;
}) {
  const { t } = useTranslation("security");
  return (
    <span
      data-testid={`coverage-state-badge-${state}`}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${coverageStateClass(state)}`}
    >
      {coverageStateLabel(t, state)}
    </span>
  );
}
