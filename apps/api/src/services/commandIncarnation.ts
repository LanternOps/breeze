import { and, sql, type SQL } from 'drizzle-orm';
import { deviceCommands } from '../db/schema';

/**
 * Install incarnations on commands (#8318 wave 1a, spec
 * docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
 * §4.1, §4.2, §5.2).
 *
 * Every `device_commands` row is stamped at insert with the
 * `devices.install_incarnation` it was enqueued for (the
 * `device_commands_stamp_incarnation` trigger). When a reattach hands the row
 * to a new agent install the incarnation advances, and from then on a command
 * stamped for the earlier install is never claimed and its result is never
 * accepted — the boundary (services/deviceInstallBoundary) has already
 * cancelled every such row that was still open, and these checks make the
 * refusal hold on every claim and result path, reopen paths included.
 *
 * A NULL stamp is a row written before the trigger existed. No device had been
 * reattached then, so it belongs to incarnation 1 (the null rule, §4.1).
 *
 * Deliberately a LEAF module (drizzle + schema only): the claim
 * (services/commandDispatch.ts, services/commandClaimEligibility.ts) and the
 * result predicate (services/commandResultAcceptance.ts) both import it.
 */

/** Claim-time cancel reason and boundary cancel reason for an earlier install's work. */
export const SUPERSEDED_BY_REATTACH_REASON = 'superseded_by_reattach' as const;

/** The incarnation a command stamp stands for: NULL is incarnation 1. */
export function commandStampIncarnation(stamp: number | null | undefined): number {
  return stamp ?? 1;
}

/** In-memory twin of {@link commandIncarnationIsCurrentCondition} for rows a claim already holds. */
export function commandStampIsCurrent(
  stamp: number | null | undefined,
  deviceInstallIncarnation: number,
): boolean {
  return commandStampIncarnation(stamp) === deviceInstallIncarnation;
}

/**
 * SQL predicate over `device_commands`: the row's stamp equals its device's
 * CURRENT incarnation, read in the same statement.
 *
 * It calls `breeze_device_command_incarnation_is_current(id)` (SECURITY
 * DEFINER, migration 2027-01-02-120100) rather than joining `devices`: the
 * result paths read `device_commands` contextless (the table is RLS-free), and
 * a plain `devices` subquery there would see no row and refuse everything. An
 * unknown command or device answers false (fail closed).
 */
export function commandIncarnationIsCurrentCondition(): SQL {
  return sql`public.breeze_device_command_incarnation_is_current(${deviceCommands.id})`;
}

/**
 * The incarnation an agent-authenticated caller proved (#8318 §6.4, item 2).
 * REST agent auth and the WS handshake read `devices.install_incarnation`
 * with the row they authenticate against and carry it here.
 */
export interface CommandCallerIncarnation {
  installIncarnation: number;
}

/**
 * In-memory twin of {@link commandStampMatchesCallerCondition}: the same
 * comparison as {@link commandStampIsCurrent}, against the caller's
 * incarnation instead of the device's, so the NULL-stamp rule lives in one place.
 */
export const commandStampMatchesCaller: (
  stamp: number | null | undefined,
  callerInstallIncarnation: number,
) => boolean = commandStampIsCurrent;

/**
 * SQL predicate over `device_commands`: the row's stamp (NULL = 1) equals the
 * incarnation the CALLER authenticated under. On its own it says nothing about
 * the device's current incarnation; see
 * {@link commandIncarnationAcceptedForCallerCondition}.
 */
export function commandStampMatchesCallerCondition(caller: CommandCallerIncarnation): SQL {
  return sql`COALESCE(${deviceCommands.deviceIncarnation}, 1) = ${caller.installIncarnation}`;
}

/**
 * The full §6.4 check for a claim or a result: the row's stamp equals BOTH the
 * caller's authenticated incarnation AND the device's current one, read in
 * the same statement. A caller that authenticated under `n` therefore never
 * takes a row stamped `n+1` (enqueued after a confirm it predates), and a row
 * stamped `n` is refused once the device moved on, reopen paths included.
 */
export function commandIncarnationAcceptedForCallerCondition(caller: CommandCallerIncarnation): SQL {
  return and(commandIncarnationIsCurrentCondition(), commandStampMatchesCallerCondition(caller))!;
}
