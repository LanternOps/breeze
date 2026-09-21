// AI Operator task targets and their frozen provider accounts
// (Recipe Library wave E2, spec §5.1 and §5.2).
//
// Every function takes the caller's transaction handle for the same reason
// eventService.ts and taskOutbox.ts do: a target created outside the admission
// transaction is a target that can exist without its task.
//
// THE POINT OF THE VALIDATION IN HERE. `ai_operator_task_targets` carries two
// CHECK constraints the database will absolutely enforce
// (…_one_pointer_chk, …_kind_pointer_chk). Relying on them alone is still
// wrong: a 23514 raised inside the admission transaction ABORTS it, so a
// caller cannot read back, cannot answer, and the route returns a 500 instead
// of a refusal. These functions therefore refuse first and let the CHECK be
// the backstop it is meant to be.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  aiOperatorTaskTargetAccounts,
  aiOperatorTaskTargets,
  type AiOperatorAccountProvider,
  type AiOperatorTargetKind,
} from '../../db/schema/aiOperatorTaskGraph';
import { contactExternalLinks } from '../../db/schema/contacts';
import { appendTaskEvent, type TaskEventActor } from './eventService';

/** Mirrors `ai_operator_task_targets_label_len_chk`. */
const MAX_TARGET_LABEL_CHARS = 255;
/** Mirrors `ai_operator_task_target_accounts_external_id_len_chk`. */
const MAX_EXTERNAL_ID_CHARS = 255;
/** Mirrors `ai_operator_task_target_accounts_principal_label_len_chk`. */
const MAX_PRINCIPAL_LABEL_CHARS = 320;

/**
 * The `contact_external_links.system` values the Operator owns.
 *
 * That column is free-form `text` with NO CHECK and NO enum
 * (2026-08-19-contacts.sql:178) and is shared with the CSV and PSA importers
 * ('csv', 'datto_rmm', 'connectwise', …), so nothing in the database stops a
 * typo. A mistyped system would create a SECOND identity row for the same
 * person that no later lookup ever matches — which, for an offboarding recipe,
 * means silently failing to disable an account. Pin it here.
 */
export const CONTACT_LINK_SYSTEMS = ['m365', 'google'] as const;
export type ContactLinkSystem = (typeof CONTACT_LINK_SYSTEMS)[number];

export type TargetDbHandle = Pick<typeof db, 'insert' | 'update' | 'select'>;

const KIND_TO_COLUMN = {
  device: 'deviceId',
  ticket: 'ticketId',
  contact: 'contactId',
} as const satisfies Record<AiOperatorTargetKind, 'deviceId' | 'ticketId' | 'contactId'>;

/** Which pointer column a target kind must use. Exported so callers and tests
 *  cannot re-derive it differently. */
export function targetColumnForKind(kind: AiOperatorTargetKind): 'deviceId' | 'ticketId' | 'contactId' {
  return KIND_TO_COLUMN[kind];
}

export interface CreateTaskTargetInput {
  orgId: string;
  taskId: string;
  targetKind: AiOperatorTargetKind;
  deviceId?: string | null;
  ticketId?: string | null;
  contactId?: string | null;
  /** Frozen display label. Survives every detach — it is the evidence. */
  targetLabel: string;
  targetOrdinal: number;
  /** Written as a `target_attached` event when supplied. Omit inside a
   *  backfill or a bulk path that writes its own event. */
  actor?: TaskEventActor;
}

