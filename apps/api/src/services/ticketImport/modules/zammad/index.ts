import type { TicketImportModule } from '../../moduleContract';
import { catalogZammad, connectZammad } from './access';
import { fetchZammadAttachment, probeZammad } from './attachments';
import { convertZammadTicket } from './conversion';
import { isZammadSourceArticleId } from './ids';
import { zammadOptionsSchema, type ZammadOptions } from './options';
import { loadZammad, scanZammad, type ZammadCursor } from './reading';

/**
 * The Zammad 7.2.x import module (#8313 W5; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §6): shapes from the 7.2.2 source, validated later against a live 7.2.0.
 * Any 7.2.x connects; another version connects with a warning. It reads
 * through the REST API with an agent token and needs no Elasticsearch: the
 * id-ordered ticket list plus the framework's ledger make the delta
 * (decision 12).
 *
 * Files: `api.ts` (the calls), `shapes.ts` (the 7.2.x JSON), `directory.ts`
 * (users, states and priorities, cached 30 minutes), `access.ts` (connect,
 * catalog), `reading.ts` (scan, load), `mapping.ts` and `conversion.ts` (the
 * pure conversion), `attachments.ts` (files, probe), `ids.ts` (the id
 * grammar), `options.ts`. Fixtures and the fake server: `__fixtures__/`,
 * `fakeZammad.fixtures.ts`.
 */
export const ZAMMAD_MODULE_ID = 'zammad';

export const zammadTicketImportModule: TicketImportModule<ZammadOptions, ZammadCursor> = {
  id: ZAMMAD_MODULE_ID,
  label: 'Zammad 7.2',
  optionsSchema: zammadOptionsSchema,
  connect: connectZammad,
  catalog: catalogZammad,
  scan: scanZammad,
  load: loadZammad,
  convert: convertZammadTicket,
  fetchAttachment: fetchZammadAttachment,
  probe: probeZammad,
  isSourceArticleId: isZammadSourceArticleId,
};
