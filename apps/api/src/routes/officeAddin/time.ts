import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { officeAddinTechAuthMiddleware, requireAddinCapability } from '../../middleware/officeAddinTechAuth';
import type { OfficeAddinTechAuth } from '../../middleware/officeAddinTechAuth';
import {
  createTimeEntry,
  getRunningTimer,
  startTimer,
  stopTimer,
  TimeEntryServiceError,
  type TimeEntryActor,
} from '../../services/timeEntryService';
import { addinLogTimeSchema, addinStartTimerSchema, addinStopTimerSchema } from './schemas';
import type { AddinRunningTimerEntry } from '@breeze/shared';

/**
 * Tech add-in time-tracking endpoints (Task 18). A deliberately NARROW slice of
 * `timeEntryService` — just the technician's own running/start/stop/log
 * actions. No bulk approval, timesheet, arbitrary update, or delete route
 * exists here (those stay on the web-only `timeEntriesApiRoutes`); this router
 * exposes only the "internal-only" surface `timeEntryService.ts` describes
 * (spec D4), minus anything requiring `manageAll`.
 */
export const officeAddinTimeRoutes = new Hono();

officeAddinTimeRoutes.use('*', officeAddinTechAuthMiddleware);

/**
 * Builds a `TimeEntryActor` from the add-in principal. Mirrors
 * `timeActorFrom` in routes/timeEntries/timeEntries.ts, but `manageAll` is
 * hardcoded false — the add-in never grants approve/manage-others-entries
 * regardless of the technician's web RBAC, since none of these routes accept
 * another user's entry id.
 */
function addinTimeActorFrom(auth: OfficeAddinTechAuth): TimeEntryActor {
  return {
    userId: auth.userId,
    name: auth.user.name ?? undefined,
    email: auth.user.email,
    partnerId: auth.partnerId,
    manageAll: false,
    accessibleOrgIds: auth.accessibleOrgIds,
  };
}

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof TimeEntryServiceError) {
    return c.json({ error: err.code ?? err.message }, err.status);
  }
  throw err;
}

interface RunningTimerRow {
  id: string;
  ticketId: string | null;
  ticketNumber: string | null;
  startedAt: Date;
  description: string | null;
}

// Returns the @breeze/shared wire type so drift between this projection and
// the add-in client fails to compile instead of surfacing at runtime.
function toRunningTimerResponse(entry: RunningTimerRow): AddinRunningTimerEntry {
  return {
    id: entry.id,
    ticketId: entry.ticketId,
    ticketInternalNumber: entry.ticketNumber,
    startedAt: entry.startedAt.toISOString(),
    description: entry.description,
  };
}

// Registered as '/running' — the router is mounted under '/time' in ./index.ts,
// so the external path stays GET /office-addin/time/running (same for
// '/start', '/stop' and '/log' below).
officeAddinTimeRoutes.get('/running', requireAddinCapability('time-read'), async (c) => {
  const auth = c.get('officeAddinAuth');
  const running = await getRunningTimer(auth.userId);
  return c.json({ running: running ? toRunningTimerResponse(running) : null });
});

officeAddinTimeRoutes.post(
  '/start',
  requireAddinCapability('time-write'),
  zValidator('json', addinStartTimerSchema),
  async (c) => {
    const auth = c.get('officeAddinAuth');
    const actor = addinTimeActorFrom(auth);
    const input = c.req.valid('json');
    try {
      // startTimer auto-stops any timer already running for this user
      // (timeEntryService.ts D3), but its return value is only the newly
      // started entry. Read the prior running timer first so the response
      // can surface what — if anything — just got auto-stopped.
      const prior = await getRunningTimer(auth.userId);
      const entry = await startTimer(input, actor);
      const autoStopped = prior && prior.id !== entry.id ? toRunningTimerResponse(prior) : null;
      return c.json({ entry, autoStopped }, 201);
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);

officeAddinTimeRoutes.post(
  '/stop',
  requireAddinCapability('time-write'),
  zValidator('json', addinStopTimerSchema),
  async (c) => {
    const auth = c.get('officeAddinAuth');
    const actor = addinTimeActorFrom(auth);
    const input = c.req.valid('json');
    try {
      const entry = await stopTimer(input, actor);
      return c.json({ entry });
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);

officeAddinTimeRoutes.post(
  '/log',
  requireAddinCapability('time-write'),
  zValidator('json', addinLogTimeSchema),
  async (c) => {
    const auth = c.get('officeAddinAuth');
    const actor = addinTimeActorFrom(auth);
    const input = c.req.valid('json');
    try {
      const entry = await createTimeEntry(input, actor);
      return c.json({ entry }, 201);
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);
