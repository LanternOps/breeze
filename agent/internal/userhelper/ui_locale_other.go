//go:build !windows && !darwin

package userhelper

import "os"

func probeUILocaleOS() string { return localeFromEnv(os.Getenv) }
