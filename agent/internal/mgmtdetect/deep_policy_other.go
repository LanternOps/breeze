//go:build !windows && !darwin

package mgmtdetect

func collectPolicyDetections() []Detection {
	return nil
}
