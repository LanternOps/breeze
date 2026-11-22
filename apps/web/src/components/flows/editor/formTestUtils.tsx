/**
 * Test-only helpers shared by the flow form section tests (not imported by
 * production code). DeviceTargetSelector is replaced with a stub that exposes
 * the modes it was offered and lets a test pick a target.
 */
import type { DeploymentTargetConfig } from '@breeze/shared';

export const SCRIPT = '33333333-3333-4333-8333-333333333333';
export const CHANNEL = '55555555-5555-4555-8555-555555555555';
export const CHANNEL_2 = '55555555-5555-4555-8555-5555555555bd';

export function MockDeviceTargetSelector({ value, onChange, modes }: { value: DeploymentTargetConfig; onChange: (v: DeploymentTargetConfig) => void; modes?: string[] }) {
  return (
    <div data-testid="mock-target-selector" data-modes={(modes ?? ['all', 'manual', 'groups', 'filter']).join(',')} data-value={JSON.stringify(value)}>
      <button type="button" data-testid="mock-target-groups" onClick={() => onChange({ type: 'groups', groupIds: ['44444444-4444-4444-8444-444444444444'] })}>groups</button>
    </div>
  );
}
