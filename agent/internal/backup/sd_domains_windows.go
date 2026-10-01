//go:build windows

package backup

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The domains whose accounts this machine recognises, for the restore's
// security-descriptor decision (judgeDescriptor): the local account domain
// and primary domain from the LSA policy, and the domains the primary domain
// trusts from DsEnumerateDomainTrustsW. x/sys/windows wraps none of these.

var (
	modnetapi32 = windows.NewLazySystemDLL("netapi32.dll")

	procLsaOpenPolicy             = modadvapi32.NewProc("LsaOpenPolicy")
	procLsaQueryInformationPolicy = modadvapi32.NewProc("LsaQueryInformationPolicy")
	procLsaFreeMemory             = modadvapi32.NewProc("LsaFreeMemory")
	procLsaClose                  = modadvapi32.NewProc("LsaClose")
	procDsEnumerateDomainTrustsW  = modnetapi32.NewProc("DsEnumerateDomainTrustsW")
)

const (
	policyViewLocalInformation     = 0x00000001
	policyPrimaryDomainInformation = 3
	policyAccountDomainInformation = 5
	dsDomainInForest               = 0x0001
	dsDomainDirectOutbound         = 0x0002
	dsDomainPrimary                = 0x0008
	domainTrustFlagsTrustedBySelf  = dsDomainInForest | dsDomainDirectOutbound | dsDomainPrimary
)

// lsaObjectAttributes is LSA_OBJECT_ATTRIBUTES; LsaOpenPolicy requires it
// zeroed apart from Length.
type lsaObjectAttributes struct {
	Length                   uint32
	RootDirectory            windows.Handle
	ObjectName               *windows.NTUnicodeString
	Attributes               uint32
	SecurityDescriptor       uintptr
	SecurityQualityOfService uintptr
}

// policyDomainInfo is both POLICY_ACCOUNT_DOMAIN_INFO and
// POLICY_PRIMARY_DOMAIN_INFO: a name followed by a SID pointer (nil for a
// workgroup machine's primary domain).
type policyDomainInfo struct {
	Name windows.NTUnicodeString
	Sid  *windows.SID
}

// dsDomainTrusts is DS_DOMAIN_TRUSTSW.
type dsDomainTrusts struct {
	NetbiosDomainName *uint16
	DnsDomainName     *uint16
	Flags             uint32
	ParentIndex       uint32
	TrustType         uint32
	TrustAttributes   uint32
	DomainSid         *windows.SID
	DomainGuid        windows.GUID
}

// localKnownDomains resolves this machine's account domain, primary domain
// and — when it is domain-joined — the domains its primary domain trusts.
// A failure never fails the restore: what could not be resolved is simply
// not recognised (its accounts' descriptors are quarantined), and the
// returned note says so once.
func localKnownDomains() (knownDomains, []string) {
	var k knownDomains
	var notes []string
	policy, err := lsaOpenPolicy()
	if err != nil {
		return k, []string{fmt.Sprintf("could not read this machine's account domains (%v); security descriptors naming local or domain accounts were treated as naming unrecognised principals", err)}
	}
	defer func() { _, _, _ = procLsaClose.Call(policy) }()
	if k.account, err = lsaDomainSID(policy, policyAccountDomainInformation); err != nil {
		notes = append(notes, fmt.Sprintf("could not read this machine's local account domain (%v); security descriptors naming local accounts were treated as naming unrecognised principals", err))
	}
	if k.primary, err = lsaDomainSID(policy, policyPrimaryDomainInformation); err != nil {
		notes = append(notes, fmt.Sprintf("could not read this machine's primary domain (%v); security descriptors naming domain accounts were treated as naming unrecognised principals", err))
	}
	if k.primary == "" {
		// Not domain-joined: there are no trusts to enumerate.
		return k, notes
	}
	trusted, err := domainTrusts()
	k.trusted = trusted
	if err != nil {
		notes = append(notes, fmt.Sprintf("could not enumerate the domains trusted by this machine's domain (%v); only this machine's own and primary domains (and any trusted domains read before the failure) were recognised in restored security descriptors", err))
	}
	return k, notes
}

func lsaOpenPolicy() (uintptr, error) {
	var attrs lsaObjectAttributes
	attrs.Length = uint32(unsafe.Sizeof(attrs))
	var handle uintptr
	r1, _, _ := procLsaOpenPolicy.Call(0, uintptr(unsafe.Pointer(&attrs)), policyViewLocalInformation, uintptr(unsafe.Pointer(&handle)))
	if r1 != 0 {
		return 0, fmt.Errorf("LsaOpenPolicy: %w", windows.NTStatus(r1))
	}
	return handle, nil
}

// lsaDomainSID returns the SID of the policy's account or primary domain,
// "" when it has none (a workgroup machine's primary domain).
func lsaDomainSID(policy uintptr, class uintptr) (string, error) {
	var buf *policyDomainInfo
	r1, _, _ := procLsaQueryInformationPolicy.Call(policy, class, uintptr(unsafe.Pointer(&buf)))
	if r1 != 0 {
		return "", fmt.Errorf("LsaQueryInformationPolicy(%d): %w", class, windows.NTStatus(r1))
	}
	if buf == nil {
		return "", nil
	}
	defer func() { _, _, _ = procLsaFreeMemory.Call(uintptr(unsafe.Pointer(buf))) }()
	return sidPointerString(buf.Sid)
}

// domainTrusts enumerates the domains this machine's primary domain trusts:
// every domain in its forest plus its direct outbound trusts. A trust whose
// SID cannot be read is reported in the error; the others are still
// returned.
func domainTrusts() ([]string, error) {
	var buf *dsDomainTrusts
	var count uint32
	r1, _, _ := procDsEnumerateDomainTrustsW.Call(0, domainTrustFlagsTrustedBySelf, uintptr(unsafe.Pointer(&buf)), uintptr(unsafe.Pointer(&count)))
	if r1 != 0 {
		return nil, fmt.Errorf("DsEnumerateDomainTrustsW: %w", windows.Errno(r1))
	}
	if buf == nil {
		return nil, nil
	}
	defer func() { _ = windows.NetApiBufferFree((*byte)(unsafe.Pointer(buf))) }()
	var out []string
	var errs []error
	for _, trust := range unsafe.Slice(buf, count) {
		if trust.DomainSid == nil {
			continue // a non-Windows realm carries no SID
		}
		sid, err := sidPointerString(trust.DomainSid)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		out = append(out, sid)
	}
	return out, errors.Join(errs...)
}
