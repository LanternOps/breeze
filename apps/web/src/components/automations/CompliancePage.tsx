import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft } from 'lucide-react';
import ComplianceDashboard, {
  type DeviceCompliance,
  type PolicyCompliance,
  type ComplianceTrend
} from './ComplianceDashboard';
import { fetchWithAuth } from '../../stores/auth';

type CompliancePageProps = {
  policyId?: string;
};

export default function CompliancePage({ policyId }: CompliancePageProps) {
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
        throw new Error('Failed to fetch compliance data');
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
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [policyId]);

  useEffect(() => {
    fetchComplianceData();
  }, [fetchComplianceData]);

  const handleViewDevice = (deviceId: string) => {
    window.location.href = `/devices/${deviceId}`;
  };

  const handleViewPolicy = (policyId: string) => {
    window.location.href = `/policies/compliance?policyId=${policyId}`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading compliance data...</p>
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
          Try again
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
          <h1 className="text-2xl font-bold">
            {policyId ? `Compliance: ${policyName ?? 'Policy'}` : 'Compliance Dashboard'}
          </h1>
          <p className="text-muted-foreground">
            {policyId
              ? 'View compliance status for this policy.'
              : 'Overview of policy compliance across all devices.'}
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
