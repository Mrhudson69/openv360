#!/bin/sh
# openv360 agent installer for macOS and Linux.
#
#   curl -fsSL https://YOUR-SERVER/install.sh | sh -s -- --code ABCD-EFGH
#
# Downloads the agent, installs it, connects it to your openv360 server with the
# one-time enrollment code, and starts it. Run as your normal user (not root);
# on Linux it asks for sudo only to install the .deb package.
set -eu

SERVER_URL="__OPENV360_SERVER_URL__"
RELEASE_BASE="__OPENV360_RELEASE_BASE__"
CODE=""
APP_ID="org.openv360.agent"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --code)   CODE="${2:-}"; shift 2 ;;
    --server) SERVER_URL="${2:-}"; RELEASE_BASE="${SERVER_URL%/}/downloads"; shift 2 ;;
    --release-base) RELEASE_BASE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

case "$SERVER_URL" in
  __OPENV360*|"") die "no server address. Use: sh install.sh --server https://your-server --code ABCD-EFGH" ;;
esac
case "$RELEASE_BASE" in __OPENV360*) RELEASE_BASE="${SERVER_URL%/}/downloads" ;; esac
SERVER_URL="${SERVER_URL%/}"

if [ -n "$CODE" ]; then
  CODE=$(printf '%s' "$CODE" | tr '[:lower:]' '[:upper:]')
  printf '%s' "$CODE" | grep -Eq '^[A-Z0-9]{4}-?[A-Z0-9]{4}$' || die "enrollment code should look like ABCD-EFGH"
fi
printf '%s' "$SERVER_URL" | grep -Eq '^https?://[A-Za-z0-9.:_/-]+$' || die "invalid server address: $SERVER_URL"

if [ "$(id -u)" = "0" ]; then
  die "run this as your normal user, not root/sudo (the agent runs in your desktop session)"
fi

command -v curl >/dev/null 2>&1 || die "curl is required"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

download() { # url dest
  say "Downloading $(basename "$2")"
  curl -fL --retry 3 --progress-bar -o "$2" "$1" || die "download failed: $1"
}

write_enrollment() { # config dir
  [ -n "$CODE" ] || return 0
  mkdir -p "$1"
  umask 077
  printf '{"serverUrl":"%s","code":"%s"}\n' "$SERVER_URL" "$CODE" > "$1/enroll.json"
}

sudo_cmd() {
  if command -v sudo >/dev/null 2>&1; then sudo "$@"; else die "sudo is required to install packages"; fi
}

# Install the agent as a background service that restarts if killed and starts
# on boot/login. Prefers a systemd *user* service; falls back to an XDG
# autostart entry. With root available, also installs a guard timer so a
# non-admin user can't permanently stop it on a managed device.
install_linux_service() {
  BIN=$1
  UDIR="$HOME/.config/systemd/user"
  autostart_fallback() {
    mkdir -p "$HOME/.config/autostart"
    cat > "$HOME/.config/autostart/openv360.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=openv360
Exec=$BIN --autostart
X-GNOME-Autostart-enabled=true
DESKTOP
  }

  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    mkdir -p "$UDIR"
    cat > "$UDIR/openv360-agent.service" <<UNIT
[Unit]
Description=openv360 activity agent
After=graphical-session.target
PartOf=graphical-session.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=$BIN --autostart --service
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    systemctl --user enable --now openv360-agent.service >/dev/null 2>&1 \
      && say "Installed background service (auto-starts and restarts if stopped)" \
      || { warn "systemd user service could not start; using autostart instead"; autostart_fallback; }
    # Keep running even when no graphical session is active.
    loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
  else
    autostart_fallback
    if [ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]; then
      pkill -x openv360-agent >/dev/null 2>&1 || true
      nohup "$BIN" --autostart >/dev/null 2>&1 &
      say "Started openv360 (will auto-start at login)"
    else
      say "No desktop session detected; openv360 will start at your next login"
    fi
  fi

  install_linux_guard "$BIN"
}

# Root guard: a systemd timer that re-enables the per-user agent every minute.
install_linux_guard() {
  BIN=$1
  [ "${OPENV360_NO_GUARD:-0}" = 1 ] && return 0
  command -v systemctl >/dev/null 2>&1 || return 0
  command -v sudo >/dev/null 2>&1 || { warn "no sudo; skipping the root guard (service still restarts if killed)"; return 0; }
  # Only attempt if we can get root non-interactively, or we already have a tty.
  guard_dir=/usr/local/lib/openv360
  tmpd="$TMP/guard"; mkdir -p "$tmpd"
  cat > "$tmpd/openv360-guard.sh" <<'GUARD'
#!/bin/sh
set -u
UNIT=openv360-agent.service
getent passwd | while IFS=: read -r user _ uid _ _ home _; do
  [ "$uid" -ge 1000 ] 2>/dev/null || continue
  [ "$uid" -lt 65534 ] 2>/dev/null || continue
  [ -f "$home/.config/systemd/user/$UNIT" ] || continue
  loginctl enable-linger "$user" >/dev/null 2>&1 || true
  rt="/run/user/$uid"; [ -d "$rt" ] || continue
  runuser -u "$user" -- env "XDG_RUNTIME_DIR=$rt" systemctl --user enable --now "$UNIT" >/dev/null 2>&1 || true
done
GUARD
  cat > "$tmpd/openv360-guard.service" <<'UNIT'
[Unit]
Description=Keep the openv360 agent enabled for all users
[Service]
Type=oneshot
ExecStart=/usr/local/lib/openv360/openv360-guard.sh
UNIT
  cat > "$tmpd/openv360-guard.timer" <<'UNIT'
[Unit]
Description=Periodically re-assert the openv360 agent
[Timer]
OnBootSec=30
OnUnitActiveSec=60
AccuracySec=10
[Install]
WantedBy=timers.target
UNIT
  if sudo -n true >/dev/null 2>&1 || [ -t 0 ]; then
    say "Installing the managed-device guard (keeps the agent running for all users)"
    sudo sh -c "
      mkdir -p '$guard_dir' &&
      install -m 755 '$tmpd/openv360-guard.sh' '$guard_dir/openv360-guard.sh' &&
      install -m 644 '$tmpd/openv360-guard.service' /etc/systemd/system/openv360-guard.service &&
      install -m 644 '$tmpd/openv360-guard.timer' /etc/systemd/system/openv360-guard.timer &&
      systemctl daemon-reload &&
      systemctl enable --now openv360-guard.timer
    " >/dev/null 2>&1 && ok_guard=1 || ok_guard=0
    [ "$ok_guard" = 1 ] || warn "guard install skipped (needs root); the service still restarts if killed"
  else
    warn "Run the installer with sudo available to add the managed-device guard; the service still restarts if killed."
  fi
}

