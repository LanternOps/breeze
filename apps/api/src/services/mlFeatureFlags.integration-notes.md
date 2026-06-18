# ML Feature Flag Integration Notes

Use `shouldProduceMlOutput(orgId, flag)` before a worker enqueues or writes any ML/AI output. It resolves the typed flag, org/partner settings overrides, and global emergency kill switches in one place.

Worker A correlation enqueue gate:

```ts
import { shouldProduceMlOutput } from './mlFeatureFlags';

if (!(await shouldProduceMlOutput(orgId, 'ml.alert_correlation.enabled'))) {
  return;
}

await alertCorrelationQueue.add(jobName, payload, { jobId });
```

Future producers should gate the write-producing step, not just UI reads:

- Metric rollup worker: `ml.metric_rollups.enabled`
- Anomaly output worker: `ml.anomalies.enabled`
- Anomaly-to-alert promotion: `ml.anomalies.create_alerts`
- RCA generation: `ml.rca.enabled`
- Remediation suggestions: `ml.remediation_suggestions.enabled`
- Ticket triage suggestions: `ml.ticket_triage.enabled`
- Existing user-risk rules: `ml.user_risk_v0.enabled`
- Learned user-risk baseline: `ml.user_risk_v1.enabled`

Supported org/partner settings shapes:

```json
{
  "mlFeatureFlags": {
    "ml.rca.enabled": true
  },
  "ml": {
    "anomalies": {
      "enabled": true,
      "create_alerts": false
    }
  }
}
```

Org settings override partner settings. Global env switches always win and suppress output writes: `ML_FEATURES_DISABLED=true`, `ML_DISABLED_FLAGS=ml.rca.enabled,ml.anomalies.*`, or a per-flag switch such as `ML_ALERT_CORRELATION_DISABLED=true`.
