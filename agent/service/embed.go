// Package service carries the service and task definitions the installers
// ship, embedded so the agent can use the same bytes at run time.
package service

import _ "embed"

// WindowsUserHelperTaskXML is the definition of the \Breeze\AgentUserHelper
// logon task, the same file the MSI ships and install-windows.ps1 registers
// (installer/breeze.wxs UserTaskXmlPath). Embedding the file itself, rather
// than a copy, is what keeps the agent's repair (internal/userhelpertask) from
// drifting from the installer.
//
//go:embed windows/breeze-agent-user-task.xml
var WindowsUserHelperTaskXML []byte
