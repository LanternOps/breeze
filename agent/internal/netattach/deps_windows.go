//go:build windows

package netattach

import (
	"context"
	"errors"
	"net"
	"sync"
	"syscall"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
	"golang.org/x/sys/windows"
)

var osDeps = sync.OnceValue(func() deps {
	reader := networkcontext.NewReader("netattach") // Windows ignores the argument
	return deps{reader: reader, lookup: readerLookup(reader), resolve: systemResolve, bridged: windowsBridged}
})

var (
	ipHelper      = windows.NewLazySystemDLL("iphlpapi.dll")
	getIfTable2Ex = ipHelper.NewProc("GetIfTable2Ex")
	freeMibTable  = ipHelper.NewProc("FreeMibTable")
)

// MIB_IF_TABLE_LEVEL. MibIfTableNormalWithoutStatistics skips the counters but
// may not be accepted by every Windows build; MibIfTableNormal is the fallback.
const (
	mibIfTableNormal                  = 0
	mibIfTableNormalWithoutStatistics = 2
	maxIfTableEntries                 = 65536
)

var (
	errIfTableLimit     = errors.New("netattach: interface table too large")
	errIfTableMalformed = errors.New("netattach: interface table missing")
)

// windowsBridged is K2 on Windows (Task 2 candidate A): the hardware interface
// list is read once per call, and each virtual row is matched on its MAC.
func windowsBridged(ctx context.Context, rows []networkcontext.InterfaceRow) (map[string]bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	hw, err := readHardwareInterfaces()
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(rows))
	for _, row := range rows {
		out[row.InterfaceKey] = windowsBridgedUplink(row, hw)
	}
	return out, nil
}

// readHardwareInterfaces lists every interface with MIB_IF_ROW2's
// HardwareInterface flag (bit 0 of InterfaceAndOperStatusFlags). Every
// iphlpapi export is resolved with Find before Call: calling a missing export
// panics the agent (#9233).
func readHardwareInterfaces() ([]hardwareInterface, error) {
	if err := getIfTable2Ex.Find(); err != nil {
		return nil, err
	}
	if err := freeMibTable.Find(); err != nil {
		return nil, err
	}
	var table *windows.MibIfTable2
	code, _, _ := getIfTable2Ex.Call(mibIfTableNormalWithoutStatistics, uintptr(unsafe.Pointer(&table)))
	if code != 0 {
		table = nil
		code, _, _ = getIfTable2Ex.Call(mibIfTableNormal, uintptr(unsafe.Pointer(&table)))
	}
	if code != 0 {
		return nil, syscall.Errno(code)
	}
	if table == nil {
		return nil, errIfTableMalformed
	}
	defer func() { _, _, _ = freeMibTable.Call(uintptr(unsafe.Pointer(table))) }()
	if table.NumEntries > maxIfTableEntries {
		return nil, errIfTableLimit
	}
	if table.NumEntries == 0 {
		return nil, nil
	}
	var out []hardwareInterface
	for _, row := range unsafe.Slice(&table.Table[0], table.NumEntries) {
		if row.InterfaceAndOperStatusFlags&0x01 == 0 || row.PhysicalAddressLength != 6 {
			continue
		}
		out = append(out, hardwareInterface{
			Index: row.InterfaceIndex,
			MAC:   net.HardwareAddr(row.PhysicalAddress[:6]).String(),
			Up:    row.OperStatus == windows.IfOperStatusUp,
		})
	}
	return out, nil
}
