/**
 * Classification of every AI tool input field that names a device filesystem
 * path, keyed `tool.field.path` (array elements flatten into the dotted key).
 *
 * ONE table, two consumers:
 * - `aiTools.pathParams.contract.test.ts` walks the real `toolInputSchemas`
 *   and fails until every path-looking field is listed here, so a new
 *   path-taking field cannot skip the default restriction;
 * - `aiDevicePathPolicy.ts` (the executeTool gate) applies the tenant's AI
 *   data policy level to every non-exempt field listed here.
 *
 * `safePath`: typed with the schema refinement (floor at validation time).
 * `checkedByToolSchema`: the tool's own schema applies `aiPathRefusal`.
 * `exempt`: not a live device path the tool opens or lists, or already gated
 * by an administrator-approved grant; the reason is required.
 */
export type Classification =
  | { kind: 'safePath' }
  | { kind: 'checkedByToolSchema'; why: string }
  | { kind: 'exempt'; why: string };

const SAFE: Classification = { kind: 'safePath' };

/** `tool.field.path` → how the field meets the restriction. */
export const PATH_FIELDS: Record<string, Classification> = {
  'file_operations.path': SAFE,
  'file_operations.newPath': SAFE,
  'analyze_disk_usage.path': SAFE,
  'disk_cleanup.path': SAFE,
  'remediate_sensitive_data.quarantineDir': SAFE,

  'execute_command.payload.path': {
    kind: 'checkedByToolSchema',
    why: 'Only file_list/file_read read it; the execute_command schema applies aiPathRefusal to it for those two command types (and requires it).',
  },

  'request_diagnostic_access.paths.path': {
    kind: 'exempt',
    why: 'Requests an administrator-approved read-only exception to the default restriction, so it cannot be refused by it. services/diagnosticAccess/grants.ts enforces path form (diagnosticPathFormError: absolute, no traversal, UNC, stream or trailing-dot names), sensitive-store classes and a minimum depth (MIN_DIAGNOSTIC_SCOPE_DEPTH) when the request is created; nothing is read until an approver grants it.',
  },
  'diagnostic_list_directory.path': {
    kind: 'exempt',
    why: 'Reads only under an approved diagnostic grant: the server checks grant coverage and sensitive classes, signs a per-command authorization, and the agent re-checks containment on the opened handle.',
  },
  'diagnostic_read_file.path': {
    kind: 'exempt',
    why: 'Reads only under an approved diagnostic grant: the server checks grant coverage and sensitive classes, signs a per-command authorization, and the agent re-checks containment on the opened handle.',
  },
  'disk_cleanup.paths': {
    kind: 'exempt',
    why: 'Execute-only selection; each entry must be a candidate of the pinned preview run (filesystemCleanupExecution), anything else is rejected and never dispatched.',
  },
  'restore_snapshot.targetPath': {
    kind: 'exempt',
    why: 'Restore destination for data from the device\'s own backup; approval-gated (tier 3). The restored copy keeps its source layout under this folder, where file tools can then read it: which snapshot entries an AI may restore is a separate decision, not a path-spelling check.',
  },
  'restore_snapshot.selectedPaths': {
    kind: 'exempt',
    why: 'Entries inside the snapshot being restored, not live device paths the tool opens or lists.',
  },
  'restore_as_vm.outputPath': {
    kind: 'exempt',
    why: 'Output .vhdx on the rebuild host, validated by isAbsoluteRebuildPath; the engine writes an image there and returns no file content.',
  },
  'configure_vault.vaultPath': {
    kind: 'exempt',
    why: 'Backup vault destination (local/SMB/USB) the backup engine writes to; nothing is read back to the model.',
  },
  'propose_script.verification.path': {
    kind: 'exempt',
    why: 'file_exists verification claim: the verifier reports only whether the path exists after the approved script ran; no listing or content.',
  },
  'manage_backup_profiles.selections.file.paths': {
    kind: 'exempt',
    why: 'Backup selection: which device paths the backup engine includes; the data goes to the backup store, never to the model.',
  },
  'workspace_collect.paths': {
    kind: 'exempt',
    why: 'Paths inside the server-side AI workspace sandbox, not a device filesystem.',
  },
  'manage_startup_items.itemPath': {
    kind: 'exempt',
    why: 'Disambiguates a startup item by its registered command path; matched against inventory, never opened or listed.',
  },
  'registry_operations.keyPath': {
    kind: 'exempt',
    why: 'A registry key, not a filesystem path; the registry deny-list (isDeniedRegistryTarget) applies instead.',
  },
};
