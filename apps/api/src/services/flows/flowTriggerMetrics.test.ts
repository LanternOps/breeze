import { describe, expect, it } from 'vitest';
import { metricsRegistry } from '../metricsRegistry';
import { recordFleetStepAiCeilingRefused } from './flowTriggerMetrics';

describe('flowTriggerMetrics', () => {
  it('recordFleetStepAiCeilingRefused increments flow_fleet_step_ai_ceiling_refused_total with the selector label', async () => {
    const valueOf = async (selector: string) => {
      const metric = await metricsRegistry.getSingleMetric('flow_fleet_step_ai_ceiling_refused_total')!.get();
      return metric.values.find((v) => v.labels.selector === selector)?.value ?? 0;
    };
    const before = await valueOf('fleetFilter');
    recordFleetStepAiCeilingRefused({ selector: 'fleetFilter' });
    recordFleetStepAiCeilingRefused({ selector: 'deviceIds' });
    expect(await valueOf('fleetFilter')).toBe(before + 1);
    expect(await valueOf('deviceIds')).toBe(1);
  });
});
