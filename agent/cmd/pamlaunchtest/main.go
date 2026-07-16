//go:build windows

// Command pamlaunchtest is a DIAGNOSTIC harness for validating the PAM Path B
// raw launch primitive (winTokenLauncher.Launch) on a Windows VM, decoupled
// from ETW/user-helper/PAM-rule machinery. Must run as SYSTEM (LogonUser +
// SetTokenInformation(TokenSessionId) + CreateProcessAsUser require SE_TCB /
// SE_ASSIGNPRIMARYTOKEN, which only SYSTEM holds).
//
//	pamlaunchtest.exe -user <acct> -pass <pwd> -session <id> [-target C:\...\mmc.exe] [-cmdline "..."]
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/breeze-rmm/agent/internal/pamactuator"
)

func main() {
	// When re-exec'd as the in-session second stage (spawnSessionHelper passes
	// the sentinel), run the helper and exit before touching flags. In normal
	// invocation this returns immediately.
	pamactuator.MaybeRunSessionLaunchHelper()

	user := flag.String("user", "", "account to LogonUser as (local admin for an elevated launch)")
	pass := flag.String("pass", "", "account password")
	target := flag.String("target", `C:\Windows\System32\mmc.exe`, "target executable path")
	cmdline := flag.String("cmdline", "", "command line (defaults to target)")
	session := flag.Uint("session", 0, "interactive session id to place the process into")
	subject := flag.String("subject", "", "DIAG (#8): resolve the launch session from this subject username via the production resolver, instead of a hardcoded -session")
	sessionToken := flag.Bool("sessiontoken", false, "DIAG control: launch via WTSQueryUserToken (session's own token) instead of LogonUser")
	flag.Parse()

	// #8 resolver validation: when -subject is given, resolve the session id the
	// same way the production actuator does (username → live interactive session)
	// and launch into it. Proves sessionIDForUsername picks the requester's RDP
	// session on a multi-session host, not the console.
	sessionID := uint32(*session)
	if *subject != "" {
		id, source, err := pamactuator.DiagResolveSession(*subject)
		if err != nil {
			fmt.Printf("FAIL resolve subject=%q err=%v\n", *subject, err)
			os.Exit(1)
		}
		fmt.Printf("RESOLVED subject=%q session=%d source=%q\n", *subject, id, source)
		sessionID = id
	}

	if *sessionToken {
		pid, err := pamactuator.DiagLaunchAsSessionUser(sessionID, *target)
		if err != nil {
			fmt.Printf("FAIL err=%v\n", err)
			os.Exit(1)
		}
		fmt.Printf("OK(sessiontoken) pid=%d target=%q session=%d\n", pid, *target, *session)
		return
	}

	if *user == "" || *pass == "" {
		fmt.Fprintln(os.Stderr, "user and pass are required")
		os.Exit(2)
	}
	cl := *cmdline
	if cl == "" {
		cl = *target
	}

	pid, reason, err := pamactuator.DiagLaunch(*user, *pass, *target, cl, sessionID)
	if reason != "" || err != nil {
		fmt.Printf("FAIL reason=%q err=%v\n", reason, err)
		os.Exit(1)
	}
	fmt.Printf("OK pid=%d target=%q session=%d\n", pid, *target, sessionID)
}
