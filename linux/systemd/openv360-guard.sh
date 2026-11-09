#!/bin/sh
# openv360 guard (runs as root via openv360-guard.timer on managed devices).
#
# Re-asserts the per-user openv360 agent for every interactive user, so a
# non-administrator cannot permanently disable tracking on a device their
# employer manages. It does NOT hide anything: the agent stays visible in the
# user's tray/menu bar. Removing this guard needs root (uninstall.sh --system).
set -u
UNIT=openv360-agent.service

getent passwd | while IFS=: read -r user _ uid _ _ home _; do
  [ "$uid" -ge 1000 ] 2>/dev/null || continue
  [ "$uid" -lt 65534 ] 2>/dev/null || continue
  [ -d "$home" ] || continue
  [ -f "$home/.config/systemd/user/$UNIT" ] || continue

  # Allow the user service to run even when nobody is logged in.
  loginctl enable-linger "$user" >/dev/null 2>&1 || true
  rt="/run/user/$uid"
  [ -d "$rt" ] || continue
  runuser -u "$user" -- env "XDG_RUNTIME_DIR=$rt" \
    systemctl --user enable --now "$UNIT" >/dev/null 2>&1 || true
done
