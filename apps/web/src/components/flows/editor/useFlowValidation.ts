import { useEffect, useRef, useState } from 'react';
import type { FlowValidationResult } from '@breeze/shared';
import { validateFlowDraftDocument } from '../api';

export const VALIDATION_DEBOUNCE_MS = 400;

export interface ValidationOwner {
  ownerScope?: 'organization' | 'partner';
  orgId?: string;
}

/**
 * Live validation for the editor: debounced `POST /flows/validate` (writes
 * nothing). `document` is null while the text does not parse, and then
 * nothing is sent. With a `flowId` the server takes the owner from the row
 * (shadow-draft allowances included), so `owner` only matters on create.
 * Only the newest request's answer is kept.
 */
export function useFlowValidation(
  document: unknown | null,
  owner: ValidationOwner,
  flowId: string | undefined,
): { validation: FlowValidationResult | null; error: string | null; pending: boolean } {
  const [validation, setValidation] = useState<FlowValidationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const seq = useRef(0);

  // A stable key: the document is rebuilt on every keystroke, so key on its content.
  const key = document === null ? null : JSON.stringify([document, owner.ownerScope ?? null, owner.orgId ?? null, flowId ?? null]);

  useEffect(() => {
    if (key === null) return;
    const [doc, ownerScope, orgId, id] = JSON.parse(key) as [unknown, ValidationOwner['ownerScope'] | null, string | null, string | null];
    const mine = ++seq.current;
    setPending(true);
    const timer = setTimeout(() => {
      validateFlowDraftDocument({
        document: doc,
        ...(ownerScope ? { ownerScope } : {}),
        ...(orgId ? { orgId } : {}),
        ...(id ? { flowId: id } : {}),
      })
        .then((result) => {
          if (mine !== seq.current) return;
          setValidation(result);
          setError(null);
        })
        .catch((err: unknown) => {
          if (mine !== seq.current) return;
          setValidation(null);
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (mine === seq.current) setPending(false);
        });
    }, VALIDATION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key]);

  return { validation, error, pending };
}
