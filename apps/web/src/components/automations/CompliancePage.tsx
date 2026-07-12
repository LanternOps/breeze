import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import ComplianceDashboard, {
  type DeviceCompliance,
  type PolicyCompliance,
  type ComplianceTrend
} from './ComplianceDashboard';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

type CompliancePageProps = {
  policyId?: string;
};

export default function CompliancePage({ policyId }: CompliancePageProps) {
  const { t } = useTranslation('scripts');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [overallCompliance, setOverallCompliance] = useState({
    total: 0,
    compliant: 0,
    nonCompliant: 0,
    unknown: 0
  });
  const [trend, setTrend] = useState<ComplianceTrend[]>([]);
  const [policies, setPolicies] = useState<PolicyCompliance[]>([]);
  const [nonCompliantDevices, setNonCompliantDevices] = useState<DeviceCompliance[]>([]);
  const [policyName, setPolicyName] = useState<string>();

  const fetchComplianceData = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      const url = policyId
        ? `/policies/${policyId}/compliance`
        : '/policies/compliance/summary';

      const response = await fetchWithAuth(url);
      if (!response.ok) {
        throw new Error(t('compliancePage.errors.fetch'));
      }
      const data = await response.json();

      setOverallCompliance(data.overall ?? {
        total: 0,
        compliant: 0,
        nonCompliant: 0,
        unknown: 0
      });
      setTrend(data.trend ?? []);
      setPolicies(data.policies ?? []);
      setNonCompliantDevices(data.nonCompliantDevices ?? []);
      setPolicyName(data.policyName);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('compliancePage.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [policyId, t]);

  useEffect(() => {
    fetchComplianceData();
  }, [fetchComplianceData]);

  const handleViewDevice = (deviceId: string) => {
    void navigateTo(`/devices/${deviceId}`);
  };

  const handleViewPolicy = (policyId: string) => {
    void navigateTo(`/policies/compliance?policyId=${policyId}`);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('compliancePage.loading')}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchComplianceData}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <a
          href="/policies"
          className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
        >
          <ArrowLeft className="h-5 w-5" />
        </a>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {policyId
              ? t('compliancePage.policyTitle', { policy: policyName ?? t('compliancePage.policyFallback') })
              : t('compliancePage.title')}
          </h1>
          <p className="text-muted-foreground">
            {policyId
              ? t('compliancePage.description.policy')
              : t('compliancePage.description.overview')}
          </p>
        </div>
      </div>

      <ComplianceDashboard
        overallCompliance={overallCompliance}
        trend={trend}
        policies={policies}
        nonCompliantDevices={nonCompliantDevices}
        onViewDevice={handleViewDevice}
        onViewPolicy={handleViewPolicy}
      />
    </div>
  );
}
