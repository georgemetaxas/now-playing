#!/bin/bash
# Now Playing — one-shot setup for the Hive Mac.
# Downloads the light-sync agent and installs it as a login service.
# Safe to re-run: it updates the code but keeps your existing config.json.
#
# To run: open Terminal and drag this file in, or:  bash bootstrap-hive.command
set -e

REPO="https://github.com/georgemetaxas/now-playing/archive/refs/heads/main.zip"
DEST="$HOME/now-playing"
CFG="$DEST/lights/config.json"

echo "▸ Downloading Now Playing light agent…"
TMP="$(mktemp -d)"
curl -fsSL "$REPO" -o "$TMP/np.zip"
unzip -q "$TMP/np.zip" -d "$TMP"

# preserve an existing config.json across updates
BACKUP=""
if [ -f "$CFG" ]; then BACKUP="$(mktemp)"; cp "$CFG" "$BACKUP"; fi

rm -rf "$DEST"
mv "$TMP/now-playing-main" "$DEST"
rm -rf "$TMP"
[ -n "$BACKUP" ] && cp "$BACKUP" "$DEST/lights/config.json"

echo "▸ Installing…"
cd "$DEST/lights"
bash install.sh

echo ""
echo "Done. If it asked you to edit config.json, fill it in and run this again."
