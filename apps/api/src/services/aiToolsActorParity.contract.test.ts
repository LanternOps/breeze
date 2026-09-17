import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, relative } from 'path';
import {
  SERVICES_DIR,
  aiToolsSources,
  blankComments,
  functionBody,
  matchClose,
  walkTs,
} from './__testutils__/aiToolScopeScan';

/**
 * Contract: ACTOR-SHAPE PARITY on the site axis (private audit 2026-09-17 §5.2).
 *
 * Several services do not take an `AuthContext`. They take a hand-built actor
 * struct — `InvoiceActor`, `QuoteActor`, `ContractActor`, … — assembled at the
 * door by a `*ActorFrom`/`actorFromAuth` builder in an `aiTools*.ts` file or a
 * route. Whatever the builder omits, the service can never enforce.
 *
 * `ContractActor` is why this test exists. It shipped WITHOUT `allowedSiteIds`
 * while its two siblings in the same family carried it, so every contract tool
 * — `list_contracts`, `get_contract` and all nine `manage_contracts` actions —
 * read and WROTE org-wide for a site-restricted technician, and the site-gated
 * `manage_invoices add_contract_line` had an ungated read leg bolted to it.
 *
 * No table scan can ever see this: the site logic lives one module away from
 * the table access, so `aiToolsContracts.ts` contains no `contracts` query and
 * `contractService.ts` contains no `AuthContext`. The signal is structural —
 * a builder that returns a `*Actor`-typed object from an auth context and does
 * not mention the field — which is exactly what this file checks.
 *
 * Two contracts:
 *   A. PROPAGATION — every builder of an actor type that DECLARES
 *      `allowedSiteIds` must set it. No baseline: this one fails closed.
 *   B. INVENTORY — the actor types that declare NO site axis at all must equal
 *      a frozen, reasoned list, so a new actor type over site-attributable data
 *      cannot join them silently, and stripping the field from a type that has
 *      it fails here too.
 */

const API_SRC = join(SERVICES_DIR, '..');
const ROUTES_DIR = join(API_SRC, 'routes');

// ----------------------------------------------------------- declarations

/** `<Name>Actor` interface/type declarations → whether they declare the site axis. */
function actorDeclarations(): Map<string, { file: string; hasSiteAxis: boolean }> {
  const found = new Map<string, { file: string; hasSiteAxis: boolean }>();
  for (const path of [...walkTs(SERVICES_DIR), ...walkTs(ROUTES_DIR)]) {
    const src = blankComments(readFileSync(path, 'utf8'));
    const re = /\b(?:interface|type)\s+(\w*Actor)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const open = src.indexOf('{', m.index);
      // `type X = A | null` and friends have no body — not a struct we can check.
      const semi = src.indexOf(';', m.index);
      if (open < 0 || (semi >= 0 && semi < open)) continue;
      const body = src.slice(open, matchClose(src, open, '{', '}') + 1);
      found.set(m[1]!, {
        file: relative(API_SRC, path),
        hasSiteAxis: /\ballowedSiteIds\b/.test(body),
      });
    }
  }
  return found;
}

const ACTOR_DECLARATIONS = actorDeclarations();

// --------------------------------------------------------------- builders

interface ActorBuilder {
  file: string;
  name: string;
  actorType: string;
  body: string;
}

/**
 * Functions that BUILD an actor from an authenticated context.
 *
 * Two shapes are recognised, because both are in use:
 *   - a declaration with a `*Actor` return-type annotation
 *     (`function actorFromAuth(auth: AuthContext): InvoiceActor { … }`,
 *     `export function contractActorFrom(c): ContractActor { … }`);
 *   - an arrow or object literal annotated at the binding
 *     (`const portalActor = (orgId: string): DeliverableActor => ({ … })`,
 *     `const actor: TicketActor = { … }`).
 *
 * A builder counts only when its body reads the authenticated context —
 * `auth.` or `c.get(` — which is what distinguishes a real door from a test
 * fixture or a system/background literal that has no site axis to propagate.
 */
function actorBuilders(): ActorBuilder[] {
  const builders: ActorBuilder[] = [];
  const files = [
    ...aiToolsSources().map((f) => join(SERVICES_DIR, f)),
    ...walkTs(ROUTES_DIR),
  ];
  for (const path of files) {
    const src = blankComments(readFileSync(path, 'utf8'));
    const file = relative(API_SRC, path);

    // Shape 1: a function declaration with a `*Actor` return type.
    const declRe = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = declRe.exec(src)) !== null) {
      const parenClose = matchClose(src, src.indexOf('(', m.index + m[0].length - 1), '(', ')');
      const annotation = /^\s*:\s*(\w*Actor)\b/.exec(src.slice(parenClose + 1));
      if (!annotation) continue;
      const body = functionBody(src, m.index, m[0].length);
      if (body === null) continue;
      builders.push({ file, name: m[1]!, actorType: annotation[1]!, body });
    }

    // Shape 2: an annotated binding — `const x: T = {` / `= (…): T => ({`.
    const bindRe = /\b(?:const|let)\s+(\w+)\s*(?::\s*(\w*Actor)\b|=\s*\([^)]*\)\s*:\s*(\w*Actor)\b)/g;
    while ((m = bindRe.exec(src)) !== null) {
      const actorType = m[2] ?? m[3]!;
      const open = src.indexOf('{', m.index);
      if (open < 0) continue;
      const body = src.slice(open, matchClose(src, open, '{', '}') + 1);
      builders.push({ file, name: m[1]!, actorType, body });
    }
  }
  return builders.filter((b) => /\bauth\./.test(b.body) || /\bc\.get\(/.test(b.body));
}

