package timesync

import (
	"context"
	"errors"
	"time"

	"github.com/breeze-rmm/agent/internal/mgmtdetect"
)

var errUnavailable = errors.New("time sync read unavailable")

const serviceKey = `SYSTEM\CurrentControlSet\Services\W32Time`
const policyKey = `SOFTWARE\Policies\Microsoft\W32Time`

type RoleInfo struct {
	MachineRole          uint32
	DomainDNS, ForestDNS string
}
type ServiceInfo struct{ State, StartType string }

type System interface {
	ReadString(context.Context, string, string) (string, error)
	ReadDWORD(context.Context, string, string) (uint32, error)
	ValueNames(context.Context, string) ([]string, error)
	W32TimeService(context.Context) (ServiceInfo, error)
	ProviderStatus(context.Context) (Status, error)
	W32tmStatus(context.Context) ([]byte, error)
	Events(context.Context, time.Time, time.Time, int) ([]Event, error)
	RecentEvents(context.Context, time.Time, int) ([]Event, error)
	Identity(context.Context) (mgmtdetect.IdentityStatus, error)
	PrimaryDomain(context.Context) (RoleInfo, error)
	PDC(context.Context, string) (string, error)
	ComputerDNSName(context.Context) (string, error)
	DynamicTimezone(context.Context) (Timezone, error)
}
