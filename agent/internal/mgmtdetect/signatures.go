package mgmtdetect

// AllSignatures returns the complete built-in signature database for management
// tool detection. Each signature leads with an active-state check
// (service_running or process_running) for fast short-circuit evaluation,
// followed by installed-state fallbacks (file_exists, registry_value, launch_daemon).
func AllSignatures() []Signature {
	return []Signature{
		// =====================================================================
		// RMM — Remote Monitoring & Management (11 tools)
		// =====================================================================

		// ConnectWise Automate (LabTech)
		{
			Name: "ConnectWise Automate", Category: CategoryRMM,
			OS: []string{"windows"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "LTService"},
				{Type: CheckProcessRunning, Value: "LTSVC.exe"},
				{Type: CheckFileExists, Value: `C:\Windows\LTSvc\LTSVC.exe`},
			},
			Version: &Check{Type: CheckRegistryValue, Value: `HKLM\SOFTWARE\LabTech\Service`, Parse: "Version"},
		},

		// ScreenConnect (ConnectWise Control)
		{
			Name: "ScreenConnect", Category: CategoryRMM,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "ScreenConnect Client", OS: "windows"},
				{Type: CheckProcessRunning, Value: "ScreenConnect.ClientService.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "ScreenConnect", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\ScreenConnect Client\ScreenConnect.ClientService.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/opt/screenconnect-client/ScreenConnect.Client", OS: "darwin"},
			},
		},

		// Datto RMM (formerly Autotask)
		{
			Name: "Datto RMM", Category: CategoryRMM,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "CagService", OS: "windows"},
				{Type: CheckProcessRunning, Value: "CagService.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "AEMAgent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\CentraStage\CagService.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Application Support/CentraStage/AEMAgent", OS: "darwin"},
				{Type: CheckLaunchDaemon, Value: "com.centrastage.agent", OS: "darwin"},
			},
		},

		// NinjaOne (NinjaRMM)
		{
			Name: "NinjaOne", Category: CategoryRMM,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "NinjaRMMAgent", OS: "windows"},
				{Type: CheckProcessRunning, Value: "NinjaRMMAgent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "ninjarmm-agent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\ProgramData\NinjaRMMAgent\ninjarmm-cli.exe`, OS: "windows"},
				{Type: CheckLaunchDaemon, Value: "com.ninjarmm.agent", OS: "darwin"},
			},
		},

		// Atera
		{
			Name: "Atera", Category: CategoryRMM,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "AteraAgent", OS: "windows"},
				{Type: CheckProcessRunning, Value: "AteraAgent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "AteraAgent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\ATERA Networks\AteraAgent\AteraAgent.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/AteraAgent/AteraAgent", OS: "darwin"},
			},
		},

		// SyncroMSP
		{
			Name: "SyncroMSP", Category: CategoryRMM,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "Syncro", OS: "windows"},
				{Type: CheckProcessRunning, Value: "SyncroLive.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "syncro", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\ProgramData\Syncro\bin\SyncroLive.exe`, OS: "windows"},
				{Type: CheckLaunchDaemon, Value: "com.syncromsp.agent", OS: "darwin"},
			},
		},

		// N-able (SolarWinds N-central / N-able RMM)
		{
			Name: "N-able", Category: CategoryRMM,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "Windows Agent Service", OS: "windows"},
				{Type: CheckProcessRunning, Value: "agent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "agent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\N-able Technologies\Windows Agent\bin\agent.exe`, OS: "windows"},
				{Type: CheckLaunchDaemon, Value: "com.n-able.agent", OS: "darwin"},
			},
		},

		// Kaseya VSA
		{
			Name: "Kaseya VSA", Category: CategoryRMM,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "Kaseya Agent Service", OS: "windows"},
				{Type: CheckProcessRunning, Value: "AgentMon.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "KaseyaAgent", OS: "darwin"},
				{Type: CheckRegistryValue, Value: `HKLM\SOFTWARE\WOW6432Node\Kaseya\Agent`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Application Support/Kaseya", OS: "darwin"},
			},
		},

		// Pulseway
		{
			Name: "Pulseway", Category: CategoryRMM,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "PulsewayService", OS: "windows"},
				{Type: CheckProcessRunning, Value: "PulsewayService.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "pulseway", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\Pulseway\PulsewayService.exe`, OS: "windows"},
				{Type: CheckLaunchDaemon, Value: "com.pulseway.agent", OS: "darwin"},
			},
		},

		// Level
		{
			Name: "Level", Category: CategoryRMM,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "level-agent", OS: "windows"},
				{Type: CheckProcessRunning, Value: "level-agent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "level-agent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\ProgramData\Level\level-agent.exe`, OS: "windows"},
				{Type: CheckLaunchDaemon, Value: "com.level.agent", OS: "darwin"},
			},
		},

		// Tactical RMM
		{
			Name: "Tactical RMM", Category: CategoryRMM,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "tacticalrmm", OS: "windows"},
				{Type: CheckProcessRunning, Value: "tacticalrmm.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "tacticalagent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\TacticalAgent\tacticalrmm.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/usr/local/bin/tacticalagent", OS: "darwin"},
			},
		},

		// =====================================================================
		// Remote Access (7 tools)
		// =====================================================================

		// TeamViewer
		{
			Name: "TeamViewer", Category: CategoryRemoteAccess,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "TeamViewer", OS: "windows"},
				{Type: CheckProcessRunning, Value: "TeamViewer.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "TeamViewer", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\TeamViewer\TeamViewer.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Applications/TeamViewer.app", OS: "darwin"},
			},
		},

		// AnyDesk
		{
			Name: "AnyDesk", Category: CategoryRemoteAccess,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "AnyDesk", OS: "windows"},
				{Type: CheckProcessRunning, Value: "AnyDesk.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "AnyDesk", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\AnyDesk\AnyDesk.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Applications/AnyDesk.app", OS: "darwin"},
			},
		},

		// Splashtop
		{
			Name: "Splashtop", Category: CategoryRemoteAccess,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "SplashtopRemoteService", OS: "windows"},
				{Type: CheckProcessRunning, Value: "SRService.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "SplashtopStreamer", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\Splashtop\Splashtop Remote\Server\SRService.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Applications/Splashtop Streamer.app", OS: "darwin"},
			},
		},

		// LogMeIn
		{
			Name: "LogMeIn", Category: CategoryRemoteAccess,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "LogMeIn", OS: "windows"},
				{Type: CheckProcessRunning, Value: "LogMeIn.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "LogMeIn", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\LogMeIn\x64\LogMeIn.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Application Support/LogMeIn", OS: "darwin"},
			},
		},

		// BeyondTrust (Bomgar)
		{
			Name: "BeyondTrust", Category: CategoryRemoteAccess,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "bomgar-scc", OS: "windows"},
				{Type: CheckProcessRunning, Value: "bomgar-scc.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "bomgar-scc", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Bomgar\bomgar-scc.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Application Support/bomgar-scc", OS: "darwin"},
			},
		},

		// GoTo Resolve (GoToAssist)
		{
			Name: "GoTo Resolve", Category: CategoryRemoteAccess,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "GoToAssist Remote Support Customer", OS: "windows"},
				{Type: CheckProcessRunning, Value: "g2ax_comm_expert.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "GoToResolve", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\GoTo\GoTo Resolve\GoToResolve.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Applications/GoTo Resolve.app", OS: "darwin"},
			},
		},

		// RustDesk
		{
			Name: "RustDesk", Category: CategoryRemoteAccess,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "RustDesk", OS: "windows"},
				{Type: CheckProcessRunning, Value: "rustdesk.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "RustDesk", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\RustDesk\rustdesk.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Applications/RustDesk.app", OS: "darwin"},
			},
		},

		// =====================================================================
		// Endpoint Security — AV/EDR (8 tools)
		// =====================================================================

		// CrowdStrike Falcon
		{
			Name: "CrowdStrike Falcon", Category: CategoryEndpointSecurity,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "CSFalconService", OS: "windows"},
				{Type: CheckProcessRunning, Value: "CSFalconContainer.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "falcond", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\CrowdStrike\CSFalconService.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/CS/falcond", OS: "darwin"},
			},
			Version: &Check{Type: CheckCommand, Value: `REG QUERY "HKLM\SYSTEM\CrowdStrike\{9b03c1d9-3138-44ed-9fae-d9f4c034b88d}\{16e0423f-7058-48c9-a204-725362b67639}\Default" /v CU`, Parse: `CU\s+REG_SZ\s+(.+)`},
		},

		// SentinelOne
		{
			Name: "SentinelOne", Category: CategoryEndpointSecurity,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "SentinelAgent", OS: "windows"},
				{Type: CheckProcessRunning, Value: "SentinelAgent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "sentineld", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\SentinelOne\Sentinel Agent\SentinelAgent.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Sentinel/sentinel-agent.bundle", OS: "darwin"},
			},
		},

		// Sophos Endpoint
		{
			Name: "Sophos Endpoint", Category: CategoryEndpointSecurity,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "Sophos Endpoint Defense Service", OS: "windows"},
				{Type: CheckProcessRunning, Value: "SophosFileScanner.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "SophosAntiVirus", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Sophos\Endpoint Defense\SEDService.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Sophos Anti-Virus", OS: "darwin"},
			},
		},

		// Bitdefender Endpoint Security
		{
			Name: "Bitdefender", Category: CategoryEndpointSecurity,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "EPSecurityService", OS: "windows"},
				{Type: CheckProcessRunning, Value: "EPSecurityService.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "BDLDaemon", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Bitdefender\Endpoint Security\EPSecurityService.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Bitdefender/AVP/BDLDaemon", OS: "darwin"},
			},
		},

		// Malwarebytes
		{
			Name: "Malwarebytes", Category: CategoryEndpointSecurity,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "MBAMService", OS: "windows"},
				{Type: CheckProcessRunning, Value: "MBAMService.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "RTProtectionDaemon", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Malwarebytes\Anti-Malware\MBAMService.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Application Support/Malwarebytes/MBAM/Engine/RTProtectionDaemon", OS: "darwin"},
			},
		},

		// VMware Carbon Black
		{
			Name: "Carbon Black", Category: CategoryEndpointSecurity,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "CbDefense", OS: "windows"},
				{Type: CheckProcessRunning, Value: "RepMgr.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "CbOsxSensorService", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Confer\RepMgr.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Applications/CarbonBlack/CbOsxSensorService", OS: "darwin"},
			},
		},

		// Huntress
		{
			Name: "Huntress", Category: CategoryEndpointSecurity,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "HuntressAgent", OS: "windows"},
				{Type: CheckProcessRunning, Value: "HuntressAgent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "huntress", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Huntress\HuntressAgent.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Applications/Huntress.app", OS: "darwin"},
			},
		},

		// Microsoft Defender for Endpoint
		{
			Name: "Microsoft Defender", Category: CategoryEndpointSecurity,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "WinDefend", OS: "windows"},
				{Type: CheckProcessRunning, Value: "MsMpEng.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "wdavdaemon", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\ProgramData\Microsoft\Windows Defender\Platform`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Application Support/Microsoft Defender", OS: "darwin"},
			},
		},

		// =====================================================================
		// MDM — Mobile Device Management (8 tools)
		// =====================================================================

		// Microsoft Intune
		{
			Name: "Microsoft Intune", Category: CategoryMDM,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "IntuneManagementExtension", OS: "windows"},
				{Type: CheckProcessRunning, Value: "Microsoft.Management.Services.IntuneWindowsAgent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "IntuneMdmAgent", OS: "darwin"},
				{Type: CheckRegistryValue, Value: `HKLM\SOFTWARE\Microsoft\Enrollments`, OS: "windows"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\Microsoft Intune Management Extension\Microsoft.Management.Services.IntuneWindowsAgent.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Intune/Microsoft Intune Agent.app", OS: "darwin"},
			},
		},

		// JAMF Pro
		{
			Name: "JAMF Pro", Category: CategoryMDM,
			OS: []string{"darwin"},
			Checks: []Check{
				{Type: CheckProcessRunning, Value: "jamf"},
				{Type: CheckProcessRunning, Value: "JamfManagementService"},
				{Type: CheckFileExists, Value: "/usr/local/jamf/bin/jamf"},
				{Type: CheckLaunchDaemon, Value: "com.jamfsoftware.jamf.daemon"},
			},
		},

		// Mosyle
		{
			Name: "Mosyle", Category: CategoryMDM,
			OS: []string{"darwin"},
			Checks: []Check{
				{Type: CheckProcessRunning, Value: "MosyleAgent"},
				{Type: CheckFileExists, Value: "/Library/Application Support/Mosyle/MosyleAgent.app"},
				{Type: CheckLaunchDaemon, Value: "com.mosyle.agent"},
			},
		},

		// Kandji
		{
			Name: "Kandji", Category: CategoryMDM,
			OS: []string{"darwin"},
			Checks: []Check{
				{Type: CheckProcessRunning, Value: "kandji-daemon"},
				{Type: CheckFileExists, Value: "/Library/Kandji/Kandji Agent.app"},
				{Type: CheckLaunchDaemon, Value: "io.kandji.KandjiAgent"},
			},
		},

		// Addigy
		{
			Name: "Addigy", Category: CategoryMDM,
			OS: []string{"darwin"},
			Checks: []Check{
				{Type: CheckProcessRunning, Value: "addigy_agent"},
				{Type: CheckFileExists, Value: "/Library/Addigy/addigy_agent"},
				{Type: CheckLaunchDaemon, Value: "com.addigy.agent"},
			},
		},

		// Hexnode
		{
			Name: "Hexnode", Category: CategoryMDM,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "HexnodeUEMService", OS: "windows"},
				{Type: CheckProcessRunning, Value: "HexnodeUEM.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "HexnodeAgent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Hexnode\HexnodeUEM.exe`, OS: "windows"},
				{Type: CheckLaunchDaemon, Value: "com.hexnode.agent", OS: "darwin"},
			},
		},

		// Fleet (osquery-based)
		{
			Name: "Fleet", Category: CategoryMDM,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "orbit", OS: "windows"},
				{Type: CheckProcessRunning, Value: "orbit.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "orbit", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Orbit\bin\orbit.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/opt/orbit/bin/orbit", OS: "darwin"},
				{Type: CheckLaunchDaemon, Value: "com.fleetdm.orbit", OS: "darwin"},
			},
		},

		// Workspace ONE (VMware AirWatch)
		{
			Name: "Workspace ONE", Category: CategoryMDM,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "AirWatchService", OS: "windows"},
				{Type: CheckProcessRunning, Value: "AWACMClient.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "hubagent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\AirWatch\AgentUI\AW.WinPC.Updater.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Application Support/AirWatch", OS: "darwin"},
				{Type: CheckLaunchDaemon, Value: "com.airwatch.agent", OS: "darwin"},
			},
		},

		// =====================================================================
		// Backup (6 tools)
		// =====================================================================

		// Veeam Agent
		{
			Name: "Veeam Agent", Category: CategoryBackup,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "VeeamEndpointBackupSvc", OS: "windows"},
				{Type: CheckProcessRunning, Value: "VeeamAgent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "veeamagent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Veeam\Endpoint Backup\VeeamAgent.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Application Support/Veeam/Agent", OS: "darwin"},
			},
		},

		// Acronis Cyber Protect
		{
			Name: "Acronis Cyber Protect", Category: CategoryBackup,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "AcronisCyberProtectionService", OS: "windows"},
				{Type: CheckProcessRunning, Value: "acronis_service.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "acronis_agent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Acronis\CyberProtect\acronis_service.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Application Support/Acronis", OS: "darwin"},
			},
		},

		// Datto BCDR (Backup, Continuity & Disaster Recovery)
		{
			Name: "Datto BCDR", Category: CategoryBackup,
			OS: []string{"windows"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "DattoBackupAgent"},
				{Type: CheckProcessRunning, Value: "DattoBackupAgent.exe"},
				{Type: CheckFileExists, Value: `C:\Program Files\Datto\Backup Agent\DattoBackupAgent.exe`},
			},
		},

		// Axcient
		{
			Name: "Axcient", Category: CategoryBackup,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "AxcientAgent", OS: "windows"},
				{Type: CheckProcessRunning, Value: "AxcientAgent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "AxcientAgent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Axcient\AxcientAgent.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Application Support/Axcient", OS: "darwin"},
			},
		},

		// Carbonite
		{
			Name: "Carbonite", Category: CategoryBackup,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "CarboniteService", OS: "windows"},
				{Type: CheckProcessRunning, Value: "CarboniteService.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "CarboniteAgent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Carbonite\Carbonite Backup\CarboniteService.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Application Support/Carbonite", OS: "darwin"},
			},
		},

		// CrashPlan
		{
			Name: "CrashPlan", Category: CategoryBackup,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "Code42 CrashPlan Service", OS: "windows"},
				{Type: CheckProcessRunning, Value: "CrashPlanService.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "CrashPlanService", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\CrashPlan\CrashPlanService.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Application Support/CrashPlan", OS: "darwin"},
				{Type: CheckLaunchDaemon, Value: "com.code42.service", OS: "darwin"},
			},
		},

		// =====================================================================
		// SIEM — Security Information & Event Management (3 tools)
		// =====================================================================

		// Splunk Universal Forwarder
		{
			Name: "Splunk Universal Forwarder", Category: CategorySIEM,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "SplunkForwarder", OS: "windows"},
				{Type: CheckProcessRunning, Value: "splunkd.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "splunkd", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\SplunkUniversalForwarder\bin\splunkd.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/opt/splunkforwarder/bin/splunkd", OS: "darwin"},
			},
		},

		// Elastic Agent
		{
			Name: "Elastic Agent", Category: CategorySIEM,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "Elastic Agent", OS: "windows"},
				{Type: CheckProcessRunning, Value: "elastic-agent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "elastic-agent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Elastic\Agent\elastic-agent.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/opt/Elastic/Agent/elastic-agent", OS: "darwin"},
				{Type: CheckLaunchDaemon, Value: "co.elastic.agent", OS: "darwin"},
			},
		},

		// Wazuh Agent
		{
			Name: "Wazuh", Category: CategorySIEM,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "WazuhSvc", OS: "windows"},
				{Type: CheckProcessRunning, Value: "wazuh-agent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "wazuh-agentd", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\ossec-agent\wazuh-agent.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Ossec/bin/wazuh-agentd", OS: "darwin"},
			},
		},

		// =====================================================================
		// DNS Filtering (3 tools)
		// =====================================================================

		// Cisco Umbrella (OpenDNS)
		{
			Name: "Cisco Umbrella", Category: CategoryDNSFiltering,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "Umbrella_RC", OS: "windows"},
				{Type: CheckProcessRunning, Value: "UmbrellaClient.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "dnscrypt-proxy", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\OpenDNS\Umbrella Roaming Client\UmbrellaClient.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/opt/cisco/secureclient/bin/Umbrella", OS: "darwin"},
			},
		},

		// DNSFilter
		{
			Name: "DNSFilter", Category: CategoryDNSFiltering,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "DNSFilter Agent", OS: "windows"},
				{Type: CheckProcessRunning, Value: "DNSFilterAgent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "DNSFilterAgent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\DNSFilter\DNSFilterAgent.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Application Support/DNSFilter", OS: "darwin"},
			},
		},

		// Netskope Client
		{
			Name: "Netskope", Category: CategoryDNSFiltering,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "STAgentSvc", OS: "windows"},
				{Type: CheckProcessRunning, Value: "STAgent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "nsskpd", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\Netskope\STAgent\STAgent.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Application Support/Netskope/STAgent", OS: "darwin"},
			},
		},

		// =====================================================================
		// Zero Trust / VPN (6 tools)
		// =====================================================================

		// Zscaler Client Connector
		{
			Name: "Zscaler", Category: CategoryZeroTrustVPN,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "ZSATunnelService", OS: "windows"},
				{Type: CheckProcessRunning, Value: "ZSATunnel.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "ZscalerTunnel", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Zscaler\ZSATunnel\ZSATunnel.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Applications/Zscaler/Zscaler.app", OS: "darwin"},
			},
		},

		// Cloudflare WARP
		{
			Name: "Cloudflare WARP", Category: CategoryZeroTrustVPN,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "CloudflareWARP", OS: "windows"},
				{Type: CheckProcessRunning, Value: "warp-svc.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "Cloudflare WARP", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Cloudflare\Cloudflare WARP\warp-svc.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Applications/Cloudflare WARP.app", OS: "darwin"},
				{Type: CheckLaunchDaemon, Value: "com.cloudflare.1dot1dot1dot1.macos.warp.daemon", OS: "darwin"},
			},
		},

		// Tailscale
		{
			Name: "Tailscale", Category: CategoryZeroTrustVPN,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "Tailscale", OS: "windows"},
				{Type: CheckProcessRunning, Value: "tailscaled.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "tailscaled", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Tailscale\tailscaled.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Applications/Tailscale.app", OS: "darwin"},
				{Type: CheckLaunchDaemon, Value: "com.tailscale.ipn.macos.network-extension", OS: "darwin"},
			},
		},

		// Cisco AnyConnect
		{
			Name: "Cisco AnyConnect", Category: CategoryZeroTrustVPN,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "vpnagent", OS: "windows"},
				{Type: CheckProcessRunning, Value: "vpnagent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "vpnagentd", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\Cisco\Cisco AnyConnect Secure Mobility Client\vpnagent.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/opt/cisco/secureclient/bin/vpnagentd", OS: "darwin"},
			},
		},

		// Palo Alto GlobalProtect
		{
			Name: "GlobalProtect", Category: CategoryZeroTrustVPN,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "PanGPS", OS: "windows"},
				{Type: CheckProcessRunning, Value: "PanGPS.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "GlobalProtect", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Palo Alto Networks\GlobalProtect\PanGPS.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Applications/GlobalProtect.app", OS: "darwin"},
			},
		},

		// FortiClient
		{
			Name: "FortiClient", Category: CategoryZeroTrustVPN,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "FortiClient", OS: "windows"},
				{Type: CheckProcessRunning, Value: "FortiClient.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "FortiClient", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Fortinet\FortiClient\FortiClient.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Application Support/Fortinet/FortiClient", OS: "darwin"},
			},
		},

		// =====================================================================
		// Policy Engine / Configuration Management (5 tools)
		// =====================================================================

		// SCCM / MECM (Microsoft Endpoint Configuration Manager)
		{
			Name: "SCCM/MECM", Category: CategoryPolicyEngine,
			OS: []string{"windows"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "CcmExec"},
				{Type: CheckProcessRunning, Value: "CcmExec.exe"},
				{Type: CheckRegistryValue, Value: `HKLM\SOFTWARE\Microsoft\CCM`},
				{Type: CheckFileExists, Value: `C:\Windows\CCM\CcmExec.exe`},
			},
		},

		// Chef Infra Client
		{
			Name: "Chef", Category: CategoryPolicyEngine,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "chef-client", OS: "windows"},
				{Type: CheckProcessRunning, Value: "chef-client", OS: "windows"},
				{Type: CheckProcessRunning, Value: "chef-client", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\opscode\chef\bin\chef-client.bat`, OS: "windows"},
				{Type: CheckFileExists, Value: "/opt/chef/bin/chef-client", OS: "darwin"},
			},
		},

		// Puppet Agent
		{
			Name: "Puppet", Category: CategoryPolicyEngine,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "puppet", OS: "windows"},
				{Type: CheckProcessRunning, Value: "puppet.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "puppet", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Puppet Labs\Puppet\bin\puppet.bat`, OS: "windows"},
				{Type: CheckFileExists, Value: "/opt/puppetlabs/bin/puppet", OS: "darwin"},
			},
		},

		// Salt Minion
		{
			Name: "Salt", Category: CategoryPolicyEngine,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "salt-minion", OS: "windows"},
				{Type: CheckProcessRunning, Value: "salt-minion.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "salt-minion", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\salt\salt-minion.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/opt/salt/bin/salt-minion", OS: "darwin"},
			},
		},

		// Automox (policy engine entry)
		{
			Name: "Automox", Category: CategoryPolicyEngine,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "amagent", OS: "windows"},
				{Type: CheckProcessRunning, Value: "amagent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "amagent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\Automox\amagent.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/opt/automox/amagent", OS: "darwin"},
			},
		},

		// =====================================================================
		// Identity / MFA (4 tools)
		// =====================================================================

		// Okta Verify
		{
			Name: "Okta Verify", Category: CategoryIdentityMFA,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckProcessRunning, Value: "Okta Verify.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "Okta Verify", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Okta\Okta Verify\OktaVerify.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Applications/Okta Verify.app", OS: "darwin"},
			},
		},

		// Duo Desktop (formerly Duo Device Health Application)
		{
			Name: "Duo Desktop", Category: CategoryIdentityMFA,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "DuoDesktop", OS: "windows"},
				{Type: CheckProcessRunning, Value: "DuoDesktop.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "Duo Desktop", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Duo\Duo Desktop\DuoDesktop.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Applications/Duo Desktop.app", OS: "darwin"},
			},
		},

		// JumpCloud Agent
		{
			Name: "JumpCloud", Category: CategoryIdentityMFA,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "jumpcloud-agent", OS: "windows"},
				{Type: CheckProcessRunning, Value: "jumpcloud-agent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "jumpcloud-agent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\JumpCloud\jumpcloud-agent.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/opt/jc/bin/jumpcloud-agent", OS: "darwin"},
				{Type: CheckLaunchDaemon, Value: "com.jumpcloud.darwin-agent", OS: "darwin"},
			},
		},

		// OneLogin Desktop
		{
			Name: "OneLogin", Category: CategoryIdentityMFA,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "OneLoginDesktop", OS: "windows"},
				{Type: CheckProcessRunning, Value: "OneLoginDesktop.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "OneLogin Desktop", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\OneLogin\OneLoginDesktop.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Applications/OneLogin Desktop.app", OS: "darwin"},
			},
		},

		// =====================================================================
		// Patch Management (1 tool — Automox duplicate for category coverage)
		// =====================================================================

		// Automox (patch management entry)
		{
			Name: "Automox", Category: CategoryPatchManagement,
			OS: []string{"windows", "darwin"},
			Checks: []Check{
				{Type: CheckServiceRunning, Value: "amagent", OS: "windows"},
				{Type: CheckProcessRunning, Value: "amagent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "amagent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\Automox\amagent.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/opt/automox/amagent", OS: "darwin"},
			},
		},
	}
}
