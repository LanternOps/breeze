import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import {
  coverageSetupLinkLabel,
  coverageSetupPath,
} from "@/lib/securityAgentCoverage";

/**
 * Where a coverage row's cause is fixed (#9247: `installer_missing` links to
 * the package's Versions tab). Renders nothing when the row carries no safe
 * same-site path.
 */
export default function SecurityAgentCoverageSetupLink({
  row,
}: {
  row: { reasonCode: string | null; setupPath?: string | null };
}) {
  const { t } = useTranslation("security");
  const href = coverageSetupPath(row);
  if (!href) return null;
  return (
    <a
      href={href}
      data-testid="security-agent-coverage-setup-link"
      className="text-xs font-medium text-primary hover:underline"
    >
      {coverageSetupLinkLabel(t, row.reasonCode)}
    </a>
  );
}