export async function createTaskTarget(
  dbh: TargetDbHandle,
  input: CreateTaskTargetInput,
): Promise<{ id: string }> {
  const pointers = {
    deviceId: input.deviceId ?? null,
    ticketId: input.ticketId ?? null,
    contactId: input.contactId ?? null,
  };
  const set = Object.values(pointers).filter((v) => v !== null);
  if (set.length !== 1) {
    throw new Error(
      `[aiOperator] createTaskTarget: exactly one pointer must be set, got ${set.length} `
      + `(device=${pointers.deviceId}, ticket=${pointers.ticketId}, contact=${pointers.contactId})`,
    );
  }
  const required = targetColumnForKind(input.targetKind);
  if (pointers[required] === null) {
    throw new Error(
      `[aiOperator] createTaskTarget: target_kind '${input.targetKind}' requires ${required}`,
    );
  }

  const [row] = await dbh
    .insert(aiOperatorTaskTargets)
    .values({
      orgId: input.orgId,
      taskId: input.taskId,
      targetKind: input.targetKind,
      ...pointers,
      targetLabel: input.targetLabel.slice(0, MAX_TARGET_LABEL_CHARS),
      targetOrdinal: input.targetOrdinal,
      state: 'active',
    })
    .returning({ id: aiOperatorTaskTargets.id });

  if (input.actor) {
    await appendTaskEvent(dbh, {
      orgId: input.orgId,
      taskId: input.taskId,
      eventType: 'target_attached',
      actor: input.actor,
      targetId: row.id,
      detail: `${input.targetKind} target ${input.targetLabel} frozen at ordinal ${input.targetOrdinal}`,
    });
  }

  return row;
}

export interface FreezeTargetAccountInput {
  orgId: string;
  taskId: string;
  targetId: string;
  provider: AiOperatorAccountProvider;
  /** The m365_connections / google_workspace_connections row id, or null when
   *  the recipe resolved the account without a live connection. */
  connectionId: string | null;
  /** Entra object id / Google user id — immutable, NEVER the UPN. */
  externalId: string;
  /** UPN / primary email at admission. Display only. */
  principalLabel: string;
  actor?: TaskEventActor;
}

/**
 * Freeze one provider account onto a target.
 *
 * `ON CONFLICT (org_id, task_id, provider) DO UPDATE` rather than DO NOTHING:
 * re-running intake after the technician corrects the person must replace the
 * frozen account, and DO NOTHING would silently keep the WRONG one — the
 * highest-consequence failure in the whole recipe (spec §11, first risk row).
 * Replacing is safe because nothing has been dispatched yet: the plan approval
 * (wave E4) pins the effect set AFTER accounts are frozen, and any change to
 * the account set bumps `revision` and supersedes an existing approval.
 */
export async function freezeTargetAccount(
  dbh: TargetDbHandle,
  input: FreezeTargetAccountInput,
): Promise<{ id: string }> {
  const values = {
    orgId: input.orgId,
    taskId: input.taskId,
    targetId: input.targetId,
    provider: input.provider,
    m365ConnectionId: input.provider === 'm365' ? input.connectionId : null,
    googleConnectionId: input.provider === 'google' ? input.connectionId : null,
    externalId: input.externalId.slice(0, MAX_EXTERNAL_ID_CHARS),
    principalLabel: input.principalLabel.slice(0, MAX_PRINCIPAL_LABEL_CHARS),
  };

  const [row] = await dbh
    .insert(aiOperatorTaskTargetAccounts)
    .values(values)
    .onConflictDoUpdate({
      target: [
        aiOperatorTaskTargetAccounts.orgId,
        aiOperatorTaskTargetAccounts.taskId,
        aiOperatorTaskTargetAccounts.provider,
      ],
      set: {
        targetId: values.targetId,
        m365ConnectionId: values.m365ConnectionId,
        googleConnectionId: values.googleConnectionId,
        externalId: values.externalId,
        principalLabel: values.principalLabel,
        updatedAt: new Date(),
      },
    })
    .returning({ id: aiOperatorTaskTargetAccounts.id });

  if (input.actor) {
    await appendTaskEvent(dbh, {
      orgId: input.orgId,
      taskId: input.taskId,
      eventType: 'target_account_frozen',
      actor: input.actor,
      targetId: input.targetId,
      // The external id, not the label: the label can change under us, and
      // this line is the audit trail for WHICH account was addressed.
      detail: `${input.provider} account ${values.externalId} (${values.principalLabel}) frozen`,
    });
  }

  return row;
}

