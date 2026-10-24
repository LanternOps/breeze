/**
 * IOC import — `POST /security/yara/rule-sets/:id/ioc-import` (#6263 W04-1).
 *
 * The client sends STRUCTURED IOCs (`{ kind, value }[]`, the preview's kind
 * overrides included), never rule text. The server re-validates them and
 * re-generates the rules with the same pure generator the browser preview
 * uses (`@breeze/shared` `generateIocRules`), so what is saved is byte-identical
 * to what was previewed.
 *
 * Writes keep W03's gates exactly: `writeDenial` (built-in → 403, site
 * ceiling, partner-wide → `canManagePartnerWidePolicies`) and `devices:write`.
 * The set row is locked (`FOR UPDATE`) before the existing-name lookup and the
 * 500-rule count, so two concurrent imports cannot both pass the cap. The
 * inserts run in one savepoint and the set is published in the same request
 * transaction; the response carries W03's `publish` body.
 *
 * Audit details carry ids and counts only — never an IOC value, the label or
 * generated rule names (both embed customer text).
 *
 * The import itself lives in `services/yaraIocImportService.ts` (#6268), which
 * the AI `ioc_hunt import_iocs` action shares; this route maps its outcome onto
 * the same status codes and bodies it always returned.
 */
import { Hono } from 'hono';

import { requirePermission, requireScope } from '../../middleware/auth';
import { zValidator } from '../../lib/validation';
import { writeRouteAudit } from '../../services/auditEvents';
import { importIocsIntoSet } from '../../services/yaraIocImportService';
import { yaraIocImportSchema, yaraRuleSetIdParamSchema } from './yaraSchemas';

export const yaraIocImportRoutes = new Hono();

yaraIocImportRoutes.post(
  '/yara/rule-sets/:id/ioc-import',
  requireScope('organization', 'partner', 'system'),
  requirePermission('devices', 'write'),
  zValidator('param', yaraRuleSetIdParamSchema),
  zValidator('json', yaraIocImportSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const outcome = await importIocsIntoSet(c.get('auth'), id, c.req.valid('json'));
    if (!outcome.ok) return c.json(outcome.body, outcome.status);
    writeRouteAudit(c, outcome.audit);
    return c.json(outcome.body, 201);
  },
);
