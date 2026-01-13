# Breeze RMM User Guide

Welcome to Breeze RMM, your modern Remote Monitoring and Management platform. This guide will help you get started and make the most of all the features available to manage your IT infrastructure.

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Device Management](#2-device-management)
3. [Scripting](#3-scripting)
4. [Alerting](#4-alerting)
5. [Remote Access](#5-remote-access)
6. [Automation & Policies](#6-automation--policies)
7. [Reports](#7-reports)

---

## 1. Getting Started

### Logging In

To access Breeze RMM:

1. Open your web browser and navigate to your Breeze RMM URL
2. Enter your email address and password
3. Click **Sign In**

![Login Page](screenshots/login.png)

If this is your first time logging in, you may have received an invitation email with a temporary password. You will be prompted to change it after your first login.

**Forgot your password?** Click the "Forgot password?" link on the login page. Enter your email address, and we will send you a password reset link.

### Understanding the Dashboard

After logging in, you will see the main dashboard. This is your central hub for monitoring your IT environment at a glance.

![Dashboard](screenshots/dashboard.png)

The dashboard displays:

- **Device Status Overview** - A summary showing how many devices are online, offline, or in maintenance mode
- **Recent Alerts** - The latest alerts that need your attention, color-coded by severity
- **Device Metrics** - Charts showing CPU, memory, and disk usage trends across your devices
- **Recent Activity** - A timeline of recent actions and events in your organization

### Navigating the Interface

The main navigation is located in the left sidebar. You can collapse or expand it by clicking the arrow icon at the top.

**Main Navigation:**

| Icon | Section | Description |
|------|---------|-------------|
| Dashboard | Home | Overview of your IT environment |
| Devices | Device Management | View and manage all your endpoints |
| Scripts | Script Library | Create and run scripts on devices |
| Automations | Automation Workflows | Set up automated tasks |
| Policies | Policy Management | Define and enforce compliance policies |
| Alerts | Alert Center | View and manage alerts |
| Reports | Reporting | Generate and schedule reports |
| Remote Access | Remote Sessions | Connect to devices remotely |

**Management Section:**

| Icon | Section | Description |
|------|---------|-------------|
| Organizations | Org Management | Manage customer organizations |
| Users | User Management | Manage user accounts and access |
| Roles | Role Management | Configure permissions and roles |
| Settings | System Settings | Configure your account and preferences |

### Setting Up Your Profile

To personalize your account:

1. Click your name or avatar in the top-right corner
2. Select **Profile** from the dropdown menu

![Profile Settings](screenshots/profile.png)

On your profile page, you can:

- Update your display name
- Change your email address
- Upload a profile picture
- Change your password

### Enabling Multi-Factor Authentication (MFA)

We strongly recommend enabling MFA to secure your account. Here is how:

1. Go to **Profile** and find the **Security** section
2. Click **Enable MFA**
3. Scan the QR code with your authenticator app (Google Authenticator, Authy, Microsoft Authenticator, etc.)
4. Enter the 6-digit code from your app to verify
5. **Important:** Save your recovery codes in a secure location. These can be used to access your account if you lose access to your authenticator app

![MFA Setup](screenshots/mfa-setup.png)

---

## 2. Device Management

Devices are the endpoints (computers, servers, workstations) that have the Breeze agent installed and are being monitored.

### Viewing Devices

Navigate to **Devices** from the sidebar to see all your managed endpoints.

![Device List](screenshots/device-list.png)

The device list shows:

- **Hostname** - The name of the device
- **Status** - Online (green), Offline (gray), or Maintenance (yellow)
- **OS** - Operating system (Windows, macOS, Linux)
- **Last Seen** - When the device last checked in
- **Site** - The location/site this device belongs to
- **Tags** - Custom tags for organization

**Filtering Devices:**

Use the filter bar at the top to narrow down your device list:

- **Status** - Filter by online, offline, or maintenance
- **Operating System** - Filter by Windows, macOS, or Linux
- **Site** - Filter by location
- **Tags** - Filter by custom tags
- **Search** - Type a hostname or IP address to search

### Device Details and Metrics

Click on any device to view its detailed information.

![Device Details](screenshots/device-details.png)

The device detail page includes:

**Overview Tab:**
- Device status and uptime
- Agent version
- Last check-in time
- Enrollment date
- Quick action buttons

**Metrics Tab:**
- Real-time and historical performance charts
- CPU usage over time
- Memory utilization
- Disk space usage
- Network activity

**Hardware Tab:**
- CPU model, cores, and threads
- RAM capacity
- Disk information
- GPU details
- Serial number
- Manufacturer and model

**Software Tab:**
- List of all installed applications
- Version numbers
- Publisher information
- Installation dates

**Network Tab:**
- Network interfaces
- IP addresses (local and public)
- MAC addresses

### Device Groups

Device groups help you organize your endpoints for easier management and targeted actions.

**Static Groups:**
You manually add devices to these groups. Great for organizing by department, function, or any custom category.

**Dynamic Groups:**
Devices are automatically added based on rules you define. For example:
- All Windows servers
- All devices with less than 10GB free disk space
- All devices in a specific site

![Device Groups](screenshots/device-groups.png)

**Creating a Device Group:**

1. Go to **Devices** and click **Groups** tab
2. Click **New Group**
3. Enter a name and description
4. Choose **Static** or **Dynamic** type
5. For static groups, select devices to add
6. For dynamic groups, define your filter rules
7. Click **Save**

### Hardware and Software Inventory

Breeze automatically collects detailed inventory information from all managed devices.

**Hardware Inventory:**
Access comprehensive hardware details including CPU specifications, memory, storage, and serial numbers. This is invaluable for:
- Asset tracking
- Hardware lifecycle management
- Capacity planning
- Warranty tracking

**Software Inventory:**
View all installed applications across your device fleet. Use this to:
- Audit software licenses
- Identify unauthorized software
- Track software versions for updates
- Ensure compliance with software policies

### Device Actions

From the device detail page, you can perform various actions:

![Device Actions](screenshots/device-actions.png)

| Action | Description |
|--------|-------------|
| **Restart** | Remotely restart the device |
| **Shutdown** | Remotely shut down the device |
| **Force Check-in** | Request immediate status update |
| **Run Script** | Execute a script on this device |
| **Start Remote Session** | Open a remote terminal or desktop |
| **Set Maintenance Mode** | Temporarily suppress alerts |
| **Edit Tags** | Add or remove tags |
| **Decommission** | Remove device from monitoring |

**Maintenance Mode:**
When performing planned maintenance, enable maintenance mode to temporarily suppress alerts. Set an end time for automatic return to normal monitoring.

---

## 3. Scripting

The scripting feature allows you to run scripts on one or more devices to perform administrative tasks, gather information, or make configuration changes.

### Script Library Overview

Navigate to **Scripts** to access your script library.

![Script Library](screenshots/script-library.png)

The library contains:

- **System Scripts** - Pre-built scripts provided by Breeze for common tasks
- **Organization Scripts** - Custom scripts created by your team
- **Categories** - Scripts organized by purpose (Maintenance, Security, Inventory, etc.)

### Creating and Editing Scripts

To create a new script:

1. Click **New Script** button
2. Fill in the script details:
   - **Name** - A descriptive name
   - **Description** - What the script does
   - **Category** - For organization
   - **Language** - PowerShell, Bash, Python, or CMD
   - **Target OS** - Which operating systems this script works on
   - **Run As** - System, User, or Elevated privileges
   - **Timeout** - Maximum execution time in seconds

![Script Editor](screenshots/script-editor.png)

3. Write your script in the code editor
4. Define any **parameters** the script accepts
5. Click **Save**

**Script Parameters:**
You can define parameters that prompt for input when the script is run. This makes scripts reusable for different scenarios.

Example parameters:
- Text input (file paths, usernames)
- Dropdown selections
- Yes/No checkboxes
- Numeric values

### Running Scripts on Devices

To execute a script:

1. Navigate to the script in your library
2. Click **Run Script**
3. Select target devices:
   - Individual devices
   - Device groups
   - Filter by criteria
4. If the script has parameters, enter the required values
5. Click **Execute**

![Script Execution](screenshots/script-execution.png)

You can also run scripts directly from a device's detail page using the **Run Script** action.

### Viewing Execution History

Every script execution is logged for audit and troubleshooting purposes.

**From the Scripts page:**
Click **Execution History** to see all recent script runs across your organization.

**From a device:**
The device detail page shows scripts that have run on that specific device.

![Execution History](screenshots/execution-history.png)

For each execution, you can view:
- Status (Pending, Running, Completed, Failed)
- Start and end times
- Exit code
- Standard output (stdout)
- Error output (stderr)
- Who triggered the execution

### Batch Operations

Run scripts on multiple devices simultaneously:

1. Select multiple devices using checkboxes
2. Click **Batch Actions** and choose **Run Script**
3. Select the script and configure parameters
4. Execute on all selected devices

The batch execution dashboard shows real-time progress:
- Devices targeted
- Devices completed
- Devices failed
- Overall status

---

## 4. Alerting

The alerting system monitors your devices and notifies you when issues occur that need attention.

### Understanding Alert Rules

Alert rules define the conditions that trigger alerts. Each rule specifies:

- **What to monitor** - CPU, memory, disk, service status, etc.
- **Threshold** - The value that triggers an alert
- **Severity** - How critical the issue is
- **Targets** - Which devices or groups to monitor

![Alert Rules](screenshots/alert-rules.png)

**Severity Levels:**

| Level | Color | Description |
|-------|-------|-------------|
| Critical | Red | Immediate attention required |
| High | Orange | Important issue that needs prompt attention |
| Medium | Yellow | Should be addressed soon |
| Low | Blue | Minor issue for awareness |
| Info | Gray | Informational notification |

### Creating Alert Rules

To create a new alert rule:

1. Navigate to **Alerts** then click **Rules** tab
2. Click **New Rule**
3. Configure the rule:

![Create Alert Rule](screenshots/create-alert-rule.png)

**Basic Settings:**
- **Name** - Descriptive name for the rule
- **Description** - Details about what this rule monitors
- **Severity** - Choose the appropriate level
- **Enabled** - Turn monitoring on/off

**Targets:**
- Select specific devices, device groups, or all devices
- Filter by operating system, site, or tags

**Conditions:**
Define when the alert should trigger:

| Metric | Example Condition |
|--------|------------------|
| CPU Usage | Greater than 90% for 5 minutes |
| Memory Usage | Greater than 85% for 10 minutes |
| Disk Space | Less than 10% free |
| Device Status | Offline for more than 15 minutes |
| Service Status | Service stopped |

**Advanced Options:**
- **Cooldown** - Minimum time between repeat alerts
- **Auto-resolve** - Automatically close alert when condition clears
- **Escalation Policy** - Define how alerts escalate if not addressed

4. Click **Save Rule**

### Managing Active Alerts

The **Alerts** page shows all active alerts requiring attention.

![Active Alerts](screenshots/active-alerts.png)

**Alert Actions:**

| Action | Description |
|--------|-------------|
| **View Details** | See full alert information and context |
| **Acknowledge** | Mark that you are aware and working on it |
| **Suppress** | Temporarily hide the alert (with end time) |
| **Resolve** | Close the alert with resolution notes |

**Alert Details:**
Click on any alert to see:
- The alert rule that triggered it
- Device information
- Timestamp and duration
- Current metric values
- Historical context
- Resolution history

### Notification Channels

Configure where alert notifications are sent.

Navigate to **Alerts** then click **Notification Channels** tab.

![Notification Channels](screenshots/notification-channels.png)

**Supported Channel Types:**

| Channel | Description |
|---------|-------------|
| **Email** | Send alerts to email addresses |
| **Slack** | Post to Slack channels via webhook |
| **Microsoft Teams** | Post to Teams channels via webhook |
| **Webhook** | Send to any HTTP endpoint |
| **PagerDuty** | Integrate with PagerDuty for on-call |
| **SMS** | Send text message notifications |

**Setting Up Email Notifications:**
1. Click **Add Channel** and select **Email**
2. Enter recipient email addresses
3. Configure which severity levels to receive
4. Save the channel

**Setting Up Slack:**
1. Create a Slack webhook URL in your Slack workspace
2. Click **Add Channel** and select **Slack**
3. Paste the webhook URL
4. Choose a display name and icon
5. Save the channel

### Escalation Policies

Escalation policies define what happens if an alert is not addressed within a certain time.

![Escalation Policy](screenshots/escalation-policy.png)

Example escalation:
1. **Immediate** - Notify primary on-call via Slack
2. **After 15 minutes** - Send email to team lead
3. **After 30 minutes** - Page secondary on-call
4. **After 1 hour** - Notify management

To create an escalation policy:
1. Go to **Alerts** then **Escalation Policies**
2. Click **New Policy**
3. Define each escalation step with timing and targets
4. Save and assign to alert rules

---

## 5. Remote Access

Breeze provides secure remote access to your managed devices for troubleshooting and administration.

### Remote Terminal Sessions

Start a command-line session on any device:

1. Go to the device detail page
2. Click **Remote Terminal** or navigate to **Remote Access** and select a device

![Remote Terminal](screenshots/remote-terminal.png)

The terminal provides:
- Full command-line access
- Support for all terminal commands
- Real-time interaction
- Session recording for audit

**Session Controls:**
- **Disconnect** - End the session
- **Clear** - Clear the terminal screen
- **Download Log** - Save session transcript

### File Transfer

Transfer files to and from managed devices:

1. Open a remote session or go to **Remote Access** then **File Manager**
2. Select the target device
3. Browse the remote file system

![File Manager](screenshots/file-manager.png)

**Upload Files:**
1. Navigate to the destination folder
2. Click **Upload**
3. Select files from your computer
4. Monitor upload progress

**Download Files:**
1. Navigate to the file location
2. Select the file(s)
3. Click **Download**
4. Save to your computer

**File Operations:**
- Create new folders
- Rename files
- Delete files (with confirmation)
- View file properties

### Session History

All remote sessions are logged for security and compliance.

Navigate to **Remote Access** then **Session History**.

![Session History](screenshots/session-history.png)

For each session, you can see:
- Device accessed
- User who initiated
- Session type (Terminal, Desktop, File Transfer)
- Start and end times
- Duration
- Bytes transferred
- Session recording (if enabled)

Use the filters to search by:
- Date range
- User
- Device
- Session type

---

## 6. Automation & Policies

Automate routine tasks and ensure devices comply with your standards.

### Creating Automations

Automations execute actions based on triggers. Navigate to **Automations** to manage them.

![Automations List](screenshots/automations-list.png)

**To create an automation:**

1. Click **New Automation**
2. Configure the automation:

![Create Automation](screenshots/create-automation.png)

**Basic Information:**
- Name and description
- Enable/disable toggle

**Trigger:**
Choose when the automation runs:

| Trigger Type | Description |
|-------------|-------------|
| **Schedule** | Run at specific times (daily, weekly, cron) |
| **Event** | Run when something happens (device enrolled, alert triggered) |
| **Webhook** | Run when called via HTTP |
| **Manual** | Only run when manually triggered |

**Conditions (Optional):**
Add conditions to filter which devices are affected:
- Operating system type
- Device group membership
- Tag matching
- Custom criteria

**Actions:**
Define what happens when triggered:
- Run a script
- Send a notification
- Create an alert
- Execute a command
- Multiple actions in sequence

**On Failure:**
Choose what happens if an action fails:
- **Stop** - Halt the automation
- **Continue** - Proceed to next action
- **Notify** - Send alert and continue

3. Click **Save**

### Understanding Triggers

**Schedule Triggers:**
```
Examples:
- Every day at 3:00 AM
- Every Monday at 8:00 PM
- First day of each month
- Custom cron expression
```

**Event Triggers:**
```
Available events:
- Device enrolled
- Device went offline
- Device came online
- Alert triggered
- Alert resolved
- Script completed
- Policy violation detected
```

### Policy Compliance

Policies define the desired state for your devices. Breeze monitors compliance and can automatically remediate issues.

Navigate to **Policies** to manage compliance policies.

![Policies List](screenshots/policies-list.png)

**Creating a Policy:**

1. Click **New Policy**
2. Configure:

**Basic Settings:**
- Name and description
- Enabled status

**Targets:**
- Select devices, groups, or criteria

**Rules:**
Define what should be true:

| Rule Type | Example |
|-----------|---------|
| Service Running | Windows Defender service must be running |
| Software Installed | Antivirus must be installed |
| Software Not Installed | Prohibited app must not be present |
| Registry Value | Firewall enabled registry key |
| File Exists | Required config file present |
| Disk Space | At least 10GB free space |

**Enforcement Mode:**

| Mode | Description |
|------|-------------|
| **Monitor** | Track compliance but take no action |
| **Warn** | Alert when non-compliant |
| **Enforce** | Automatically run remediation script |

**Remediation:**
- Select a script to run when non-compliant
- Configure remediation frequency
- Set maximum retry attempts

3. Click **Save**

### Compliance Dashboard

The compliance dashboard provides an overview of your policy compliance status.

![Compliance Dashboard](screenshots/compliance-dashboard.png)

**Dashboard shows:**
- Overall compliance percentage
- Compliance by policy
- Non-compliant devices list
- Compliance trends over time
- Recent remediation attempts

**Compliance Status:**

| Status | Meaning |
|--------|---------|
| Compliant | Device meets all policy requirements |
| Non-Compliant | Device fails one or more requirements |
| Pending | Compliance check in progress |
| Error | Unable to evaluate compliance |

Click on any policy or device to see detailed compliance information and remediation history.

---

## 7. Reports

Generate detailed reports about your IT environment for analysis, auditing, and stakeholder communication.

### Available Report Types

Navigate to **Reports** to access the reporting feature.

![Reports List](screenshots/reports-list.png)

**Built-in Report Types:**

| Report | Description |
|--------|-------------|
| **Device Inventory** | Complete list of all devices with hardware details |
| **Software Inventory** | All installed software across devices |
| **Alert Summary** | Alert activity over a time period |
| **Compliance** | Policy compliance status and history |
| **Performance** | Resource utilization metrics |
| **Executive Summary** | High-level overview for management |

### Running Ad-Hoc Reports

To generate a report immediately:

1. Click **New Report** or select an existing report
2. Choose the report type
3. Configure filters:
   - Date range
   - Devices or groups to include
   - Additional criteria specific to report type

![Run Report](screenshots/run-report.png)

4. Select output format:
   - **CSV** - For data analysis in spreadsheets
   - **PDF** - For sharing and printing
   - **Excel** - For advanced data manipulation

5. Click **Generate**

The report will be processed, and you will be notified when ready. Large reports may take a few minutes.

### Scheduling Reports

Automatically generate reports on a regular basis:

1. Create or edit a report
2. Under **Schedule**, select frequency:
   - **One Time** - Generate once
   - **Daily** - Every day at specified time
   - **Weekly** - Every week on specified day
   - **Monthly** - Every month on specified date

![Schedule Report](screenshots/schedule-report.png)

3. Configure delivery:
   - Email recipients
   - Notification channels

4. Save the scheduled report

### Exporting Reports

**Download Options:**
After a report is generated, download it in your preferred format:
- Click **Download** button
- Choose CSV, PDF, or Excel format

**Email Reports:**
Send reports directly:
- Click **Email** on the report
- Enter recipient addresses
- Add a custom message
- Send

**Report Archive:**
All generated reports are stored for historical reference:
- Go to **Reports** then **Report History**
- Filter by date range, report type, or status
- Download or view past reports

### Report Builder

For custom reports, use the Report Builder:

1. Click **Report Builder**
2. Select data source (Devices, Software, Alerts, etc.)
3. Choose columns to include
4. Apply filters
5. Set sorting
6. Preview the report
7. Save as a new report template

![Report Builder](screenshots/report-builder.png)

---

## Need Help?

If you have questions or need assistance:

- **Documentation** - Check this user guide and other documentation
- **Support** - Contact your IT administrator or support team
- **Keyboard Shortcuts** - Press `?` anywhere in the app to see available shortcuts

Thank you for using Breeze RMM. We are here to help you manage your IT infrastructure efficiently and securely.

---

*This documentation is for Breeze RMM. For technical documentation and API reference, please see the developer documentation.*
