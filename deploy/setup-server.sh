#!/usr/bin/env bash
# openv360 server setup for Ubuntu 22.04 / 24.04 / 26.04 (and Debian 12+).
#
#   curl -fsSL https://raw.githubusercontent.com/OWNER/openv360/main/deploy/setup-server.sh | sudo bash
#
# Asks for: organisation name, domain (or IP), admin name/email/password.
# Everything else is automatic: Docker, PostgreSQL, the server + dashboard,
# HTTPS certificates (Caddy + Let's Encrypt), secrets, firewall rules, the
# first admin account, and a `openv360` management command.
#
# Non-interactive use (all optional; missing values are prompted for):
#   sudo ORG_NAME="Acme" DOMAIN=track.acme.com ADMIN_EMAIL=a@acme.com \
#        ADMIN_PASSWORD='...' ADMIN_NAME="Alex" bash setup-server.sh --yes
#
# Re-running is safe: it updates the code and keeps existing data and secrets.
set -euo pipefail

OPENV360_REPO="${OPENV360_REPO:-https://github.com/Mrhudson69/openv360.git}"
OPENV360_BRANCH="${OPENV360_BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/openv360}"
ASSUME_YES=0
CADDY=1   # --no-caddy / --proxy: run behind your own reverse proxy (nginx, Traefik, …) instead of the bundled Caddy
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --no-caddy|--proxy|--behind-proxy) CADDY=0 ;;
  esac
done

c_info=$'\033[1;36m'; c_warn=$'\033[1;33m'; c_err=$'\033[1;31m'; c_ok=$'\033[1;32m'; c_off=$'\033[0m'
say()  { echo "${c_info}==>${c_off} $*"; }
ok()   { echo "${c_ok}✔${c_off} $*"; }
warn() { echo "${c_warn}warning:${c_off} $*" >&2; }
die()  { echo "${c_err}error:${c_off} $*" >&2; exit 1; }

# When piped through `curl | bash`, stdin is the script — read answers from the terminal.
if [[ -t 0 ]]; then TTY=/dev/stdin; elif [[ -r /dev/tty ]]; then TTY=/dev/tty; else TTY=""; fi

