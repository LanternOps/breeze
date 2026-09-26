import { TOPOLOGY_INTERFACE_POLL_COMMAND_TYPE } from '@breeze/shared';
import { registerCommandRevalidation } from '../commandClaimEligibility';
import { validateTopologyInterfacePollDelivery } from './telemetryArmFence';

/**
 * Registers the `topology_interface_poll` delivery revalidation (M3-D2) for
 * both transports. Imported for its side effect by commandDispatch.ts only —
 * kept out of telemetryArmFence.ts so global-placement workers that need the
 * fence (topology reconcile) do not pull the command-claim closure.
 * `REVALIDATION_REQUIRED_TYPES` still fails the row closed if it is not loaded.
 */
registerCommandRevalidation(TOPOLOGY_INTERFACE_POLL_COMMAND_TYPE, (reader, row) => validateTopologyInterfacePollDelivery(reader, row));
