package rebuild

import "context"

// winConvert always records skipped: a vhdx: target is written natively by
// winProvision/winAttach (CreateVHDX + AttachVHDX), there is no raw staging
// file to convert — unlike the Linux engine's TargetVHDX path (convert.go),
// which stages a .raw file and shells to qemu-img. A disk: target has
// nothing to convert either. Every Windows target kind therefore reaches
// this phase only to record it skipped, keeping Result.Phases the same
// fixed eight-entry shape for every platform (Global Constraint "One
// engine, one Run, one Result").
func winConvert(_ context.Context, r *run) error {
	r.recordSkipped(PhaseConvert, "vhdx written natively; no conversion")
	return nil
}
