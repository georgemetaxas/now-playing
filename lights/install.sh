#!/bin/bash
# Set up the Tapo light-sync agent on this Mac (e.g. the Hive MacBook Air).
# Creates a Python venv, installs deps, and installs + loads a launchd agent
# that starts on login and restarts itself. Re-runnable (idempotent).
#
#   cd lights && bash install.sh
#
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"        # this lights/ folder
VENV="$DIR/.venv"
PLIST="$HOME/Library/LaunchAgents/com.metaxas.nowplaying-lights.plist"
PY="$(command -v python3 || true)"

echo "▸ lights folder: $DIR"

if [ -z "$PY" ]; then
  echo "✗ python3 not found. Install Python 3.11 or 3.12 from https://www.python.org/downloads/macos/"
  echo "  then quit + reopen Terminal and run this again."
  exit 1
fi
PYVER="$("$PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])')"
echo "▸ python3: $PY (v$PYVER)"
"$PY" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3,11) else 1)' || {
  echo "✗ Python $PYVER is too old — the Tapo library needs Python 3.11+."
  echo "  Install Python 3.11 or 3.12 from https://www.python.org/downloads/macos/,"
  echo "  quit + reopen Terminal, then run this again."
  exit 1
}

echo "▸ creating venv + installing deps…"
[ -d "$VENV" ] || "$PY" -m venv "$VENV"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r "$DIR/requirements.txt"

if [ ! -f "$DIR/config.json" ]; then
  cp "$DIR/config.example.json" "$DIR/config.json"
  echo ""
  echo "‼ Created config.json — EDIT IT before the agent will work:"
  echo "    $DIR/config.json"
  echo "  Fill in tapo_email / tapo_password and the strip's IP + model,"
  echo "  then re-run:  bash install.sh"
  open -e "$DIR/config.json" 2>/dev/null || true
  exit 0
fi

echo "▸ writing launch agent → $PLIST"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.metaxas.nowplaying-lights</string>
  <key>ProgramArguments</key>
  <array>
    <string>$VENV/bin/python</string>
    <string>$DIR/tapo_sync.py</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DIR/tapo_sync.log</string>
  <key>StandardErrorPath</key><string>$DIR/tapo_sync.log</string>
</dict>
</plist>
PLISTEOF

echo "▸ (re)loading agent…"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 3
if launchctl list | grep -q nowplaying-lights; then
  echo "✓ running. Watch it with:  tail -f \"$DIR/tapo_sync.log\""
else
  echo "✗ agent didn't start — check $DIR/tapo_sync.log"
fi
