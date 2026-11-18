// W07b2 (#10751): the empty-shard sentinel. Under named-suite enforcement an
// integration shard can be handed no selected file, and vitest 4.1 exits 1
// ("No test files found") when the sequencer's shard() returns nothing. The
// TimingSequencer (apps/api/vitest.integration.config.ts, via
// .github/scripts/shard-partition.mjs) runs this file in such a shard only, and
// sets it aside everywhere else, so a full run never runs it.
import { it } from 'vitest';

it('empty shard', () => {});
