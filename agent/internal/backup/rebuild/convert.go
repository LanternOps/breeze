package rebuild

import (
	"context"
	"fmt"
	"os"
	"strings"
)

// convert is the eighth phase: for TargetVHDX it turns the raw staging
// image (Target.RawPath(), already synced and detached by validate) into a
// dynamic VHDX at Target.Path with qemu-img and removes the raw file. Every
// other target kind records the phase as skipped so Result.Phases keeps the
// same fixed shape for all callers (CLI, console, the W06 Windows engine).
func convert(ctx context.Context, r *run) error {
	if r.opts.Target.Kind != TargetVHDX {
		r.recordSkipped(PhaseConvert, "not an image conversion target")
		return nil
	}
	raw, out := r.opts.Target.RawPath(), r.opts.Target.Path
	r.progress(PhaseConvert, "converting "+raw+" to VHDX", 0, 1)
	if b, err := r.sys.Run(ctx, "qemu-img", "convert", "-f", "raw", "-O", "vhdx", "-o", "subformat=dynamic", raw, out); err != nil {
		if msg := strings.TrimSpace(string(b)); msg != "" {
			return fmt.Errorf("qemu-img convert: %s: %w", msg, err)
		}
		return fmt.Errorf("qemu-img convert: %w", err)
	}
	if err := os.Remove(raw); err != nil && !os.IsNotExist(err) {
		r.warn("raw staging image not removed: %v", err)
	}
	r.progress(PhaseConvert, "wrote "+out, 1, 1)
	return nil
}
