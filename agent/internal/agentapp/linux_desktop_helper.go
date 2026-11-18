package agentapp

// Linux mode of the `desktop-helper` subcommand (#12117). The agent starts
// the helper inside a user's logind session with a single-use spawn ticket in
// its environment; without one the subcommand refuses to run.

import (
	"errors"
	"fmt"
	"os"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/userhelper"
)

// errLinuxDesktopHelperNotSpawned is returned when the Linux desktop-helper
// subcommand runs without the agent's launch environment.
var errLinuxDesktopHelperNotSpawned = errors.New("desktop-helper on Linux is started by the agent")

// runLinuxDesktopHelper reads and scrubs the launch environment before
// anything else runs, then hands over to the shared helper process setup.
// A missing or invalid environment exits 2 without connecting.
func runLinuxDesktopHelper() {
	env, err := linuxDesktopHelperEnv(os.Getenv, os.Unsetenv)
	if err != nil {
		if errors.Is(err, errLinuxDesktopHelperNotSpawned) {
			fmt.Fprintln(os.Stderr, err.Error())
		} else {
			fmt.Fprintln(os.Stderr, "desktop-helper: "+err.Error())
		}
		os.Exit(2)
	}
	runHelperProcessWith("desktop helper", desktopHelperRole(), desktopContext, ipc.HelperBinaryDesktopHelper, &env)
}

// linuxDesktopHelperEnv reads the Linux desktop helper's launch environment
// and removes the spawn ticket from this process's environment whatever the
// outcome, so no child process inherits it. Errors never carry the ticket.
func linuxDesktopHelperEnv(getenv func(string) string, unsetenv func(string) error) (userhelper.LinuxDesktopEnv, error) {
	if getenv(userhelper.EnvLinuxDesktopSpawnTicket) == "" {
		return userhelper.LinuxDesktopEnv{}, errLinuxDesktopHelperNotSpawned
	}
	env, err := userhelper.ParseLinuxDesktopEnv(getenv)
	_ = unsetenv(userhelper.EnvLinuxDesktopSpawnTicket)
	if err != nil {
		return userhelper.LinuxDesktopEnv{}, err
	}
	return env, nil
}

// runLinuxDesktopHelperClient runs the Linux desktop helper's one connection
// and exits with its code: 0 after an idle exit, a shutdown, or a broker
// disconnect after admission; 1 when it never authenticated; 2 when the
// broker permanently rejected it. It never reconnects: the ticket is spent.
func runLinuxDesktopHelperClient(name string, env *userhelper.LinuxDesktopEnv, context string, done <-chan struct{}) {
	client := userhelper.NewLinuxDesktopClient(*env, context)
	*env = userhelper.LinuxDesktopEnv{} // the client holds the only copy of the ticket
	code, err := userhelper.RunLinuxDesktopHelper(client, done, userhelper.LinuxDesktopHelperIdleExit)
	errText := ""
	if err != nil {
		errText = err.Error()
	}
	if code == userhelper.LinuxDesktopExitOK {
		log.Info("helper stopped", "name", name, "error", errText)
		return
	}
	log.Error("linux desktop helper exiting", "name", name, "exitCode", code, "error", errText)
	logging.StopShipper() // flush before os.Exit skips the deferred stop
	os.Exit(code)
}
