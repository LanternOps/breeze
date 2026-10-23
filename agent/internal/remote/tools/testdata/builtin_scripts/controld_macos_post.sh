#!/bin/bash
set -uo pipefail
DOMAIN='/Library/Managed Preferences/com.controld.ctrld'
if [ "$(/usr/bin/defaults read "$DOMAIN" BreezeWritten 2>/dev/null)" = "1" ]; then rm -f "$DOMAIN.plist"; fi
exit 0