const ACTOR_BUILDERS = actorBuilders();

describe('contract: actor builders propagate the site axis', () => {
  it('discovers the actor declarations and builders to scan', () => {
    // A collapse here means the naming convention changed and the scan went
    // blind — re-derive it rather than lowering these numbers.
    expect(ACTOR_DECLARATIONS.size).toBeGreaterThanOrEqual(8);
    expect(ACTOR_BUILDERS.length).toBeGreaterThanOrEqual(10);
    // The three billing actors over site-bearing tables must all be seen.
    for (const t of ['InvoiceActor', 'QuoteActor', 'ContractActor']) {
      expect(ACTOR_DECLARATIONS.get(t)?.hasSiteAxis, `${t} must declare allowedSiteIds`).toBe(true);
    }
  });

  it('every builder of a site-carrying actor sets allowedSiteIds', () => {
    const siteCarrying = new Set(
      [...ACTOR_DECLARATIONS].filter(([, d]) => d.hasSiteAxis).map(([name]) => name),
    );
    const dropped = ACTOR_BUILDERS
      .filter((b) => siteCarrying.has(b.actorType) && !/\ballowedSiteIds\b/.test(b.body))
      .map((b) => `${b.file}:${b.name} -> ${b.actorType}`);
    // A failure here is an actor door that silently drops the site axis, the
    // way `ContractActor` did. There is NO baseline: add
    // `allowedSiteIds: auth.allowedSiteIds` to the builder.
    expect(dropped).toEqual([]);
  });

  it('at least one builder of each site-carrying actor is actually covered', () => {
    // Guards the inverse failure: a scan that finds no builders passes the
    // test above vacuously.
    for (const t of ['InvoiceActor', 'QuoteActor', 'ContractActor']) {
      expect(
        ACTOR_BUILDERS.filter((b) => b.actorType === t).length,
        `no builder found for ${t} — the builder scan went blind`,
      ).toBeGreaterThan(0);
    }
  });
});

/**
 * FROZEN INVENTORY — actor types that carry NO site axis, each with the reason
 * it needs none. Every one was checked against the schema: none of the tables
 * these actors govern declares a `site_id` column.
 *
 * Adding an entry is a DECISION, not a formality: if the actor's domain has a
 * `site_id` anywhere, it belongs in the site-carrying set instead. Removing
 * `allowedSiteIds` from a type that has it also fails this test, because the
 * type would appear here unlisted.
 */
const ACTORS_WITHOUT_SITE_AXIS: Readonly<Record<string, string>> = {
  // `catalog_items` / prices / org overrides are partner- and org-owned; no
  // site column anywhere in the catalog schema.
  CatalogActor: 'catalog is partner/org-owned — no site_id in the schema',
  // Spend attribution only (`userId`/`orgId`/`partnerId`), never a read filter.
  EnrichmentActor: 'AI-spend attribution struct, not an authorization actor',
  // `service_deliverables` and their evidence are org-keyed; no site column.
  DeliverableActor: 'service deliverables are org-keyed — no site_id',
  // Template SETS are org- or partner-owned (`resolveOwner`), never site-owned.
  TemplateActor: 'deliverable template sets are org/partner-owned — no site_id',
  ChecklistTemplateActor: 'ticket checklist templates are org/partner-owned — no site_id',
  // Currency is an ORG-level property; a site cannot have its own.
  OrgCurrencyActor: 'org currency is an org-level property',
  // Provenance only — who is behind a ticket write, for field stamping. Ticket
  // site scope is enforced separately, on the query, by
  // `routes/tickets/siteScope.ts` (`deviceInSiteScope` / `ticketSiteScopeCondition`).
  TicketActor: 'write provenance; ticket site scope lives in routes/tickets/siteScope.ts',
  // `time_entries` carry no site column; they hang off a ticket, whose own site
  // scope is enforced on the ticket query.
  TimeEntryActor: 'time entries are ticket-keyed — no site_id',
  SuggestionActor: 'extends TimeEntryActor — same reason',
  // Pure `{ userId }` provenance stamps: who performed the write, recorded on
  // the row. They carry no allowlist of any axis — not even the org one — so
  // their services take the scope from the caller's DB context / route gate,
  // never from the actor. Giving these a site field would imply an enforcement
  // they do not perform.
  ChecklistActor: 'ticket checklist write provenance — { userId } only, no allowlist',
  ContactActor: 'contact write provenance — { userId } only, no allowlist',
  ContactImportActor: 'contact import provenance — { userId } only, no allowlist',
  DefinitionImportActor: 'custom-field definition import provenance — { userId } only',
  OrgImportActor: 'org import provenance — { userId } only, no allowlist',
  ValueImportActor: 'custom-field value import provenance — { userId } only',
  WarrantyConsentActor: 'a `{ userId } | null` consent stamp, not an authorization struct',
  // `GET /devices/:id/billing` is the only caller and it enforces BOTH axes at
  // the door (`getDeviceWithOrgAndSiteCheck`) before calling the service, and is
  // `requireScope('partner','system')` — a scope that never carries
  // `allowedSiteIds` at all. Worth re-reading if a second caller appears: the
  // service itself would then be site-blind.
  DeviceCoverageActor: 'org axis only; its single route gates the site axis at the door and is partner/system scope',
};

