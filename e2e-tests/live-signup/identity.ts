import { randomBytes } from 'crypto';

export interface Identity {
  email: string;
  password: string;
  name: string;
  companyName: string;
}

/** runId + layer ('api' | 'ui') -> a unique canary identity the API latch accepts. */
export function makeIdentity(runId: string, layer: 'api' | 'ui'): Identity {
  const rand = randomBytes(9).toString('base64url');
  return {
    email: `signup-canary+${runId}-${layer}@2breeze.app`,
    password: `Cy-${rand}-${randomBytes(6).toString('base64url')}9!`,
    name: 'Signup Canary',
    companyName: `Canary ${runId} ${layer}`,
  };
}

export function makeRunId(): string {
  return `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
}
