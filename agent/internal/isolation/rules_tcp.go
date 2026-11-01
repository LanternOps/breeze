package isolation

import (
	"encoding/binary"
	"net/netip"
	"slices"
	"strings"
)

// tcpRow keeps the teardown decision portable. Loopback also covers traffic
// between distinct local interface addresses, not just the loopback prefix.
type tcpRow struct {
	State         uint32
	Local, Remote netip.AddrPort
	AppPath       string
	PID           uint32
	Loopback      bool
}

// MIB_TCPROW and MIB_TCPROW_OWNER_PID contain only DWORDs; their SDK layout
// is the same on amd64, arm64 and 386. Keep the conversions portable so tests
// execute their network-byte-order checks even without a Windows runner.
type mibTCPRow struct {
	State, LocalAddr, LocalPort, RemoteAddr, RemotePort uint32
}

type mibTCPRowOwnerPID struct {
	mibTCPRow
	OwnerPID uint32
}

func tcpRowFromNative(row mibTCPRowOwnerPID) tcpRow {
	endpoint := func(addr, port uint32) netip.AddrPort {
		var bytes [4]byte
		binary.LittleEndian.PutUint32(bytes[:], addr)
		return netip.AddrPortFrom(netip.AddrFrom4(bytes), uint16(port>>8)&0xff|uint16(port<<8))
	}
	return tcpRow{State: row.State, Local: endpoint(row.LocalAddr, row.LocalPort), Remote: endpoint(row.RemoteAddr, row.RemotePort), PID: row.OwnerPID}
}

func tcpDeleteRow(row tcpRow) mibTCPRow {
	local, remote := row.Local.Addr().As4(), row.Remote.Addr().As4()
	port := func(value uint16) uint32 { return uint32(value>>8) | uint32(value&0xff)<<8 }
	return mibTCPRow{State: 12 /* MIB_TCP_STATE_DELETE_TCB */, LocalAddr: binary.LittleEndian.Uint32(local[:]), LocalPort: port(row.Local.Port()), RemoteAddr: binary.LittleEndian.Uint32(remote[:]), RemotePort: port(row.Remote.Port())}
}

// selectTCPRowsToDelete mirrors the runtime permits, including process scope.
// A shared control-plane address must not preserve a script child's connection.
// IPv6 is reauthorized by ALE: SetTcpEntry only supports IPv4. Active TCP
// states SYN_SENT through LAST_ACK can still carry data or finish a handshake;
// CLOSED, LISTEN, TIME_WAIT and DELETE_TCB need no additional teardown.
func selectTCPRowsToDelete(rows []tcpRow, rs ResolvedSpec, bins []string, baseline Baseline) []tcpRow {
	var selected []tcpRow
	for _, row := range rows {
		local, remote := row.Local.Addr(), row.Remote.Addr()
		if row.State < 3 || row.State > 10 || !local.Is4() || !remote.Is4() || row.Loopback || local.IsLoopback() || remote.IsLoopback() || local == remote {
			continue
		}
		if row.Remote.Port() == 53 && slices.Contains(baseline.Resolvers, remote) {
			continue
		}
		breeze := row.AppPath != "" && slices.ContainsFunc(bins, func(bin string) bool {
			return strings.EqualFold(strings.ReplaceAll(bin, "/", `\`), strings.ReplaceAll(row.AppPath, "/", `\`))
		})
		permitted := false
		for _, entry := range rs.Entries {
			if entry.Proto != ProtoTCP && entry.Proto != ProtoUDPTCP {
				continue
			}
			if entry.Scope != ScopeAny && !(entry.Scope == ScopeBreeze && breeze) {
				continue
			}
			if !slices.Contains(entry.Ports, row.Remote.Port()) {
				continue
			}
			if slices.ContainsFunc(entry.Addrs, func(prefix netip.Prefix) bool { return prefix.Contains(remote) }) {
				permitted = true
				break
			}
		}
		if !permitted {
			selected = append(selected, row)
		}
	}
	return selected
}
