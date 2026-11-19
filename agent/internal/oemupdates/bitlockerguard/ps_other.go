//go:build !windows

package bitlockerguard

import (
	"context"
	"errors"
)

var errWindowsOnly = errors.New("bitlocker is only managed on windows")

func systemSuspend(context.Context, int) error { return errWindowsOnly }

func systemResume(context.Context) error { return errWindowsOnly }

func systemProtectors(context.Context) (string, error) { return "", errWindowsOnly }
