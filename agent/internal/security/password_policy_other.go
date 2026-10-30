//go:build !windows

package security

func collectPasswordPolicySecedit() (map[string]any, error) { return nil, ErrNotSupported }

func collectPasswordPolicyNetAPI() (map[string]any, error) { return nil, ErrNotSupported }
