// Classifies a refused POST /messages (#9427) so the side panel and every
// workspace tab react identically. Mirrors the branches aiStore.sendMessage
// has today; this module only decides, it issues no requests.
import { RECOVERABLE_MODEL_CODES } from './aiModelPickerStore';

export type SendRefusal = 'attach' | 'continuation' | 'choose_model' | 'credits' | 'error';

export function classifySendRefusal(status: number, code: string | null): SendRefusal {
  if (status === 409) {
    // Uncoded 409 (older API) can only mean another turn is running.
    if (code === null || code === 'turn_in_progress') return 'attach';
    if (code === 'continuation_required') return 'continuation';
    if (code === 'topology_model_changed' || RECOVERABLE_MODEL_CODES.has(code)) return 'choose_model';
    return 'error';
  }
  if (status === 402 && code !== null) return 'credits';
  return 'error';
}