describe('contract: the actor types with no site axis are a frozen, reasoned list', () => {
  it('matches the inventory exactly', () => {
    const without = [...ACTOR_DECLARATIONS]
      .filter(([, d]) => !d.hasSiteAxis)
      .map(([name]) => name)
      .sort();
    // A NEW name here is a new actor type with no site axis: confirm its domain
    // really has no `site_id` and add it with a reason — or give the type the
    // field. A name DISAPPEARING from the expected side means a type lost its
    // `allowedSiteIds`, which is the ContractActor regression.
    expect(without).toEqual(Object.keys(ACTORS_WITHOUT_SITE_AXIS).sort());
  });

  it('every inventory entry carries a non-trivial reason', () => {
    for (const [name, reason] of Object.entries(ACTORS_WITHOUT_SITE_AXIS)) {
      expect(reason.length, `${name} needs a real reason`).toBeGreaterThan(20);
    }
  });
});

// --------------------------------------------------------- scanner fixtures
//
// String fixtures, not live source: a fixture cannot be "fixed" out from under
// the proof by a concurrent PR.

describe('scanner: the builder scan discriminates a dropped site axis', () => {
  const scan = (src: string) => {
    const blanked = blankComments(src);
    const out: Array<{ name: string; actorType: string; hasSite: boolean }> = [];
    const declRe = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = declRe.exec(blanked)) !== null) {
      const parenClose = matchClose(blanked, blanked.indexOf('(', m.index + m[0].length - 1), '(', ')');
      const annotation = /^\s*:\s*(\w*Actor)\b/.exec(blanked.slice(parenClose + 1));
      if (!annotation) continue;
      const body = functionBody(blanked, m.index, m[0].length);
      if (body === null || !/\bauth\./.test(body)) continue;
      out.push({ name: m[1]!, actorType: annotation[1]!, hasSite: /\ballowedSiteIds\b/.test(body) });
    }
    return out;
  };

  it('flags the ContractActor shape verbatim', () => {
    expect(scan(`
      function actorFromAuth(auth: AuthContext): ContractActor {
        return {
          userId: auth.user.id,
          partnerId: auth.partnerId ?? null,
          accessibleOrgIds: auth.accessibleOrgIds
        };
      }
    `)).toEqual([{ name: 'actorFromAuth', actorType: 'ContractActor', hasSite: false }]);
  });

  it('accepts it once the field is threaded', () => {
    expect(scan(`
      function actorFromAuth(auth: AuthContext): ContractActor {
        return {
          userId: auth.user.id,
          accessibleOrgIds: auth.accessibleOrgIds,
          allowedSiteIds: auth.allowedSiteIds
        };
      }
    `)).toEqual([{ name: 'actorFromAuth', actorType: 'ContractActor', hasSite: true }]);
  });

  it('a mention in a COMMENT does not count as propagation', () => {
    // The whole reason the source is comment-blanked first: `ContractActor`'s
    // sibling builders carry a prose paragraph about `allowedSiteIds`, which a
    // naive scan would accept as the field being set.
    expect(scan(`
      function actorFromAuth(auth: AuthContext): ContractActor {
        // Site axis: allowedSiteIds is threaded by the caller.
        return { userId: auth.user.id, accessibleOrgIds: auth.accessibleOrgIds };
      }
    `)).toEqual([{ name: 'actorFromAuth', actorType: 'ContractActor', hasSite: false }]);
  });

  it('a function that does not build an actor is ignored', () => {
    expect(scan(`
      function serviceErrorToJson(err: unknown): string | null {
        return auth.user.id;
      }
    `)).toEqual([]);
  });

  it('an object RETURN type is not mistaken for the body', () => {
    // `functionBody` must skip `: { … }` annotations; otherwise a field named
    // in the TYPE would read as propagation.
    expect(scan(`
      function build(auth: AuthContext): QuoteActor {
        return { userId: auth.user.id, allowedSiteIds: auth.allowedSiteIds };
      }
    `)).toEqual([{ name: 'build', actorType: 'QuoteActor', hasSite: true }]);
  });
});
