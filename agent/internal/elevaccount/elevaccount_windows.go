//go:build windows

package elevaccount

import (
	"context"
	"errors"
	"fmt"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

type windowsManager struct{}

func newManager() AccountManager { return &windowsManager{} }

var (
	netapi32                    = syscall.NewLazyDLL("netapi32.dll")
	procNetUserAdd              = netapi32.NewProc("NetUserAdd")
	procNetUserSetInfo          = netapi32.NewProc("NetUserSetInfo")
	procNetLocalGroupAddMembers = netapi32.NewProc("NetLocalGroupAddMembers")
	procNetLocalGroupDelMembers = netapi32.NewProc("NetLocalGroupDelMembers")
)

const (
	userInfoLevel1    = 1
	userInfoLevel1003 = 1003
	userInfoLevel1008 = 1008
	localGroupLevel0  = 0

	userPrivUser = 1

	ufAccountDisable     = 0x0002
	ufPasswdCantChange   = 0x0040
	ufNormalAccount      = 0x0200
	ufDontExpirePassword = 0x10000

	accountDisabledFlags = ufNormalAccount | ufAccountDisable | ufPasswdCantChange | ufDontExpirePassword
	accountEnabledFlags  = ufNormalAccount | ufPasswdCantChange | ufDontExpirePassword

	nerrSuccess        = 0
	nerrUserNotFound   = 2221
	nerrUserExists     = 2224
	nerrUserNotInGroup = 2237

	errorMemberInAlias    = 1378
	errorMemberNotInAlias = 1377

	adminAliasSID = "S-1-5-32-544"

	specialAccountsUserListPath = `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList`
)

type userInfo1 struct {
	Name        *uint16
	Password    *uint16
	PasswordAge uint32
	Priv        uint32
	HomeDir     *uint16
	Comment     *uint16
	Flags       uint32
	ScriptPath  *uint16
}

type userInfo1003 struct {
	Password *uint16
}

type userInfo1008 struct {
	Flags uint32
}

type localGroupMembersInfo0 struct {
	SID *windows.SID
}

func (*windowsManager) EnsureProvisioned() error {
	password, err := GeneratePassword(defaultPasswordLength)
	if err != nil {
		return err
	}
	if err := netUserAddDisabled(AccountName, password); err != nil {
		return err
	}
	if err := hideAccountFromLogon(AccountName); err != nil {
		return err
	}

	// Crash cleanup does not need the old password: group membership removal
	// and password rotation both work blind. Keep the secret out of agent.yaml
	// and secrets.yaml by re-randomizing at rest instead of persisting it.
	if err := removeFromAdministrators(AccountName); err != nil {
		return err
	}
	password, err = GeneratePassword(defaultPasswordLength)
	if err != nil {
		return err
	}
	if err := setPassword(AccountName, password); err != nil {
		return err
	}
	return setUserFlags(AccountName, accountDisabledFlags)
}

func (*windowsManager) Promote(ctx context.Context) (Credential, error) {
	if err := ctx.Err(); err != nil {
		return Credential{}, err
	}
	password, err := GeneratePassword(defaultPasswordLength)
	if err != nil {
		return Credential{}, err
	}
	if err := setPassword(AccountName, password); err != nil {
		return Credential{}, err
	}
	if err := ctx.Err(); err != nil {
		return Credential{}, err
	}
	if err := setUserFlags(AccountName, accountEnabledFlags); err != nil {
		return Credential{}, err
	}
	if err := ctx.Err(); err != nil {
		cleanupAfterFailedPromote()
		return Credential{}, err
	}
	if err := addToAdministrators(AccountName); err != nil {
		cleanupAfterFailedPromote()
		return Credential{}, err
	}
	return Credential{Username: AccountName, Password: password}, nil
}

func (*windowsManager) Demote(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := removeFromAdministrators(AccountName); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	password, err := GeneratePassword(defaultPasswordLength)
	if err != nil {
		return err
	}
	if err := setPassword(AccountName, password); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return setUserFlags(AccountName, accountDisabledFlags)
}

func netUserAddDisabled(username, password string) error {
	namePtr, err := windows.UTF16PtrFromString(username)
	if err != nil {
		return err
	}
	passwordPtr, err := windows.UTF16PtrFromString(password)
	if err != nil {
		return err
	}
	commentPtr, err := windows.UTF16PtrFromString("Breeze dormant elevation account")
	if err != nil {
		return err
	}

	info := userInfo1{
		Name:     namePtr,
		Password: passwordPtr,
		Priv:     userPrivUser,
		Comment:  commentPtr,
		Flags:    accountDisabledFlags,
	}
	var parmErr uint32
	status, _, _ := procNetUserAdd.Call(
		0,
		uintptr(userInfoLevel1),
		uintptr(unsafe.Pointer(&info)),
		uintptr(unsafe.Pointer(&parmErr)),
	)
	switch uint32(status) {
	case nerrSuccess, nerrUserExists:
		return nil
	default:
		return fmt.Errorf("NetUserAdd %s failed: %w", username, syscall.Errno(status))
	}
}

func setPassword(username, password string) error {
	namePtr, err := windows.UTF16PtrFromString(username)
	if err != nil {
		return err
	}
	passwordPtr, err := windows.UTF16PtrFromString(password)
	if err != nil {
		return err
	}
	info := userInfo1003{Password: passwordPtr}
	return netUserSetInfo(namePtr, userInfoLevel1003, unsafe.Pointer(&info))
}

func setUserFlags(username string, flags uint32) error {
	namePtr, err := windows.UTF16PtrFromString(username)
	if err != nil {
		return err
	}
	info := userInfo1008{Flags: flags}
	return netUserSetInfo(namePtr, userInfoLevel1008, unsafe.Pointer(&info))
}

func netUserSetInfo(namePtr *uint16, level uint32, info unsafe.Pointer) error {
	var parmErr uint32
	status, _, _ := procNetUserSetInfo.Call(
		0,
		uintptr(unsafe.Pointer(namePtr)),
		uintptr(level),
		uintptr(info),
		uintptr(unsafe.Pointer(&parmErr)),
	)
	if status != nerrSuccess {
		return fmt.Errorf("NetUserSetInfo level %d failed: %w", level, syscall.Errno(status))
	}
	return nil
}

func addToAdministrators(username string) error {
	status, err := localGroupMembersCall(procNetLocalGroupAddMembers, username)
	if err != nil {
		return err
	}
	switch status {
	case nerrSuccess, errorMemberInAlias:
		return nil
	default:
		return fmt.Errorf("NetLocalGroupAddMembers failed: %w", syscall.Errno(status))
	}
}

func removeFromAdministrators(username string) error {
	status, err := localGroupMembersCall(procNetLocalGroupDelMembers, username)
	if err != nil {
		if errors.Is(err, windows.ERROR_NONE_MAPPED) {
			return nil
		}
		return err
	}
	switch status {
	case nerrSuccess, nerrUserNotFound, nerrUserNotInGroup, errorMemberNotInAlias:
		return nil
	default:
		return fmt.Errorf("NetLocalGroupDelMembers failed: %w", syscall.Errno(status))
	}
}

func localGroupMembersCall(proc *syscall.LazyProc, username string) (uint32, error) {
	groupName, err := administratorsGroupName()
	if err != nil {
		return 0, err
	}
	groupPtr, err := windows.UTF16PtrFromString(groupName)
	if err != nil {
		return 0, err
	}
	userSID, _, _, err := windows.LookupSID("", username)
	if err != nil {
		return 0, err
	}
	info := localGroupMembersInfo0{SID: userSID}
	status, _, _ := proc.Call(
		0,
		uintptr(unsafe.Pointer(groupPtr)),
		uintptr(localGroupLevel0),
		uintptr(unsafe.Pointer(&info)),
		1,
	)
	return uint32(status), nil
}

func administratorsGroupName() (string, error) {
	sid, err := windows.StringToSid(adminAliasSID)
	if err != nil {
		return "", err
	}
	account, _, _, err := sid.LookupAccount("")
	if err != nil {
		return "", err
	}
	if account == "" {
		return "", fmt.Errorf("LookupAccountSid %s returned empty account name", adminAliasSID)
	}
	return account, nil
}

func hideAccountFromLogon(username string) error {
	key, _, err := registry.CreateKey(registry.LOCAL_MACHINE, specialAccountsUserListPath, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	return key.SetDWordValue(username, 0)
}

func cleanupAfterFailedPromote() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = (&windowsManager{}).Demote(ctx)
}