export interface DetachTargetsInput {
  orgId: string;
  /** Detach every target of one task… */
  taskId?: string;
  /** …or exactly one target. Supply one of the two, not neither. */
  targetId?: string;
  reason: 'device_moved' | 'device_deleted' | 'org_merged' | 'scope_invalidated';
  actor?: TaskEventActor;
  detail?: string;
}

/**
 * Detach targets, clearing every pointer and stamping the reason.
 *
 * ALL THREE POINTERS ARE CLEARED TOGETHER, and `detached_at` is stamped in the
 * SAME statement. `ai_operator_task_targets_one_pointer_chk` demands exactly
 * one pointer when the row is not detached and exactly zero when it is, so a
 * partial clear is unrepresentable — which is the constraint doing its job,
 * and why every caller that nulls a pointer (moveOrg, deviceDeletion,
 * moveTicketOrg, deleteContact, the merge fence) stamps in the same UPDATE.
 *
 * COALESCE on the stamp makes this convergent with those SQL-level statements:
 * whichever runs first wins the reason, the rest are no-ops.
 */
export async function detachTargets(
  dbh: TargetDbHandle,
  input: DetachTargetsInput,
): Promise<number> {
  if (!input.taskId && !input.targetId) {
    throw new Error('[aiOperator] detachTargets: supply taskId or targetId');
  }

  const rows = await dbh
    .update(aiOperatorTaskTargets)
    .set({
      deviceId: null,
      ticketId: null,
      contactId: null,
      detachedAt: sql`COALESCE(${aiOperatorTaskTargets.detachedAt}, now())`,
      detachedReason: sql`COALESCE(${aiOperatorTaskTargets.detachedReason}, ${input.reason})`,
      state: 'detached',
      updatedAt: new Date(),
    })
    .where(and(
      eq(aiOperatorTaskTargets.orgId, input.orgId),
      input.targetId ? eq(aiOperatorTaskTargets.id, input.targetId) : undefined,
      input.taskId ? eq(aiOperatorTaskTargets.taskId, input.taskId) : undefined,
    ))
    .returning({ id: aiOperatorTaskTargets.id, taskId: aiOperatorTaskTargets.taskId });

  if (input.actor) {
    for (const row of rows) {
      await appendTaskEvent(dbh, {
        orgId: input.orgId,
        taskId: row.taskId,
        eventType: 'target_detached',
        actor: input.actor,
        targetId: row.id,
        detail: input.detail ?? `target detached: ${input.reason}`,
      });
    }
  }

  return rows.length;
}

export interface UpsertContactExternalLinksInput {
  orgId: string;
  contactId: string;
  links: ReadonlyArray<{ system: ContactLinkSystem; externalId: string }>;
}

/**
 * Record a contact's provider identities so the NEXT task can re-identify the
 * same person without asking again (spec §5.2, D2: "Admission resolves or
 * creates the contact, upserts contact_external_links with system ∈
 * ('m365','google'), and freezes the external ids onto the task").
 *
 * `contact_external_links_uniq` is `(org_id, system, external_id)` — ORG-scoped
 * and deliberately not partner-scoped, because one person can work for two of
 * an MSP's customers. `DO NOTHING` on conflict: if the pair already points at
 * a DIFFERENT contact, two contact rows describe one provider account, which
 * is a data-quality problem for the intake step to surface to a human — it is
 * NOT something to resolve by silently repointing a link that other tasks may
 * already rely on.
 */
export async function upsertContactExternalLinks(
  dbh: TargetDbHandle,
  input: UpsertContactExternalLinksInput,
): Promise<number> {
  if (input.links.length === 0) return 0;

  const inserted = await dbh
    .insert(contactExternalLinks)
    .values(input.links.map((link) => ({
      orgId: input.orgId,
      contactId: input.contactId,
      system: link.system,
      externalId: link.externalId,
    })))
    .onConflictDoNothing({
      target: [
        contactExternalLinks.orgId,
        contactExternalLinks.system,
        contactExternalLinks.externalId,
      ],
    })
    .returning({ id: contactExternalLinks.id });

  return inserted.length;
}
