' Deferred custom action for the EnrollAgent CustomAction in breeze.wxs.
'
' Runs breeze-agent.exe enroll with the enrollment key/secret delivered via
' that child process's OWN environment block instead of its command line.
' A deferred EXE-type CustomAction has no way to do this — ExeCommand is the
' literal argv MSI hands the OS, full stop — which is why this is a script
' CA instead: WScript.Shell lets a script set environment entries for a
' process it then launches with Exec, and those entries never show up in
' the child's own command line the way argv does (readable by any local
' account via Get-CimInstance Win32_Process | Select CommandLine).
' breeze-agent.exe already prefers BREEZE_AGENT_ENROLLMENT_KEY /
' BREEZE_AGENT_ENROLLMENT_SECRET from its environment over a positional
' argument (resolveEnrollmentKey, internal/agentapp/main.go) — the
' Linux/macOS install scripts use the identical mechanism.
'
' Do not try to read these values via an ExeCommand's "[CustomActionData]"
' token instead of this script approach: see the comment on the
' BootstrapEnroll CustomAction in breeze.wxs for why that formats to an
' empty string for a deferred EXE CA and silently broke every enrollment
' once already. Only DLL/script CAs can read CustomActionData — that
' constraint is exactly why this needs to be a script CA to avoid putting
' the secret on the child's command line at all.

Dim data, parts, agentKey, serverUrl, agentSecret, agentExe
data = Session.Property("CustomActionData")
parts = Split(data, "|")
If UBound(parts) < 3 Then
    Err.Raise vbObjectError + 1, "EnrollAgent", "malformed enrollment data (expected key|server|secret|exePath)"
End If
agentKey = parts(0)
serverUrl = parts(1)
agentSecret = parts(2)
agentExe = parts(3)

Dim shell, cmd, exitCode
Set shell = CreateObject("WScript.Shell")
shell.Environment("Process")("BREEZE_AGENT_ENROLLMENT_KEY") = agentKey
shell.Environment("Process")("BREEZE_AGENT_ENROLLMENT_SECRET") = agentSecret

' Run (not Exec) — this waits synchronously and returns the exit code
' directly, with no polling loop. Exec's async model needs WScript.Sleep to
' poll for completion, but the global WScript object is not available in an
' MSI-hosted script custom action (only the WshShell object this script
' already created via CreateObject is); Run avoids that entirely.
cmd = Chr(34) & agentExe & Chr(34) & " enroll --server " & Chr(34) & serverUrl & Chr(34) & " --quiet"
exitCode = shell.Run(cmd, 0, True)

If exitCode <> 0 Then
    Err.Raise vbObjectError + 1, "EnrollAgent", "breeze-agent.exe enroll exited with code " & exitCode
End If