# Quote a value for a Docker Compose .env file (double quotes; escape \ " and $).
env_quote() {
  local v=$1
  v=${v//\\/\\\\}; v=${v//\"/\\\"}; v=${v//\$/\$\$}
  printf '"%s"' "$v"
}
# Read a simple (unquoted) KEY=value from an existing .env without sourcing it.
env_get() { grep -E "^$1=" "$EXISTING_ENV" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

ask() { # var prompt default
  local var=$1 prompt=$2 def=${3:-} ans
  if [[ -n "${!var:-}" ]]; then return; fi
  [[ -n "$TTY" ]] || die "$var is required (no terminal to ask on)"
  if [[ -n "$def" ]]; then prompt="$prompt [$def]"; fi
  read -r -p "$prompt: " ans < "$TTY" || true
  printf -v "$var" '%s' "${ans:-$def}"
}

ask_password() {
  if [[ -n "${ADMIN_PASSWORD:-}" ]]; then
    (( ${#ADMIN_PASSWORD} >= 8 )) || die "ADMIN_PASSWORD must be at least 8 characters"
    return
  fi
  [[ -n "$TTY" ]] || die "ADMIN_PASSWORD is required (no terminal to ask on)"
  local p1 p2
  while true; do
    read -r -s -p "Admin password (min 8 chars): " p1 < "$TTY"; echo
    read -r -s -p "Repeat password: " p2 < "$TTY"; echo
    if (( ${#p1} < 8 )); then warn "too short"; continue; fi
    if [[ "$p1" != "$p2" ]]; then warn "passwords don't match"; continue; fi
    ADMIN_PASSWORD=$p1; break
  done
}

# ---------------------------------------------------------------- checks
[[ $EUID -eq 0 ]] || die "run as root: curl -fsSL <url> | sudo bash"
[[ -r /etc/os-release ]] && . /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) warn "untested distribution '${ID:-unknown}'; continuing (needs apt-get)";;
esac
command -v apt-get >/dev/null || die "this script needs an apt-based system (Ubuntu/Debian)"

mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
(( mem_mb >= 900 )) || warn "only ${mem_mb} MB RAM; 1 GB+ recommended"

public_ip() {
  curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null \
    || curl -fsS4 --max-time 5 https://ifconfig.me 2>/dev/null \
    || hostname -I 2>/dev/null | awk '{print $1}'
}

# ---------------------------------------------------------------- questions
echo
echo "  ${c_info}openv360 server setup${c_off}"
echo "  Answer a few questions; everything else is configured automatically."
echo

EXISTING_ENV="$INSTALL_DIR/.env"
if [[ -f "$EXISTING_ENV" ]]; then
  say "Existing installation found in $INSTALL_DIR — updating it (data and secrets are kept)."
  SITE_ADDRESS=$(env_get SITE_ADDRESS); PUBLIC_URL=$(env_get PUBLIC_URL); ADMIN_EMAIL=$(env_get ADMIN_EMAIL)
  UPDATE_ONLY=1
else
  UPDATE_ONLY=0
fi

if (( ! UPDATE_ONLY )); then
  ask ORG_NAME "Organisation name" ""
  [[ -n "$ORG_NAME" ]] || die "organisation name is required"
  DETECTED_IP=$(public_ip || true)
  if (( CADDY )); then
    echo "  Use a domain (e.g. track.yourcompany.com) whose DNS A record points at this"
    echo "  server for automatic HTTPS, or press Enter to use the IP ${DETECTED_IP:-?} over plain HTTP."
    ask DOMAIN "Domain" ""
  else
    echo "  Running behind your existing reverse proxy — it handles TLS and ports 80/443."
    echo "  openv360 will listen on 127.0.0.1:8080 for the proxy to forward to."
    echo "  Enter the public domain your proxy serves (e.g. track.yourcompany.com)."
    ask DOMAIN "Public domain" ""
  fi
  ask ADMIN_NAME "Admin full name" "Admin"
  ask ADMIN_EMAIL "Admin email" ""
  [[ "$ADMIN_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "invalid email: $ADMIN_EMAIL"
  ask_password

  DOMAIN=${DOMAIN,,}; DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN%%/*}
  if (( ! CADDY )); then
    [[ -n "$DOMAIN" ]] || die "a public domain is required when running behind a proxy (--no-caddy)"
    [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || die "invalid domain: $DOMAIN"
    SITE_ADDRESS=""; PUBLIC_URL="https://$DOMAIN"
  elif [[ -z "$DOMAIN" ]]; then
    [[ -n "${DETECTED_IP:-}" ]] || die "could not detect this server's IP; please enter a domain"
    SITE_ADDRESS=":80"; PUBLIC_URL="http://$DETECTED_IP"
    warn "Using plain HTTP. Traffic (including screenshots) is unencrypted — use a domain for production."
  else
    [[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || die "invalid domain: $DOMAIN"
    SITE_ADDRESS="$DOMAIN"; PUBLIC_URL="https://$DOMAIN"
  fi

  echo
  echo "  Organisation : $ORG_NAME"
  echo "  URL          : $PUBLIC_URL"
  echo "  Admin        : $ADMIN_NAME <$ADMIN_EMAIL>"
  echo "  Install dir  : $INSTALL_DIR"
  if (( ! ASSUME_YES )) && [[ -n "$TTY" ]]; then
    read -r -p "Continue? [Y/n] " yn < "$TTY"; [[ "${yn,,}" =~ ^(n|no)$ ]] && die "aborted"
  fi
fi

# ---------------------------------------------------------------- packages
say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl dnsutils >/dev/null

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  say "Installing Docker"
  if ! apt-get install -y -qq docker.io docker-compose-v2 >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh >/dev/null
  fi
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || die "docker compose is not available"
ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"

# ---------------------------------------------------------------- code
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/../docker-compose.yml" && -d "$SCRIPT_DIR/../server" ]]; then
  SRC=$(cd "$SCRIPT_DIR/.." && pwd)
  if [[ "$SRC" != "$INSTALL_DIR" ]]; then
    say "Copying code from $SRC"
    mkdir -p "$INSTALL_DIR"
    tar -C "$SRC" --exclude=node_modules --exclude=target --exclude=.git --exclude=.env -cf - . \
      | tar -C "$INSTALL_DIR" -xf -
  fi
elif [[ -d "$INSTALL_DIR/.git" ]]; then
  say "Updating code"
  git -C "$INSTALL_DIR" fetch -q origin "$OPENV360_BRANCH"
  git -C "$INSTALL_DIR" reset -q --hard "origin/$OPENV360_BRANCH"
else
  [[ "$OPENV360_REPO" != *CHANGE-ME* ]] || die "set OPENV360_REPO to your openv360 git repository URL"
  say "Downloading openv360 from $OPENV360_REPO"
  mkdir -p "$INSTALL_DIR"
  git clone -q --depth 1 -b "$OPENV360_BRANCH" "$OPENV360_REPO" "$INSTALL_DIR.tmp"
  cp -a "$INSTALL_DIR.tmp/." "$INSTALL_DIR/"; rm -rf "$INSTALL_DIR.tmp"
fi
cd "$INSTALL_DIR"

# ---------------------------------------------------------------- config
if (( ! UPDATE_ONLY )); then
  say "Writing configuration"
  POSTGRES_PASSWORD=$(openssl rand -hex 24)
  repo_web=${OPENV360_REPO%.git}
  if [[ "$repo_web" == https://github.com/* && "$repo_web" != *CHANGE-ME* ]]; then
    GITHUB_RELEASES_URL="${GITHUB_RELEASES_URL:-$repo_web/releases/latest/download}"
  fi
  if (( CADDY )); then
    compose_files="docker-compose.yml:deploy/docker-compose.caddy.yml"
  else
    # Behind an existing reverse proxy: no Caddy. The server is published on
    # 127.0.0.1:8080; point your proxy at it (see docs/deployment/reverse-proxy.md).
    compose_files="docker-compose.yml"
  fi
  umask 077
  cat > .env <<ENV
# Generated by deploy/setup-server.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Keep this file secret.
COMPOSE_FILE=$compose_files
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
PUBLIC_URL=$PUBLIC_URL
SITE_ADDRESS=$SITE_ADDRESS
SERVER_BIND=127.0.0.1
ORG_NAME=$(env_quote "$ORG_NAME")
ADMIN_NAME=$(env_quote "$ADMIN_NAME")
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD=$(env_quote "$ADMIN_PASSWORD")
GITHUB_RELEASES_URL=${GITHUB_RELEASES_URL:-}
ENV
  umask 022
fi

# ---------------------------------------------------------------- network checks (Caddy mode only)
if (( CADDY )); then
  if [[ "${SITE_ADDRESS:-:80}" != ":80" ]]; then
    ip=$(public_ip || true)
    resolved=$(dig +short A "$SITE_ADDRESS" @1.1.1.1 2>/dev/null | tail -1 || true)
    if [[ -n "$ip" && "$resolved" != "$ip" ]]; then
      warn "DNS for $SITE_ADDRESS points to '${resolved:-nothing}', but this server is $ip."
      warn "HTTPS certificates will be issued automatically once DNS is correct."
    fi
  fi
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    say "Opening ports 80 and 443 in ufw"
    ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
  fi
  for port in 80 443; do
    if ss -ltnH "sport = :$port" 2>/dev/null | grep -q . && ! docker compose ps caddy 2>/dev/null | grep -q Up; then
      warn "port $port is already in use by another program (e.g. nginx/apache); stop it first"
    fi
  done
fi

# ---------------------------------------------------------------- start
say "Building and starting openv360 (first run takes a few minutes)"
docker compose up -d --build --remove-orphans

say "Waiting for the server to become healthy"
for i in $(seq 1 90); do
  if curl -fsS http://127.0.0.1:8080/api/health >/dev/null 2>&1; then break; fi
  (( i == 90 )) && { docker compose logs --tail 50 server; die "server did not start; logs above"; }
  sleep 2
done
ok "Server is running"

# The admin now exists in the database; don't keep the password on disk.
if grep -q '^ADMIN_PASSWORD=' .env; then
  sed -i '/^ADMIN_PASSWORD=/d' .env
fi

# ---------------------------------------------------------------- management command
cat > /usr/local/bin/openv360 <<CTL
#!/usr/bin/env bash
# Manage the openv360 server installed in $INSTALL_DIR.
set -euo pipefail
cd "$INSTALL_DIR"
case "\${1:-help}" in
  status)  docker compose ps ;;
  logs)    docker compose logs -f --tail 200 "\${2:-server}" ;;
  restart) docker compose restart ;;
  stop)    docker compose stop ;;
  start)   docker compose up -d ;;
  update)
    if [[ -d .git ]]; then git pull -q --ff-only; fi
    docker compose up -d --build --remove-orphans
    docker image prune -f >/dev/null ;;
  backup)
    out="\${2:-$INSTALL_DIR/backups}"; mkdir -p "\$out"
    ts=\$(date +%Y%m%d-%H%M%S)
    docker compose exec -T db pg_dump -U openv360 -d openv360 | gzip > "\$out/db-\$ts.sql.gz"
    docker compose exec -T server tar -C /data -czf - . > "\$out/files-\$ts.tar.gz"
    echo "Backup written to \$out (db-\$ts.sql.gz, files-\$ts.tar.gz)" ;;
  *) echo "usage: openv360 {status|logs [service]|restart|stop|start|update|backup [dir]}" ;;
esac
CTL
chmod 755 /usr/local/bin/openv360

# ---------------------------------------------------------------- done
if (( CADDY )) && [[ "${SITE_ADDRESS:-:80}" != ":80" ]]; then
  for i in $(seq 1 30); do
    curl -fsS "https://$SITE_ADDRESS/api/health" >/dev/null 2>&1 && { ok "HTTPS certificate is active"; break; }
    (( i == 30 )) && warn "HTTPS isn't reachable yet — check DNS and that ports 80/443 are open, then run: openv360 logs caddy"
    sleep 2
  done
fi

cat <<DONE

${c_ok}openv360 is ready.${c_off}

  Dashboard : $PUBLIC_URL
  Log in as : ${ADMIN_EMAIL:-your admin email}
DONE

if (( ! CADDY )); then
  cat <<DONE

  ${c_warn}Running behind your own reverse proxy.${c_off} openv360 listens on 127.0.0.1:8080.
  Point your proxy at it, for example (nginx):

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              \$host;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host  \$host;
        client_max_body_size 25m;   # screenshots upload up to ~10 MB
    }

  Full guide (incl. shared-network setup, Traefik, sample files):
    $INSTALL_DIR/docs/deployment/reverse-proxy.md
DONE
fi

cat <<DONE

  Next: open the dashboard → Team → Add employee. It shows a one-line
  install command for each employee's computer, e.g.

    macOS / Linux : curl -fsSL $PUBLIC_URL/install.sh | sh -s -- --code ABCD-EFGH
    Windows       : & ([scriptblock]::Create((irm $PUBLIC_URL/install.ps1))) -Code ABCD-EFGH

  Manage the server with:  openv360 status | logs | update | backup | restart
  Configuration:           $INSTALL_DIR/.env
DONE
