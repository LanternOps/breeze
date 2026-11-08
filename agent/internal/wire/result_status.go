package wire

// ResultStatusHandedOff marks a command result that this process must NOT
// deliver, because another process owns it (#11154). It never goes on the
// wire: the server accepts only completed, failed and timeout.
//
// The Windows self_uninstall handler returns it after handing the teardown to
// a detached helper. The helper outlives the agent (stopping the agent's
// service kills the agent), runs and verifies the teardown, and only then
// reports the command completed or failed itself. Every delivery path drops
// the marker and leaves the command's #8296 journal entry in place, so an
// agent that restarts after a helper failed still reports the command failed.
const ResultStatusHandedOff = "handed_off"
