export interface FidelityCheckInput { baseUrl: string; authMode: 'x-api-key'|'bearer'; providerModel: string; apiKey: string; }
export interface FidelityCheckResult { passed: boolean; steps: Array<{ name: string; ok: boolean; detail?: string }>; harnessVersion: string; }
export async function runFidelityCheck(input: FidelityCheckInput): Promise<FidelityCheckResult> {
  throw new Error('fidelity harness not implemented');
}
