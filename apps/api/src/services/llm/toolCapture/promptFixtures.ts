import type { buildHelperSystemPrompt } from '../../helperAiAgent';
import type { AgentRunPromptContext } from '../../aiAgents/runnerPrompt';

/** Fixed synthetic context shared by capture prompts, byte counts and tests. */
export const HELPER_CAPTURE_FIXTURE: Parameters<typeof buildHelperSystemPrompt>[0] = {
  hostname: 'capture-fixture-host',
  deviceId: '00000000-0000-4000-8000-000000000001',
  orgId: '00000000-0000-4000-8000-000000000002',
  permissionLevel: 'basic',
  osType: 'linux',
  osVersion: 'capture-fixture-os',
  agentVersion: '0.0.0-capture-fixture',
};

/** A full-profile manual shadow run; no database rows or policy lookup. */
export const AGENT_CAPTURE_FIXTURE: AgentRunPromptContext = {
  agent: { name: 'capture-fixture-agent', kind: 'triage' },
  run: { id: '00000000-0000-4000-8000-000000000003', mode: 'shadow', triggerKind: 'manual' },
  device: {
    id: HELPER_CAPTURE_FIXTURE.deviceId,
    hostname: HELPER_CAPTURE_FIXTURE.hostname,
    osType: 'linux',
  },
  profile: 'full',
  instructions: null,
  alert: null,
  ticket: null,
  anomaly: null,
  correlationGroup: null,
  sweep: null,
  narrative: null,
  design: null,
};

/** An `analysis`-profile run: device-less, a goal, no staged handles. */
export const AGENT_ANALYSIS_CAPTURE_FIXTURE: AgentRunPromptContext = {
  ...AGENT_CAPTURE_FIXTURE,
  agent: { name: 'capture-fixture-analyst', kind: 'triage' },
  device: null,
  profile: 'analysis',
  analysis: { goal: 'Summarise CPU utilisation across the fleet for the last 7 days.', deviceIds: [], handles: [] },
};
