//go:build windows

package sessionbroker

import (
	"context"
	"fmt"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

type windowsDetector struct{}

// NewSessionDetector creates a Windows session detector using WTS API.
func NewSessionDetector() SessionDetector {
	return &windowsDetector{}
}

var (
	modWtsapi32            = windows.NewLazySystemDLL("wtsapi32.dll")
	procWTSEnumerateSessions = modWtsapi32.NewProc("WTSEnumerateSessionsW")
	procWTSFreeMemory        = modWtsapi32.NewProc("WTSFreeMemory")
	procWTSQuerySessionInfo  = modWtsapi32.NewProc("WTSQuerySessionInformationW")
)

const (
	wtsCurrentServerHandle = 0
	wtsUserName            = 5
	wtsDomainName          = 7
)

type wtsSessionInfo struct {
	SessionID uint32
	WinStationName *uint16
	State     uint32
}

func (d *windowsDetector) ListSessions() ([]DetectedSession, error) {
	var sessionInfo uintptr
	var count uint32

	r1, _, err := procWTSEnumerateSessions.Call(
		wtsCurrentServerHandle,
		0, // reserved
		1, // version
		uintptr(unsafe.Pointer(&sessionInfo)),
		uintptr(unsafe.Pointer(&count)),
	)
	if r1 == 0 {
		return nil, fmt.Errorf("WTSEnumerateSessions: %w", err)
	}
	defer procWTSFreeMemory.Call(sessionInfo)

	var sessions []DetectedSession
	size := unsafe.Sizeof(wtsSessionInfo{})

	for i := uint32(0); i < count; i++ {
		info := (*wtsSessionInfo)(unsafe.Pointer(sessionInfo + uintptr(i)*size))

		// Skip services session (0) and listener sessions
		if info.SessionID == 0 || info.State == 6 { // WTSListen = 6
			continue
		}

		// Only include active/disconnected sessions
		if info.State != 0 && info.State != 4 { // WTSActive = 0, WTSDisconnected = 4
			continue
		}

		username := d.querySessionString(info.SessionID, wtsUserName)
		if username == "" {
			continue
		}

		sessions = append(sessions, DetectedSession{
			Username: username,
			Session:  fmt.Sprintf("%d", info.SessionID),
			State:    wtsStateString(info.State),
			Display:  "windows",
		})
	}

	return sessions, nil
}

func (d *windowsDetector) WatchSessions(ctx context.Context) <-chan SessionEvent {
	ch := make(chan SessionEvent, 16)

	go func() {
		defer close(ch)

		known := make(map[string]DetectedSession)
		if sessions, err := d.ListSessions(); err == nil {
			for _, s := range sessions {
				known[s.Session] = s
			}
		}

		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				current, err := d.ListSessions()
				if err != nil {
					continue
				}

				currentMap := make(map[string]DetectedSession)
				for _, s := range current {
					currentMap[s.Session] = s
				}

				for id, s := range currentMap {
					if _, exists := known[id]; !exists {
						ch <- SessionEvent{
							Type:     SessionLogin,
							Username: s.Username,
							Session:  s.Session,
							Display:  s.Display,
						}
					}
				}

				for id, s := range known {
					if _, exists := currentMap[id]; !exists {
						ch <- SessionEvent{
							Type:     SessionLogout,
							Username: s.Username,
							Session:  s.Session,
						}
					}
				}

				known = currentMap
			}
		}
	}()

	return ch
}

func (d *windowsDetector) querySessionString(sessionID uint32, infoClass uint32) string {
	var buf uintptr
	var bytesReturned uint32

	r1, _, _ := procWTSQuerySessionInfo.Call(
		wtsCurrentServerHandle,
		uintptr(sessionID),
		uintptr(infoClass),
		uintptr(unsafe.Pointer(&buf)),
		uintptr(unsafe.Pointer(&bytesReturned)),
	)
	if r1 == 0 || buf == 0 {
		return ""
	}
	defer procWTSFreeMemory.Call(buf)

	return windows.UTF16PtrToString((*uint16)(unsafe.Pointer(buf)))
}

func wtsStateString(state uint32) string {
	switch state {
	case 0:
		return "active"
	case 4:
		return "disconnected"
	default:
		return "unknown"
	}
}
