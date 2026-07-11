export type AbuseSeverity = 'info' | 'watch' | 'alert';

export interface ComputedSignal {
  partnerId: string;
  signalKey: string;
  /** 0-100 after young-account weighting. */
  score: number;
  severity: AbuseSeverity;
  evidence: Record<string, unknown>;
}
