/**
 * Tool Catalog W05 (#5220), plan Task B2 — what every in-process built-in
 * step (`notify`, `http_request`, `ai`) executes with. Built by the runner
 * (stepExecutor) and by the release worker's flow branch for an approved
 * Tier-3 built-in (builtins/release.ts). Types only.
 */
import type { FlowDocumentV1 } from '@breeze/shared';
import type { FlowRunRow, FlowVersionRow } from '../../../db/schema/flowRuns';
import type { AuthContext } from '../../../middleware/auth';
import type { ToolOwnerRef } from '../../toolSources/resolver';

export interface BuiltinContext {
  run: FlowRunRow;
  /** The run's publication. */
  version: FlowVersionRow;
  /** The publication's step definition — literal values (an http_request origin) come from here, never from the rendered input. */
  step: FlowDocumentV1['steps'][number];
  /** The flow's tool owner (org flow ⇒ its org; partner-wide ⇒ orgId null). */
  owner: ToolOwnerRef;
  /** The run's flow principal (`buildFlowAuthContext`). */
  auth: AuthContext;
  /** The `flow_run_steps` row of this attempt. */
  stepRowId: string;
  /** W6: the attempt's for-each item index (null outside a for-each). */
  itemIndex: number | null;
  /** Absolute epoch ms; the step's own deadline. */
  deadline: number;
  /** Calls of each capped built-in in this run so far (non-skipped step rows), THIS call included. */
  counters: { notify: number; http: number };
  /** The runner slice's lease token (lease-fenced writes); null on the release-worker path. */
  leaseToken: string | null;
}
