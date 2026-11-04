//go:build !linux

package cgroup

// SetupSelf is Linux-only; other platforms scope permits by executable (WFP)
// or not at all (pf), so there is nothing to split.
func SetupSelf(func(Layout) error, func()) (Layout, error) {
	return Layout{ChildrenFD: -1}, &Error{Reason: ReasonUnavailable, Detail: "cgroup placement is only used on Linux"}
}
