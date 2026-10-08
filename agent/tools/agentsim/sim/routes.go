package sim

import "strings"

// Route templates. The report and the API DB-budget test
// (apps/api/src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts)
// use the same strings; budget_contract_test.go keeps them in step.
const (
	RouteHeartbeat     = "POST /agents/:id/heartbeat"
	RouteUnifi         = "GET /agents/:id/unifi-collectors"
	RouteCrawlConfig   = "GET /workspace/agent/crawl-config"
	RouteProcessSample = "POST /agents/:id/process-sample"
	RouteSecurity      = "PUT /agents/:id/security/status"
	RouteSessions      = "PUT /agents/:id/sessions"
	RouteSoftware      = "PUT /agents/:id/software"
	RouteDisks         = "PUT /agents/:id/disks"
	RouteNetwork       = "PUT /agents/:id/network"
	RouteConnections   = "PUT /agents/:id/connections"
	RouteRegistryState = "PUT /agents/:id/registry-state"
	RouteConfigState   = "PUT /agents/:id/config-state"
	RoutePosture       = "PUT /agents/:id/management/posture"
	RouteEventLogs     = "PUT /agents/:id/eventlogs"
	RouteCommandResult = "POST /agents/:id/commands/:commandId/result"
	RouteEnroll        = "POST /agents/enroll"
	RouteWSUpgrade     = "GET /agent-ws/:id/ws"
	FrameCommandResult = "WS command_result"
	FramePong          = "WS pong"
)

// InventoryBatchRoutes is what heartbeat.go sendInventory() fans out every 15
// minutes on Linux. changes (only when there are change records) and
// warranty-info (darwin only) are not modelled.
var InventoryBatchRoutes = []string{RouteSoftware, RouteDisks, RouteNetwork, RouteConnections, RouteRegistryState, RouteConfigState}

// SteadyStateRoutes is every request a running simulated agent sends, plus the
// two WS frames it answers with. Each needs a DB budget in the API test.
func SteadyStateRoutes() []string {
	out := []string{RouteHeartbeat, RouteUnifi, RouteCrawlConfig, RouteProcessSample, RouteSecurity,
		RouteSessions, RoutePosture, RouteEventLogs, RouteCommandResult, FrameCommandResult, FramePong}
	return append(out, InventoryBatchRoutes...)
}

// RouteKey turns a request into its route template: ids become :id and
// :commandId, and the /api/v1 prefix is dropped.
func RouteKey(method, path string) string {
	segs := strings.Split(strings.Trim(strings.TrimPrefix(path, "/api/v1"), "/"), "/")
	switch {
	case len(segs) >= 2 && segs[0] == "agents" && segs[1] != "enroll":
		segs[1] = ":id"
		if len(segs) >= 4 && segs[2] == "commands" {
			segs[3] = ":commandId"
		}
	case len(segs) >= 2 && segs[0] == "agent-ws":
		segs[1] = ":id"
	}
	return method + " /" + strings.Join(segs, "/")
}
