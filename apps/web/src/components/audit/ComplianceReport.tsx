import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, FileText, ShieldCheck, TrendingUp } from 'lucide-react';

type ComplianceCategory = 'gdpr' | 'soc2' | 'hipaa';

const dataAccessEntries = [
  {
    id: 'acc_1',
    category: 'gdpr',
    user: 'Miguel Rogers',
    dataKey: 'customerRecords',
    purposeKey: 'billingReview',
    timestamp: '2024-05-28 12:05'
  },
  {
    id: 'acc_2',
    category: 'soc2',
    user: 'Ariana Fields',
    dataKey: 'adminPortal',
    purposeKey: 'securityAudit',
    timestamp: '2024-05-28 14:12'
  },
  {
    id: 'acc_3',
    category: 'hipaa',
    user: 'Grace Liu',
    dataKey: 'payrollRecords',
    purposeKey: 'complianceSampling',
    timestamp: '2024-05-27 12:40'
  },
  {
    id: 'acc_4',
    category: 'soc2',
    user: 'Kai Mendoza',
    dataKey: 'deviceGroupVip',
    purposeKey: 'accessProvisioning',
    timestamp: '2024-05-27 16:44'
  }
];

const sensitiveOperations = [
  { id: 'op_1', category: 'gdpr', labelKey: 'exportedCustomerDataset', severityKey: 'high' },
  { id: 'op_2', category: 'soc2', labelKey: 'mfaWindowReduced', severityKey: 'medium' },
  { id: 'op_3', category: 'hipaa', labelKey: 'roleChangedExternalContractor', severityKey: 'high' }
];

export default function ComplianceReport() {
  const { t } = useTranslation('admin');
  const [selectedCategory, setSelectedCategory] = useState<ComplianceCategory>('gdpr');
  const categories: { id: ComplianceCategory; label: string }[] = [
    { id: 'gdpr', label: t('audit.complianceReport.categories.gdpr.label') },
    { id: 'soc2', label: t('audit.complianceReport.categories.soc2.label') },
    { id: 'hipaa', label: t('audit.complianceReport.categories.hipaa.label') }
  ];
  const summaryByCategory: Record<
    ComplianceCategory,
    { label: string; value: string; helper: string }[]
  > = {
    gdpr: [
      { label: t('audit.complianceReport.summary.gdpr.dataAccessEvents'), value: '184', helper: t('audit.complianceReport.summary.helpers.past30Days') },
      { label: t('audit.complianceReport.summary.gdpr.dsarRequests'), value: '6', helper: t('audit.complianceReport.summary.helpers.pending2') },
      { label: t('audit.complianceReport.summary.gdpr.retentionAlerts'), value: '3', helper: t('audit.complianceReport.summary.helpers.overdue') }
    ],
    soc2: [
      { label: t('audit.complianceReport.summary.soc2.controlExceptions'), value: '2', helper: t('audit.complianceReport.summary.helpers.last7Days') },
      { label: t('audit.complianceReport.summary.soc2.privilegedActions'), value: '28', helper: t('audit.complianceReport.summary.helpers.withinScope') },
      { label: t('audit.complianceReport.summary.soc2.policyAttestations'), value: '94%', helper: t('audit.complianceReport.summary.helpers.complete') }
    ],
    hipaa: [
      { label: t('audit.complianceReport.summary.hipaa.phiAccessEvents'), value: '67', helper: t('audit.complianceReport.summary.helpers.past14Days') },
      { label: t('audit.complianceReport.summary.hipaa.roleChanges'), value: '4', helper: t('audit.complianceReport.summary.helpers.requiresReview') },
      { label: t('audit.complianceReport.summary.hipaa.encryptionChecks'), value: '100%', helper: t('audit.complianceReport.summary.helpers.compliant') }
    ]
  };

  const summaryCards = summaryByCategory[selectedCategory];
  const filteredAccess = useMemo(
    () => dataAccessEntries.filter(entry => entry.category === selectedCategory),
    [selectedCategory]
  );
  const filteredSensitive = useMemo(
    () => sensitiveOperations.filter(entry => entry.category === selectedCategory),
    [selectedCategory]
  );

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{t('audit.complianceReport.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('audit.complianceReport.description')}
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <FileText className="h-4 w-4" />
          {t('audit.complianceReport.generateReport')}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {categories.map(category => (
          <button
            key={category.id}
            type="button"
            onClick={() => setSelectedCategory(category.id)}
            className={`rounded-full border px-4 py-2 text-sm font-medium ${
              selectedCategory === category.id
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {category.label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {summaryCards.map(card => (
          <div key={card.label} className="rounded-lg border bg-background p-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
              {card.label}
            </div>
            <p className="mt-3 text-2xl font-semibold">{card.value}</p>
            <p className="text-sm text-muted-foreground">{card.helper}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-lg border bg-background p-4">
          <h3 className="text-sm font-semibold">{t('audit.complianceReport.dataAccessAudit')}</h3>
          <div className="mt-4 overflow-x-auto rounded-md border">
            <table className="min-w-full divide-y text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('audit.complianceReport.table.user')}</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('audit.complianceReport.table.data')}</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('audit.complianceReport.table.purpose')}</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('audit.complianceReport.table.time')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredAccess.map(entry => (
                  <tr key={entry.id}>
                    <td className="px-3 py-2 text-foreground">{entry.user}</td>
                    <td className="px-3 py-2 text-foreground">
                      {{
                        customerRecords: t('audit.complianceReport.data.customerRecords'),
                        adminPortal: t('audit.complianceReport.data.adminPortal'),
                        payrollRecords: t('audit.complianceReport.data.payrollRecords'),
                        deviceGroupVip: t('audit.complianceReport.data.deviceGroupVip'),
                      }[entry.dataKey]}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {{
                        billingReview: t('audit.complianceReport.purpose.billingReview'),
                        securityAudit: t('audit.complianceReport.purpose.securityAudit'),
                        complianceSampling: t('audit.complianceReport.purpose.complianceSampling'),
                        accessProvisioning: t('audit.complianceReport.purpose.accessProvisioning'),
                      }[entry.purposeKey]}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{entry.timestamp}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-lg border bg-background p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            {t('audit.complianceReport.sensitiveOperations')}
          </div>
          <div className="mt-4 space-y-3">
            {filteredSensitive.map(entry => (
              <div key={entry.id} className="rounded-md border bg-muted/20 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-foreground">
                    {{
                      exportedCustomerDataset: t('audit.complianceReport.operations.exportedCustomerDataset'),
                      mfaWindowReduced: t('audit.complianceReport.operations.mfaWindowReduced'),
                      roleChangedExternalContractor: t('audit.complianceReport.operations.roleChangedExternalContractor'),
                    }[entry.labelKey]}
                  </span>
                  <span className="rounded-full border px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                    {{
                      high: t('audit.complianceReport.severity.high'),
                      medium: t('audit.complianceReport.severity.medium'),
                    }[entry.severityKey]}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  {t('audit.complianceReport.reviewRequired')}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
