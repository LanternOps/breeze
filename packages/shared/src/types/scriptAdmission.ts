export type ScriptTargetAdmission = {
  requestedDeviceId: string;
  admission: 'admitted' | 'excluded' | 'suppressed' | 'denied';
  reasonCode?: string;
  executionId?: string;
  commandId?: string;
  batchId?: string;
  // #5128 W2 — only set on `admitted` targets: whether the command reached
  // the agent immediately or was queued for the device's next reconnect.
  delivery?: 'delivered' | 'queued_offline';
};

export type ScriptAdmissionResult = {
  requestId: string;
  status: 'queued' | 'partially_queued' | 'rejected';
  targets: ScriptTargetAdmission[];
};
