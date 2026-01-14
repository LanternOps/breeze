import { useMemo, useState } from 'react';
import { AlertTriangle, FileText, ShieldCheck, TrendingUp } from 'lucide-react';

type ComplianceCategory = 'gdpr' | 'soc2' | 'hipaa';

const categories: { id: ComplianceCategory; label: string; description: string }[] = [
  { id: 'gdpr', label: 'GDPR', description: 'EU data privacy compliance' },
  { id: 'soc2', label: 'SOC 2', description: 'Security and availability controls' },
  { id: 'hipaa', label: 'HIPAA', description: 'Protected health information audit' }
];

const summaryByCategory: Record<
  ComplianceCategory,
  { label: string; value: string; helper: string }[]
> = {
  gdpr: [
    { label: 'Data access events', value: '184', helper: 'past 30 days' },
    { label: 'DSAR requests', value: '6', helper: 'pending 2' },
    { label: 'Retention alerts', value: '3', helper: 'overdue' }
  ],
  soc2: [
    { label: 'Control exceptions', value: '2', helper: 'last 7 days' },
    { label: 'Privileged actions', value: '28', helper: 'within scope' },
    { label: 'Policy attestations', value: '94%', helper: 'complete' }
  ],
  hipaa: [
    { label: 'PHI access events', value: '67', helper: 'past 14 days' },
    { label: 'Role changes', value: '4', helper: 'requires review' },
    { label: 'Encryption checks', value: '100%', helper: 'compliant' }
  ]
};

const dataAccessEntries = [
  {
    id: 'acc_1',
    category: 'gdpr',
    user: 'Miguel Rogers',
    data: 'Customer Records',
    purpose: 'Billing review',
    timestamp: '2024-05-28 12:05'
  },
  {
    id: 'acc_2',
    category: 'soc2',
    user: 'Ariana Fields',
    data: 'Admin Portal',
    purpose: 'Security audit',
    timestamp: '2024-05-28 14:12'
  },
  {
    id: 'acc_3',
    category: 'hipaa',
    user: 'Grace Liu',
    data: 'Payroll Records',
    purpose: 'Compliance sampling',
    timestamp: '2024-05-27 12:40'
  },
  {
    id: 'acc_4',
    category: 'soc2',
    user: 'Kai Mendoza',
    data: 'Device Group - VIP',
    purpose: 'Access provisioning',
    timestamp: '2024-05-27 16:44'
  }
];

const sensitiveOperations = [
  { id: 'op_1', category: 'gdpr', label: 'Exported customer dataset to CSV', severity: 'High' },
  { id: 'op_2', category: 'soc2', label: 'MFA window reduced to 15 minutes', severity: 'Medium' },
  { id: 'op_3', category: 'hipaa', label: 'Role changed for external contractor', severity: 'High' }
];

export default function ComplianceReport() {
  const [selectedCategory, setSelectedCategory] = useState<ComplianceCategory>('gdpr');

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
          <h2 className="text-lg font-semibold">Compliance Report</h2>
          <p className="text-sm text-muted-foreground">
            Generate audit-ready summaries aligned to compliance controls.
          </p>
        </div>
        <button
          type="button"
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <FileText className="h-4 w-4" />
          Generate Report
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
          <h3 className="text-sm font-semibold">Data Access Audit</h3>
          <div className="mt-4 overflow-hidden rounded-md border">
            <table className="min-w-full divide-y text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase">User</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase">Data</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase">Purpose</th>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredAccess.map(entry => (
                  <tr key={entry.id}>
                    <td className="px-3 py-2 text-foreground">{entry.user}</td>
                    <td className="px-3 py-2 text-foreground">{entry.data}</td>
                    <td className="px-3 py-2 text-muted-foreground">{entry.purpose}</td>
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
            Sensitive Operations
          </div>
          <div className="mt-4 space-y-3">
            {filteredSensitive.map(entry => (
              <div key={entry.id} className="rounded-md border bg-muted/20 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-foreground">{entry.label}</span>
                  <span className="rounded-full border px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                    {entry.severity}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Review required
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
