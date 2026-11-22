import { TOPOLOGY_INTERFACE_POLL_COMMAND_TYPE } from '@breeze/shared';
import { registerCommandRevalidation } from '../commandClaimEligibility';
import { resolveTopologyPollPermissionVersions, validateTopologyInterfacePollDelivery } from './telemetryArmFence';

const NO_VERSIONS: ReadonlyMap<string, string | null> = new Map();

/**
 * Registers the `topology_interface_poll` delivery revalidation (M3-D2) for
 * both transports. Imported for its side effect by commandDispatch.ts only —
 * kept out of telemetryArmFence.ts so global-placement workers that need the
 * fence (topology reconcile) do not pull the command-claim closure.
 * `REVALIDATION_REQUIRED_TYPES` still fails the row closed if it is not loaded.
 *
 * Two halves (#7268): the prepare half resolves the arm actors' permission
 * versions from Redis before the claim locks any `device_commands` row; the
 * in-lock half compares against them. A poll the prepare half did not cover
 * (no preparation at all, or its actor missing) is held for the next claim.
 */
registerCommandRevalidation(
  TOPOLOGY_INTERFACE_POLL_COMMAND_TYPE,
  async (reader, row, versions: ReadonlyMap<string, string | null> | undefined) => {
    const outcome = await validateTopologyInterfacePollDelivery(reader, row, versions ?? NO_VERSIONS);
    return outcome === 'unprepared' ? { hold: 'revalidation_unprepared' } : outcome;
  },
  (reader, rows) => resolveTopologyPollPermissionVersions(reader, rows.map((row) => row.payload)),
);
