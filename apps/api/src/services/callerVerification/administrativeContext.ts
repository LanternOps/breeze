/**
 * Request-local interactive step-up proof (#6354 W05).
 *
 * The administrative factory never accepts a session id or epochs from the
 * request body or the caller-supplied actor. Only the authenticated
 * interactive route populates this context, from the verified access token
 * (`sid` is the refresh-token family id; `aep`/`mep` are the signed epochs).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { CallerVerificationValidationError } from './errors';

export type InteractiveProof = { userId: string; sid: string; authEpoch: number; mfaEpoch: number };

const proofs = new AsyncLocalStorage<InteractiveProof>();

export function withAdministrativeProof<T>(proof: InteractiveProof, fn: () => Promise<T>): Promise<T> {
  return proofs.run(proof, fn);
}

export function administrativeProofFor(userId: string): InteractiveProof {
  const proof = proofs.getStore();
  if (!proof || proof.userId !== userId) {
    throw new CallerVerificationValidationError('interactive_stepup_required', 'Interactive step-up required');
  }
  return proof;
}
