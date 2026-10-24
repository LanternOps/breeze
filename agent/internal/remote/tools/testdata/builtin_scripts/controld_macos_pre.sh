#!/bin/bash
set -euo pipefail
DOMAIN='/Library/Managed Preferences/com.controld.ctrld'
[ -f /Library/LaunchDaemons/ctrld.plist ] && exit 0            # upgrade path keeps identity
if [ -e "$DOMAIN.plist" ] && [ "$(/usr/bin/defaults read "$DOMAIN" BreezeWritten 2>/dev/null)" != "1" ]; then
  exit 0                                                         # MDM-delivered: never overwrite
fi
mkdir -p '/Library/Managed Preferences'
/usr/bin/defaults write "$DOMAIN" ProvisionToken {{var.controld_provisioning_code}}
/usr/bin/defaults write "$DOMAIN" BreezeWritten -bool true
chmod u=rw,go= "$DOMAIN.plist"
