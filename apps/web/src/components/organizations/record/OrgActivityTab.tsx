import AuditLogViewer from '@/components/audit/AuditLogViewer';

export interface OrgActivityTabProps {
  orgId: string;
}

/**
 * The organization record's Activity tab (#5075 W02).
 *
 * `AuditLogViewer`'s `orgId` prop pins every request (`/audit-logs`,
 * `/audit-logs/search`, `/audit-logs/export`) to this org via
 * `orgIdOverride`, regardless of the OrgSwitcher's ambient scope.
 */
export default function OrgActivityTab({ orgId }: OrgActivityTabProps) {
  return (
    <div data-testid="org-activity-tab">
      <AuditLogViewer orgId={orgId} />
    </div>
  );
}
