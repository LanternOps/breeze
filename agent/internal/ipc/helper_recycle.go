package ipc

// Helper recycling (#12624). A Windows SYSTEM helper whose process can no
// longer use DXGI capture asks the service to replace it
// (helper_recycle_request, helper -> agent). The request is advisory. If the
// service agrees it sends helper_recycle_prepare (agent -> helper); the helper
// stops taking work and answers Ready only when nothing would be interrupted,
// and the service then replaces the process.
//
// New type values only. An older service ignores the request, and an older
// helper never sends it, so a mixed pair keeps the GDI behaviour.
const (
	TypeHelperRecycleRequest = "helper_recycle_request"
	TypeHelperRecyclePrepare = "helper_recycle_prepare"
)

// HelperRecycleRequest says why the helper wants to be replaced.
type HelperRecycleRequest struct {
	Reason string `json:"reason"`
}

// HelperRecyclePrepareResult answers helper_recycle_prepare. Busy names what
// the replacement would have interrupted, when not Ready.
type HelperRecyclePrepareResult struct {
	Ready bool   `json:"ready"`
	Busy  string `json:"busy,omitempty"`
}
