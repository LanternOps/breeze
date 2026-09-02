// apps/api/src/services/instanceIdentity.ts
import { randomUUID } from 'crypto';

// Identity of this process instance (wave 3.5b, #4084). Regenerated every
// boot — a presence lease naming a dead instance simply ages out via TTL, so
// there is deliberately no persistence and no bootId beyond this.
export const INSTANCE_ID = randomUUID();
