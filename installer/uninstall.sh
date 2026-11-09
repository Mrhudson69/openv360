#!/bin/sh
# openv360 agent uninstaller for macOS and Linux.
#
#   curl -fsSL https://YOUR-SERVER/uninstall.sh | sh
#   curl -fsSL https://YOUR-SERVER/uninstall.sh | sudo sh -s -- --system   # also remove root guard
#
# Removes the agent, its background service/autostart, the GNOME helper, and all
# local data for the current user. Pass --system (as root) to also remove the
# managed-device guard installed system-wide.
set -eu

APP_ID="org.openv360.agent"
SYSTEM=0
[ "${1:-}" = "--system" ] && SYSTEM=1

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

stop_procs() { pkill -x openv360-agent >/dev/null 2>&1 || true; }

uninstall_linux() {
  say "Removing openv360 for $(id -un)"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now openv360-agent.service >/dev/null 2>&1 || true
  fi
  rm -f "$HOME/.config/systemd/user/openv360-agent.service"
  rm -f "$HOME/.config/autostart/openv360.desktop"
  rm -f "$HOME/.local/share/applications/openv360.desktop"
  rm -f "$HOME/.local/bin/openv360-agent.AppImage"
  command -v gnome-extensions >/dev/null 2>&1 && gnome-extensions disable openv360@openv360.org >/dev/null 2>&1 || true
  rm -rf "$HOME/.local/share/gnome-shell/extensions/openv360@openv360.org"
  rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/$APP_ID"
  rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/$APP_ID"
  stop_procs

  if [ "$SYSTEM" = 1 ]; then
    if [ "$(id -u)" != 0 ]; then say "Re-run with sudo for --system"; exit 1; fi
    say "Removing the managed-device guard and system package"
    systemctl disable --now openv360-guard.timer >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/openv360-guard.service /etc/systemd/system/openv360-guard.timer
    rm -rf /usr/local/lib/openv360
    systemctl daemon-reload >/dev/null 2>&1 || true
    if command -v apt-get >/dev/null 2>&1 && dpkg -s openv360-agent >/dev/null 2>&1; then
      apt-get remove -y openv360-agent >/dev/null 2>&1 || true
    fi
  elif [ -e /etc/systemd/system/openv360-guard.timer ] || dpkg -s openv360-agent >/dev/null 2>&1; then
    say "Note: a system-wide guard/package is present. Finish removal with: curl -fsSL \"$0\" | sudo sh -s -- --system"
  fi
  say "Done."
}

uninstall_macos() {
  say "Removing openv360 for $(id -un)"
  PLIST="$HOME/Library/LaunchAgents/$APP_ID.plist"
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  osascript -e 'quit app "openv360"' >/dev/null 2>&1 || true
  stop_procs
  rm -rf "/Applications/openv360.app" "$HOME/Applications/openv360.app"
  rm -rf "$HOME/Library/Application Support/$APP_ID"
  say "Done. You can remove openv360 from System Settings → Privacy & Security → Screen Recording."
}

case "$(uname -s)" in
  Linux)  uninstall_linux ;;
  Darwin) uninstall_macos ;;
  *) echo "unsupported OS $(uname -s). On Windows use uninstall.ps1." >&2; exit 1 ;;
esac
