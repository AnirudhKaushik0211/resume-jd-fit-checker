#!/bin/bash
# ==========================================================================
#  JD Fit Checker - Linux launcher. Double-click this file ("Run" / "Run as a Program") to start the tool,
#  or run: bash start.sh
#  It runs the local server in THIS terminal window and opens your browser when it is ready.
#  Close this window (or press Ctrl+C) to stop the tool.
#  Test switches (not needed for normal use): JDFC_LAUNCHER_TEST=1 = no pause at the end,
#  JDFC_NO_BROWSER=1 = do not open the browser. PORT=<number> = preferred port (default 4317).
# ==========================================================================

cd "$(dirname "$0")" || exit 1
# Terminal windows opened by a double-click do not always read your shell profile: add the usual Node.js locations.
PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"
export PATH

hold() {
  if [ "${JDFC_LAUNCHER_TEST:-}" != "1" ]; then
    printf '\nPress Enter to close this window.'
    read -r _
  fi
}

open_url() {
  [ "${JDFC_NO_BROWSER:-}" = "1" ] && return 0
  if [ "$(uname -s)" = "Darwin" ]; then open "$1" >/dev/null 2>&1; else xdg-open "$1" >/dev/null 2>&1; fi
}

printf '\033]0;JD Fit Checker\007'
echo
echo " =================================================="
echo "   JD Fit Checker"
echo "   Runs only on this computer. Nothing is uploaded."
echo " =================================================="
echo

if [ ! -f server.cjs ] || [ ! -f lib/profiles.cjs ]; then
  echo "This file cannot find the rest of the tool (server.cjs) next to it."
  echo
  echo "Please extract (unzip) the folder first, then double-click this file inside the extracted folder."
  echo "  1. Right-click the downloaded .zip file and choose Extract Here."
  echo "  2. Open the extracted folder and double-click this launcher there."
  hold
  exit 3
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed (or this computer cannot find it yet)."
  echo "JD Fit Checker needs Node.js version 22 or newer. It is free and installs once."
  echo
  echo "  1. The Node.js download page opens in your browser now."
  echo "     Download the \"LTS\" installer for your system and run it with the default options."
  echo "  2. Then close this window and start JD Fit Checker again."
  open_url "https://nodejs.org/en/download"
  hold
  exit 2
fi

major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
case "$major" in
  ''|*[!0-9]*) major=0 ;;
esac
if [ "$major" -lt 22 ]; then
  echo "Your Node.js is too old (version $major). JD Fit Checker needs version 22 or newer."
  echo
  echo "  1. The Node.js download page opens in your browser now."
  echo "     Download the \"LTS\" installer and run it; it replaces the old version."
  echo "  2. Then close this window and start JD Fit Checker again."
  open_url "https://nodejs.org/en/download"
  hold
  exit 4
fi

echo "Starting JD Fit Checker. Your browser opens by itself in a few seconds."
echo
JDFC_LAUNCHER=1 node server.cjs
code=$?
echo
if [ "$code" -ne 0 ]; then
  echo "JD Fit Checker stopped with an error (code $code)."
  echo "Read the messages above. The README section \"Troubleshooting\" explains the usual fixes."
  hold
  exit "$code"
fi
echo "JD Fit Checker has stopped. You can close this window."
exit 0
