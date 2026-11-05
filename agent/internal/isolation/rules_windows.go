//go:build windows

package isolation

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"runtime"
	"slices"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	isolationIPHelper    = windows.NewLazySystemDLL("iphlpapi.dll")
	getIsolationTCPTable = isolationIPHelper.NewProc("GetExtendedTcpTable")
	setIsolationTCPEntry = isolationIPHelper.NewProc("SetTcpEntry")
)

// readWindowsBaseline reads the host's configured resolvers, never a public
// fallback. A read error stops Apply before any filtering transaction begins.
func readWindowsBaseline() (Baseline, error) {
	var result Baseline
	size := uint32(15 << 10)
	for attempt := 0; attempt < 4; attempt++ {
		if size < uint32(unsafe.Sizeof(windows.IpAdapterAddresses{})) || size > 16<<20 {
			return Baseline{}, fmt.Errorf("GetAdaptersAddresses: invalid buffer size %d", size)
		}
		buf := make([]byte, size)
		var pin runtime.Pinner
		pin.Pin(&buf[0])
		head := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0]))
		err := windows.GetAdaptersAddresses(windows.AF_UNSPEC, windows.GAA_FLAG_SKIP_ANYCAST|windows.GAA_FLAG_SKIP_MULTICAST, 0, head, &size)
		if errors.Is(err, windows.ERROR_BUFFER_OVERFLOW) {
			pin.Unpin()
			continue
		}
		if err != nil {
			pin.Unpin()
			return Baseline{}, fmt.Errorf("GetAdaptersAddresses: %w", err)
		}
		for adapter := head; adapter != nil; adapter = adapter.Next {
			for dns := adapter.FirstDnsServerAddress; dns != nil; dns = dns.Next {
				addr, ok := netip.AddrFromSlice(dns.Address.IP())
				if ok && !addr.IsUnspecified() && !addr.IsMulticast() {
					addr = addr.Unmap()
					if addr.Is6() && addr.IsLinkLocalUnicast() {
						if adapter.Luid == 0 {
							pin.Unpin()
							return Baseline{}, errors.New("GetAdaptersAddresses: scoped DNS resolver has no interface LUID")
						}
						result.ScopedResolvers = append(result.ScopedResolvers, ScopedResolver{Address: addr, Interface: adapter.Luid})
					} else {
						result.Resolvers = append(result.Resolvers, addr)
					}
				}
			}
		}
		runtime.KeepAlive(buf)
		pin.Unpin()
		slices.SortFunc(result.Resolvers, func(a, b netip.Addr) int { return a.Compare(b) })
		result.Resolvers = slices.Compact(result.Resolvers)
		return result, nil
	}
	return Baseline{}, errors.New("GetAdaptersAddresses: adapter list changed during four buffer attempts")
}

func readWindowsTCPRows() ([]tcpRow, error) {
	if err := getIsolationTCPTable.Find(); err != nil {
		return nil, fmt.Errorf("GetExtendedTcpTable: %w", err)
	}
	size := uint32(64 << 10)
	for attempt := 0; attempt < 4; attempt++ {
		if size < 4 || size > 64<<20 {
			return nil, fmt.Errorf("GetExtendedTcpTable: invalid buffer size %d", size)
		}
		buf := make([]byte, size)
		code, _, _ := getIsolationTCPTable.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 0, windows.AF_INET, 5 /* TCP_TABLE_OWNER_PID_ALL */, 0)
		if code == uintptr(windows.ERROR_INSUFFICIENT_BUFFER) {
			continue
		}
		if code != 0 {
			return nil, fmt.Errorf("GetExtendedTcpTable (Win32 %#x): %w", code, windows.Errno(code))
		}
		count := binary.LittleEndian.Uint32(buf[:4])
		rowSize := uint32(unsafe.Sizeof(mibTCPRowOwnerPID{}))
		if count > (uint32(len(buf))-4)/rowSize {
			return nil, errors.New("GetExtendedTcpTable: truncated row buffer")
		}
		rows := make([]tcpRow, 0, count)
		for i := uint32(0); i < count; i++ {
			native := *(*mibTCPRowOwnerPID)(unsafe.Pointer(&buf[4+i*rowSize]))
			rows = append(rows, tcpRowFromNative(native))
		}
		runtime.KeepAlive(buf)
		return rows, nil
	}
	return nil, errors.New("GetExtendedTcpTable: table changed during four buffer attempts")
}

func tcpProcessPath(pid uint32) string {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer func() { _ = windows.CloseHandle(handle) }()
	buf := make([]uint16, 32768)
	size := uint32(len(buf))
	if windows.QueryFullProcessImageName(handle, 0, &buf[0], &size) != nil {
		return ""
	}
	return windows.UTF16ToString(buf[:size])
}

// teardownWindowsTCP is deliberately best effort after the WFP transaction:
// failure to reset a flow must not misreport an already installed rule set as
// an apply failure. ALE reauthorization still covers both address families.
func teardownWindowsTCP(rs ResolvedSpec, bins []string, baseline Baseline) {
	rows, err := readWindowsTCPRows()
	if err != nil {
		log.Warn("isolation TCP teardown could not enumerate flows", "error", err)
		return
	}
	// A connection to any of our own interface addresses is loopback, even
	// when it uses two different non-loopback addresses on a multihomed host.
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		log.Warn("isolation TCP teardown could not identify local addresses", "error", err)
		return
	}
	localAddresses := make(map[netip.Addr]bool, len(addresses))
	for _, address := range addresses {
		if prefix, err := netip.ParsePrefix(address.String()); err == nil {
			localAddresses[prefix.Addr().Unmap()] = true
		}
	}
	paths := make(map[uint32]string)
	for i := range rows {
		row := &rows[i]
		path, ok := paths[row.PID]
		if !ok {
			path = tcpProcessPath(row.PID)
			paths[row.PID] = path
		}
		row.AppPath, row.Loopback = path, localAddresses[row.Remote.Addr()]
	}
	if err := setIsolationTCPEntry.Find(); err != nil {
		log.Warn("isolation TCP teardown unavailable", "error", fmt.Errorf("SetTcpEntry: %w", err))
		return
	}
	for _, row := range selectTCPRowsToDelete(rows, rs, bins, baseline) {
		native := tcpDeleteRow(row)
		code, _, _ := setIsolationTCPEntry.Call(uintptr(unsafe.Pointer(&native)))
		if code != 0 {
			log.Warn("isolation TCP teardown failed", "pid", row.PID, "error", fmt.Errorf("SetTcpEntry (Win32 %#x): %w", code, windows.Errno(code)))
		}
	}
}
