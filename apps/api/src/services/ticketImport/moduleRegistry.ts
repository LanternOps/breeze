import { z } from 'zod';
import type { AnyTicketImportModule } from './moduleContract';
import { zammadTicketImportModule } from './modules/zammad';

/**
 * The import modules this build ships (#8313 W4, W5; spec 2026-10-19 §5.1,
 * §6). A source row names its module by id. Zammad 7.2 is the first (W5).
 * Tests register the fake module (testing/fakeModule.ts) through
 * `registerTicketImportModule` and remove it afterwards.
 */
const BUILT_IN_MODULES: readonly AnyTicketImportModule[] = [zammadTicketImportModule];

const registered = new Map<string, AnyTicketImportModule>(BUILT_IN_MODULES.map((m) => [m.id, m]));

export function getTicketImportModule(id: string): AnyTicketImportModule | null {
  return registered.get(id) ?? null;
}

export function listTicketImportModules(): AnyTicketImportModule[] {
  return [...registered.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The modules route's view: the options schema as JSON Schema, for the wizard. */
export function describeTicketImportModule(module: AnyTicketImportModule): { id: string; label: string; optionsSchema: unknown } {
  let optionsSchema: unknown = null;
  try {
    optionsSchema = z.toJSONSchema(module.optionsSchema);
  } catch {
    // A schema JSON Schema cannot express (a transform): the wizard falls back to the module's own form.
    optionsSchema = null;
  }
  return { id: module.id, label: module.label, optionsSchema };
}

/** Registers a module; returns the function that removes it again. Tests only. */
export function registerTicketImportModule(module: AnyTicketImportModule): () => void {
  if (module.id.length === 0 || module.id.length > 32) throw new Error('A module id is 1..32 characters');
  if (registered.has(module.id) && registered.get(module.id) !== module) {
    throw new Error(`Ticket import module '${module.id}' is already registered`);
  }
  registered.set(module.id, module);
  return () => {
    if (registered.get(module.id) === module) registered.delete(module.id);
  };
}
