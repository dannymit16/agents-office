#!/bin/bash
# La Réverie agents — Mac setup: GitHub runner + dedicated Chrome profile for the operator agent.
set -e
B=$'\e[1m'; G=$'\e[32m'; N=$'\e[0m'
DIR="$HOME/LaReverieAgents"; RUN="$DIR/runner"; PROFILE="$DIR/chrome-profile"
mkdir -p "$RUN" "$PROFILE"
echo "${B}1/4 Checking Google Chrome and Python...${N}"
[ -d "/Applications/Google Chrome.app" ] || { echo "Google Chrome is not installed. Install it and run again."; exit 1; }
command -v python3 >/dev/null || { echo "Installing Apple developer tools (python3) — approve the popup, then run this again."; xcode-select --install; exit 1; }

echo "${B}2/4 Installing the GitHub runner...${N}"
cd "$RUN"
if [ ! -f ./config.sh ]; then
  ARCH=$(uname -m); [ "$ARCH" = "arm64" ] && A=osx-arm64 || A=osx-x64
  V=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | sed -n 's/.*"tag_name": "v\([^"]*\)".*/\1/p')
  curl -fsSL -o r.tgz "https://github.com/actions/runner/releases/download/v$V/actions-runner-$A-$V.tar.gz"
  tar xzf r.tgz && rm r.tgz
fi
if [ ! -f .runner ]; then
  echo
  echo "${B}Paste the token from the GitHub page (the long code after --token) and press Enter:${N}"
  read -r TOKEN </dev/tty
  ./config.sh --unattended --url https://github.com/dannymit16/dropship-agents --token "$TOKEN" \
    --name "danny-mac" --labels lareverie-chrome --work _work --replace
fi
./svc.sh install >/dev/null 2>&1 || true
./svc.sh start

echo "${B}3/4 Preparing Python + browser automation...${N}"
[ -x "$DIR/venv/bin/python" ] || python3 -m venv "$DIR/venv"
"$DIR/venv/bin/pip" install -q --upgrade pip playwright anthropic pyyaml requests pillow

echo "${B}4/4 Opening the AGENTS' Chrome (separate profile)...${N}"
open -na "Google Chrome" --args --user-data-dir="$PROFILE" --no-first-run \
  "https://www.dsers.com/" "https://www.aliexpress.us/" "https://admin.shopify.com/store/nwrd2b-z1"
echo
echo "${G}${B}Done!${N} In the Chrome window that just opened, log in ONLY to:"
echo "  • DSers   • AliExpress   • Shopify (La Réverie USA store)"
echo "Do NOT log in to email, bank, or the Israeli store there. Then close that Chrome window."
echo "Keep the Mac on (and logged in) during the day — the operator works through it."
