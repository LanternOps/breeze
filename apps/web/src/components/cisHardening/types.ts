export type CisSummary = {
  devicesAudited: number;
  averageScore: number;
  failingDevices: number;
  compliantDevices: number;
};

export type CisFinding = {
  checkId?: string;
  title?: string;
  severity?: string;
  status?: string;
  message?: string;
};

export type ComplianceEntry = {
  result: {
    id: string;
    orgId: string;
    deviceId: string;
    baselineId: string;
    checkedAt: string;
    totalChecks: number;
    passedChecks: number;
    failedChecks: number;
    score: number;
    findings: CisFinding[];
  };
  baseline: {
    id: string;
    orgId: string;
    name: string;
    osType: string;
    level: string;
  };
  device: {
    id: string;
    hostname: string;
    osType: string;
    status: string;
  };
};

export type Baseline = {
  id: string;
  name: string;
  osType: string;
  level: string;
  benchmarkVersion: string;
  scanSchedule?: { enabled?: boolean; intervalHours?: number } | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};
