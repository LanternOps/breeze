# Windows Runbook — validate Graph-constructed `TenantAutoMount` mounts

Companion to [`2026-06-19-tenant-automount-library-id.md`](./2026-06-19-tenant-automount-library-id.md).
Goal: one yes/no — **does a `TenantAutoMount` value built from Microsoft Graph IDs actually mount the library?**

## 0. Prereqs (one-time)

- Windows 10/11 box signed into a OneDrive **Business** account on a **test tenant**.
- OneDrive **Files On-Demand ON** (Settings → Sync and back up → Advanced). AutoMount is a no-op without it.
- Pick a test SharePoint library this user has **NEVER synced** — a previously-stopped library won't re-mount and gives a false negative.
- Graph access to that tenant — easiest is [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer) signed in as a tenant admin.
- Run on a throwaway/test profile (this writes the `Policies` hive). Cleanup at the bottom.

## 1. Capture ground truth (the known-good value)

Browser → open the test library → **Sync** → **Copy library ID**. Paste into Notepad. Shape:

```
tenantId=…&siteId={…}&webId={…}&listId={…}&webUrl=https://…&version=1
```

## 2. Pull the same library from Graph

In Graph Explorer (replace host/path with your test site):

```http
GET https://graph.microsoft.com/v1.0/sites/{hostname}:/sites/{sitepath}?$select=id,webUrl,sharepointIds
GET https://graph.microsoft.com/v1.0/sites/{site-id}/drives?$select=name,id&$expand=list($select=id,sharePointIds)
```

From the drive matching your library, grab `list.sharePointIds`: `tenantId`, `siteId`, `webId`, `listId`, `siteUrl`.

**Check:** do those four GUIDs equal the braced GUIDs in the step-1 string? (case-insensitive). If yes, construction is confirmed before you even mount.

## 3. Build the value from Graph and write it (PowerShell, as the signed-in user)

```powershell
# paste the values from step 2's sharePointIds (GUIDs WITHOUT braces — we add them below):
$tenantId = "PUT-TENANT-GUID"
$siteId   = "PUT-SITE-GUID"
$webId    = "PUT-WEB-GUID"
$listId   = "PUT-LIST-GUID"
$siteUrl  = "https://yourtenant.sharepoint.com/sites/YourSite"

$enc = [uri]::EscapeDataString($siteUrl)
$val = "tenantId=$tenantId&siteId={$siteId}&webId={$webId}&listId={$listId}&webUrl=$enc&version=1"

$key = "HKCU:\SOFTWARE\Policies\Microsoft\OneDrive\TenantAutoMount"
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name "SpikeTest" -Value $val -PropertyType String -Force | Out-Null
$val   # eyeball it against the step-1 string
```

## 4. Force the mount (skip the 8-hour timer) and restart OneDrive

```powershell
$acct = "HKCU:\SOFTWARE\Microsoft\OneDrive\Accounts\Business1"
New-ItemProperty -Path $acct -Name "TimerAutoMount" -PropertyType QWord -Value 1 -Force | Out-Null

Get-Process OneDrive -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process "$env:LOCALAPPDATA\Microsoft\OneDrive\OneDrive.exe"
```

## 5. Confirm it actually mounted (the real gate)

Wait a couple of minutes, then check **both**:

- The library appears in **File Explorer** under the org node (not just the registry key existing).
- It shows in OneDrive's tenant cache:

```powershell
Get-ChildItem 'HKCU:\SOFTWARE\Microsoft\OneDrive\Accounts\Business1\Tenants' -Recurse -ErrorAction SilentlyContinue
```

## 6. Record the result

- ✅ **Mounted** → verdict **CLEAN confirmed**. Update the spike doc status; greenlight the agent applier + Graph picker.
- ❌ **Didn't mount** → capture for diagnosis: (a) the step-1 copied string, (b) the Graph `sharePointIds`, (c) the `$val` you wrote. Likely culprits: a field mismatch, an encoding quirk, or FOD/sign-in not actually on.

## Cleanup

```powershell
Remove-ItemProperty -Path "HKCU:\SOFTWARE\Policies\Microsoft\OneDrive\TenantAutoMount" -Name "SpikeTest" -ErrorAction SilentlyContinue
```
