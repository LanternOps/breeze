/**
 * #8313 (spec docs/superpowers/specs/api-platform/2026-10-10-ticket-migration-windows-design.md
 * §4.5): in the five ticket writes import mode reaches, every side effect
 * goes through the mode-aware `ticketSideEffects(mode)`, so an import emits,
 * queues and audits nothing. A source scan in the style of
 * no-silent-mutations.test.ts: a side effect added to one of these functions
 * later fails here instead of firing during an import.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(join(__dirname, 'ticketService.ts'), 'utf8');

const IMPORT_MODE_FUNCTIONS = [
  'createTicket',
  'updateTicketFields',
  'changeTicketStatus',
  'assignTicket',
  'addTicketComment',
] as const;

const SIDE_EFFECTS = ['emitTicketEvent', 'writeTicketOutbox', 'createAuditLogAsync', 'emitTicketTriageFeedback'] as const;

/** Drops line and block comments; ticketService.ts has no string literal holding '//' or '/*'. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The text of a top-level `export async function name(` up to its closing brace at column 0. */
function functionSource(name: string): string {
  const start = SOURCE.indexOf(`export async function ${name}(`);
  if (start < 0) throw new Error(`ticketService.ts no longer declares ${name}`);
  const end = SOURCE.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`could not find the end of ${name}`);
  return stripComments(SOURCE.slice(start, end + 2));
}

describe('import mode side effects are confined to ticketSideEffects (spec §4.5)', () => {
  it.each(IMPORT_MODE_FUNCTIONS)('%s takes a TicketWriteMode defaulting to live and builds its side effects from it', (name) => {
    const body = functionSource(name);
    expect(body).toMatch(/mode: TicketWriteMode = LIVE_TICKET_WRITE/);
    expect(body).toMatch(/const fx = ticketSideEffects\(mode\);/);
  });

  it.each(IMPORT_MODE_FUNCTIONS)('%s calls no side effect directly', (name) => {
    const body = functionSource(name);
    for (const effect of SIDE_EFFECTS) {
      // A call not reached through `fx.` (or any other member access).
      const direct = new RegExp(`(?<![.\\w])${effect}\\s*\\(`);
      expect(body, `${name} calls ${effect} directly`).not.toMatch(direct);
    }
    // The outbox table is written only through writeTicketOutbox.
    expect(body, `${name} inserts into ticket_outbox directly`).not.toMatch(/insert\(\s*ticketOutbox\s*\)/);
  });

  it('every write the Partner API makes still produces its live side effects through fx', () => {
    expect(functionSource('createTicket')).toMatch(/fx\.writeTicketOutbox\(input\.orgId, ticket\.id, 'ticket\.created'/);
    expect(functionSource('changeTicketStatus')).toMatch(/fx\.emitTicketEvent\(\{\s*type: 'ticket\.status_changed'/);
    expect(functionSource('updateTicketFields')).toMatch(/fx\.writeTicketOutbox\(ticket\.orgId, ticketId, 'ticket\.updated'/);
    expect(functionSource('assignTicket')).toMatch(/fx\.writeTicketOutbox\(ticket\.orgId, ticketId, 'ticket\.assigned'/);
    expect(functionSource('addTicketComment')).toMatch(/fx\.writeTicketOutbox\(ticket\.orgId, ticketId, 'ticket\.commented'/);
  });

  // #8313 W1 (spec 2026-10-19 §4.3.1): the reservation and skip-delete
  // statements, and the reserve / store steps around them, run inside
  // importTicket's transactions with no write mode at all, so they must not
  // reach a side effect by any path: not directly, not through fx.
  it.each([
    'ticketImport/importAttachments.ts',
    'ticketImport/chunkAttachments.ts',
    'ticketImport/storeAttachments.ts',
  ])('%s takes no write mode and calls none of the side-effect helpers at all', (file) => {
    const body = stripComments(readFileSync(join(__dirname, file), 'utf8'));
    for (const effect of SIDE_EFFECTS) {
      expect(body, `${file} calls ${effect}`).not.toMatch(new RegExp(`\\b${effect}\\s*\\(`));
    }
    expect(body, `${file} builds side effects`).not.toMatch(/ticketSideEffects\s*\(/);
    expect(body, `${file} writes the outbox`).not.toMatch(/\bticketOutbox\b|ticket_outbox/);
    expect(body, `${file} takes a write mode`).not.toMatch(/TicketWriteMode|kind:\s*['"]import['"]/);
  });

  it('the scan really finds a direct call (self-check)', () => {
    const planted = stripComments('export async function x() {\n  await writeTicketOutbox(a, b, c);\n  await fx.emitTicketEvent({});\n}\n');
    expect(planted).toMatch(/(?<![.\w])writeTicketOutbox\s*\(/);
    expect(planted).not.toMatch(/(?<![.\w])emitTicketEvent\s*\(/);
    // The import-attachment scan above also catches a call through fx.
    expect(planted).toMatch(/\bemitTicketEvent\s*\(/);
  });
});