install_linux() {
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64|amd64) DEB_ARCH=amd64 ;;
    aarch64|arm64) DEB_ARCH=arm64 ;;
    *) die "unsupported CPU architecture: $ARCH" ;;
  esac

  if command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then
    PKG="$TMP/openv360-agent_${DEB_ARCH}.deb"
    download "$RELEASE_BASE/openv360-agent_${DEB_ARCH}.deb" "$PKG"
    say "Installing package (you may be asked for your password)"
    chmod 644 "$PKG"
    sudo_cmd apt-get install -y "$PKG" >/dev/null || die "package installation failed"
    BIN=/usr/bin/openv360-agent
  else
    [ "$DEB_ARCH" = amd64 ] || die "only x86_64 AppImage builds are published; use a Debian/Ubuntu system for arm64"
    mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
    BIN="$HOME/.local/bin/openv360-agent.AppImage"
    download "$RELEASE_BASE/openv360-agent_x86_64.AppImage" "$TMP/openv360.AppImage"
    install -m 755 "$TMP/openv360.AppImage" "$BIN"
    cat > "$HOME/.local/share/applications/openv360.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=openv360
Exec=$BIN
Icon=openv360-agent
Categories=Utility;
DESKTOP
    if ! ldconfig -p 2>/dev/null | grep -q libfuse.so.2; then
      warn "AppImages need FUSE 2 (e.g. 'sudo dnf install fuse-libs' or 'sudo pacman -S fuse2')"
    fi
  fi

  write_enrollment "${XDG_CONFIG_HOME:-$HOME/.config}/$APP_ID"
  install_linux_service "$BIN"

  case "${XDG_CURRENT_DESKTOP:-}" in
    *GNOME*|*gnome*)
      if [ "${XDG_SESSION_TYPE:-}" = wayland ]; then
        warn "One-time step: log out and back in so the openv360 GNOME helper loads (needed for silent screenshots and app names on Wayland)."
      fi ;;
  esac
}

install_macos() {
  PKG="$TMP/openv360.app.tar.gz"
  download "$RELEASE_BASE/openv360-agent_macos-universal.app.tar.gz" "$PKG"
  DEST=/Applications
  [ -w "$DEST" ] || DEST="$HOME/Applications"
  mkdir -p "$DEST"
  say "Installing to $DEST/openv360.app"
  osascript -e 'quit app "openv360"' >/dev/null 2>&1 || true
  rm -rf "$DEST/openv360.app"
  tar -xzf "$PKG" -C "$DEST"
  xattr -dr com.apple.quarantine "$DEST/openv360.app" 2>/dev/null || true
  write_enrollment "$HOME/Library/Application Support/$APP_ID"

  # Background service that starts at login and restarts if quit (KeepAlive).
  EXE="$DEST/openv360.app/Contents/MacOS/openv360-agent"
  PLIST="$HOME/Library/LaunchAgents/$APP_ID.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$APP_ID</string>
  <key>ProgramArguments</key><array><string>$EXE</string><string>--autostart</string><string>--service</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
PLIST
  uid=$(id -u)
  launchctl bootout "gui/$uid" "$PLIST" >/dev/null 2>&1 || true
  if launchctl bootstrap "gui/$uid" "$PLIST" >/dev/null 2>&1 || launchctl load "$PLIST" >/dev/null 2>&1; then
    say "Installed background service (starts at login, restarts if quit)"
  else
    open "$DEST/openv360.app"
  fi
  warn "On first launch openv360 asks for Screen Recording permission. Allow it in System Settings → Privacy & Security → Screen Recording; openv360 then runs in the menu bar."
}

case "$(uname -s)" in
  Linux)  install_linux ;;
  Darwin) install_macos ;;
  *) die "unsupported OS $(uname -s). On Windows use install.ps1." ;;
esac

if [ -n "$CODE" ]; then
  say "Done. openv360 is connecting to $SERVER_URL — look for its icon in the menu bar / system tray."
else
  say "Done. Open openv360 and enter your server address ($SERVER_URL) and enrollment code."
fi
