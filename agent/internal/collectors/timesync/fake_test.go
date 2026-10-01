package timesync

import (
	"context"
	"time"

	"github.com/breeze-rmm/agent/internal/mgmtdetect"
)

var _ System = (*fakeSystem)(nil)

type fakeSystem struct {
	strings                                map[string]string
	dwords                                 map[string]uint32
	names                                  map[string][]string
	namesErr                               map[string]error
	service                                ServiceInfo
	identity                               mgmtdetect.IdentityStatus
	role                                   RoleInfo
	pdc, computer                          string
	provider                               Status
	providerErr                            error
	tokens                                 []byte
	events, recent                         []Event
	eventErr, roleErr, pdcErr, computerErr error
	zone                                   Timezone
	since, until                           time.Time
}

func (f *fakeSystem) ReadString(_ context.Context, p, n string) (string, error) {
	v, ok := f.strings[p+"|"+n]
	if !ok {
		return "", errUnavailable
	}
	return v, nil
}
func (f *fakeSystem) ReadDWORD(_ context.Context, p, n string) (uint32, error) {
	v, ok := f.dwords[p+"|"+n]
	if !ok {
		return 0, errUnavailable
	}
	return v, nil
}
func (f *fakeSystem) ValueNames(_ context.Context, p string) ([]string, error) {
	v, ok := f.names[p]
	if err := f.namesErr[p]; err != nil {
		return v, err
	}
	if !ok {
		return nil, errUnavailable
	}
	return v, nil
}
func (f *fakeSystem) W32TimeService(context.Context) (ServiceInfo, error) {
	if f.service.State == "" {
		return ServiceInfo{}, errUnavailable
	}
	return f.service, nil
}
func (f *fakeSystem) ProviderStatus(context.Context) (Status, error) {
	if f.provider.Source == nil {
		return unknownStatus(), errUnavailable
	}
	return f.provider, f.providerErr
}
func (f *fakeSystem) W32tmStatus(context.Context) ([]byte, error) {
	if f.tokens == nil {
		return nil, errUnavailable
	}
	return f.tokens, nil
}
func (f *fakeSystem) Events(_ context.Context, a, b time.Time, _ int) ([]Event, error) {
	f.since = a
	f.until = b
	return f.events, f.eventErr
}
func (f *fakeSystem) RecentEvents(context.Context, time.Time, int) ([]Event, error) {
	return f.recent, f.eventErr
}
func (f *fakeSystem) Identity(context.Context) (mgmtdetect.IdentityStatus, error) {
	if f.identity.Source == "" {
		return f.identity, errUnavailable
	}
	return f.identity, nil
}
func (f *fakeSystem) PrimaryDomain(context.Context) (RoleInfo, error) { return f.role, f.roleErr }
func (f *fakeSystem) PDC(context.Context, string) (string, error)     { return f.pdc, f.pdcErr }
func (f *fakeSystem) ComputerDNSName(context.Context) (string, error) {
	return f.computer, f.computerErr
}
func (f *fakeSystem) DynamicTimezone(context.Context) (Timezone, error) {
	if f.zone.WindowsID == nil {
		return Timezone{}, errUnavailable
	}
	return f.zone, nil
}
