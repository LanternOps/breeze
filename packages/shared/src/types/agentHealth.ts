export type AgentHealthState = 'healthy' | 'warning' | 'error' | 'unknown';

export type AgentHealthComponent = {
  state: AgentHealthState;
  reason?: string;
};

export type AgentHealthObservation = {
  schemaVersion: 1;
  deviceId: string;
  agentVersion: string;
  overall: AgentHealthState;
  metricsAvailable: boolean | null;
  components: Record<string, AgentHealthComponent>;
  observedAt: string;
};

export type AgentHealthObservationWireV1 = Omit<AgentHealthObservation, 'deviceId'> & {
  deviceId?: string;
};
