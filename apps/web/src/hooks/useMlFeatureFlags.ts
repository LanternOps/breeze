import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../stores/auth';

export type MlFeatureFlagName =
  | 'ml.alert_correlation.enabled'
  | 'ml.rca.enabled'
  | 'ml.metric_rollups.enabled'
  | 'ml.anomalies.enabled'
  | 'ml.anomalies.v1_shadow.enabled'
  | 'ml.anomalies.create_alerts'
  | 'ml.remediation_suggestions.enabled'
  | 'ml.ticket_triage.enabled'
  | 'ml.device_reliability.enabled'
  | 'ml.user_risk_v0.enabled'
  | 'ml.user_risk_v1.enabled';

export type MlFeatureFlagResolution = {
  flag: MlFeatureFlagName;
  enabled: boolean;
  defaultEnabled: boolean;
  source: string;
};

type MlFeatureFlagsResponse = {
  mlFeatureFlags?: Partial<Record<MlFeatureFlagName, MlFeatureFlagResolution>>;
  data?: Partial<Record<MlFeatureFlagName, MlFeatureFlagResolution>>;
};

export function useMlFeatureFlags() {
  const [flags, setFlags] = useState<Partial<Record<MlFeatureFlagName, MlFeatureFlagResolution>>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/config/ml-feature-flags');
      if (!response.ok) {
        throw new Error(`Failed to load ML feature flags (${response.status})`);
      }
      const body = await response.json() as MlFeatureFlagsResponse;
      setFlags(body.mlFeatureFlags ?? body.data ?? {});
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ML feature flags');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isDisabled = useCallback((flag: MlFeatureFlagName) => loaded && flags[flag]?.enabled === false, [flags, loaded]);

  return { flags, loaded, error, isDisabled, reload: load };
}
