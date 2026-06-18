#!/bin/sh
set -e
SRC="$(cd "$(dirname "$0")" && pwd)/AutoAckMention.plugin.js"
DST="$HOME/Library/Application Support/BetterDiscord/plugins"
mkdir -p "$DST"
DST_FILE="$DST/AutoAckMention.plugin.js"

# Back up an existing entry, unless it's already our symlink (re-run is a no-op)
if { [ -e "$DST_FILE" ] || [ -L "$DST_FILE" ]; } && [ "$(readlink "$DST_FILE")" != "$SRC" ]; then
  mv "$DST_FILE" "$DST_FILE.bak"
  echo "backed up: $DST_FILE -> $DST_FILE.bak"
fi

ln -sf "$SRC" "$DST/"
echo "linked: $DST_FILE -> $SRC"
