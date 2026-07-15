//go:build !windows

package agentapp

import (
	"os"
	"time"
)

func currentPlatformProcessMetadata() platformProcessMetadata {
	return platformProcessMetadata{
		ParentPID: os.Getppid(),
		CreatedAt: time.Now(),
	}
}
