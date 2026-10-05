import type { ApiResponse } from './api';
export async function runAction<T>({ request, onOutcome, successMessage, errorFallback, validate }: {
  request: () => Promise<ApiResponse<T>>; onOutcome: (message: string, error: boolean) => void;
  successMessage: string; errorFallback: string; validate?: (data: T) => boolean;
}): Promise<T | null> {
  try {
    const result = await request();
    const body = result.data as { success?: boolean; testResult?: { success?: boolean } } | undefined;
    if (result.error || !result.data || (result.statusCode ?? 200) >= 400 || body?.success === false ||
      body?.testResult?.success === false || (validate && !validate(result.data))) {
      onOutcome(result.error || errorFallback, true); return null;
    }
    onOutcome(successMessage, false); return result.data;
  } catch { onOutcome(errorFallback, true); return null; }
}
