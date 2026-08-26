export type ScriptTargetAdmission = {
  requestedDeviceId: string;
  admission: 'admitted' | 'excluded' | 'suppressed' | 'denied';
  reasonCode?: string;
  executionId?: string;
  commandId?: string;
  batchId?: string;
};

export type ScriptAdmissionResult = {
  requestId: string;
  status: 'queued' | 'partially_queued' | 'rejected';
  targets: ScriptTargetAdmission[];
};
