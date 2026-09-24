#!/usr/bin/env bash
# W05c2 (#6371) Task 18: verify the integrated alerting-consolidation wave —
# typechecks, the full API unit suite, the web/shared suites the wave touched,
# the docs build, and the live-Postgres isolation, cascade and export proofs.
# Starts a private per-worktree test stack and always tears it down.
set -euo pipefail
root_dir="$(git rev-parse --show-toplevel)"
cd "$root_dir"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=12288}"

(cd packages/shared && npx tsc --noEmit -p . && npx vitest run src/validators/fleetDesign.test.ts src/validators/monitors.test.ts)
(cd apps/api && npx tsc --noEmit -p .)
(cd apps/api && npx vitest run)
(cd apps/web && npx tsc --noEmit -p . && npx vitest run \
  src/components/monitoring src/components/automations src/components/fleetDesign \
  src/components/configurationPolicies/ConfigPolicyDetailPage.test.tsx \
  src/components/configurationPolicies/featureTabs/MonitorsTab.test.tsx \
  src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts \
  src/components/devices/DeviceMonitoringTab.test.tsx src/components/admin/MonitorConversionAdmin.test.tsx \
  src/components/layout/Sidebar.nav.test.tsx src/lib/routeScope.test.ts src/lib/i18n \
  src/lib/__tests__/settingsPageRegistry.test.ts src/lib/__tests__/no-silent-mutations.test.ts \
  src/lib/__tests__/alertTemplatesRetired.test.ts src/lib/__tests__/alertingDocs.test.ts \
  src/lib/__tests__/alertingVerification.test.ts)
pnpm --filter @breeze/docs check
pnpm --filter @breeze/docs build

# Register teardown before startup so a partial startup failure is cleaned up too.
trap 'pnpm test-stack down' EXIT
pnpm test-stack up
set -a
# shellcheck disable=SC1091
. ./.env.test
set +a
(cd apps/api && npx vitest run -c vitest.integration.config.ts \
  src/__tests__/integration/deviceMonitors.integration.test.ts \
  src/__tests__/integration/fleetDesignApply.integration.test.ts \
  src/__tests__/integration/monitorDefinitionsPartnerRls.integration.test.ts \
  src/__tests__/integration/monitorConversionsPartnerRls.integration.test.ts \
  src/__tests__/integration/monitorConversionRoundtrip.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts)
# The RLS coverage contract has its own config and is excluded from the
# integration config above; pointing that config at it runs nothing.
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
git diff --check
