import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * WHO DECIDED a device mutation (#5022 W01).
 *
 * Deliberately NOT folded into `triggerTypeEnum`: trigger_type says what
 * SCHEDULED a run, this says who decided. An AI can kick off a policy-driven
 * run and a human can hand-run an AI-authored script, so collapsing them would
 * destroy information.
 *
 * NULL means "AI initiation not recorded", never "a human did this".
 *
 * Defined in its own leaf module (no imports beyond drizzle) because three
 * schema modules need it -- `scripts.ts`, `devices.ts` and `actionIntents.ts`
 * -- and `scripts.ts` already imports `devices.ts`, so hosting the enum in
 * either of those would close an import cycle between schema modules.
 */
export const aiInitiatorKindEnum = pgEnum('ai_initiator_kind', ['ai_assistant', 'ai_agent']);
