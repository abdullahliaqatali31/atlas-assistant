#!/bin/sh
# Installs Atlas with one command, on a Mac or on Linux:
#
#   curl -fsSL https://github.com/abdullahliaqatali31/atlas-assistant/releases/latest/download/install.sh | sh
#
# Mac: installs Node.js 22.13+ (with Homebrew) if needed, the npm package
# atlas-ai-assistant (the `atlas` command), and starts Atlas in your browser.
#
# Linux server (a VPS, a home server, beside Dokploy too; no desktop): installs Node.js 22 (from
# NodeSource on Debian/Ubuntu) if needed, the npm package, and a systemd
# service that keeps Atlas's brain running (it starts again after a reboot
# or a crash). It may use ports 80 and 443 for your domain's HTTPS. At the
# end it prints the address and a code to pair your browser.
#
# Options (after `sh -s --`):
#   --server                 Linux: run Atlas as a server (the default on Linux)
#   --domain <name>          optional: a domain to start with (usually set later in the page,
#                            Settings › Security › Address & HTTPS)
#   --connect <address> <code>
#                            make this machine Atlas's hands for a brain elsewhere
#                            (the code from Settings › Machines) instead of a server
set -eu

say() { printf '  \033[36m%s\033[0m\n' "$1"; }
ok() { printf '\n  \033[32m%s\033[0m\n' "$1"; }
fail() { printf '  \033[31m%s\033[0m\n' "$1" >&2; exit 1; }

OS="$(uname -s)"
ROLE=server
ADDRESS=""
CODE=""
DOMAIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --server) ROLE=server ;;
    --domain) DOMAIN="${2:-}"; shift ;;
    --connect) ROLE=hands; ADDRESS="${2:-}"; CODE="${3:-}"; shift 2 || true ;;
    *) fail "Unknown option: $1" ;;
  esac
  shift
done
[ "$OS" = "Darwin" ] && [ "$ROLE" = server ] && ROLE=desktop
[ "$OS" = "Darwin" ] || [ "$OS" = "Linux" ] || fail "This installer is for macOS and Linux. On Windows use install.ps1 (see the README)."

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 && SUDO="sudo"
fi

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'
}

if ! node_ok; then
  if [ "$OS" = "Darwin" ]; then
    command -v brew >/dev/null 2>&1 || fail "Atlas needs Node.js 22.13 or newer. Install it from https://nodejs.org (or install Homebrew, https://brew.sh), then run this again."
    say "Installing Node.js with Homebrew..."
    brew install node
  elif command -v apt-get >/dev/null 2>&1; then
    say "Installing Node.js 22 (NodeSource)..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E sh -
    $SUDO apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    say "Installing Node.js 22 (NodeSource)..."
    curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO sh -
    $SUDO dnf install -y nodejs
  else
    fail "Atlas needs Node.js 22.13 or newer. Install it from https://nodejs.org, then run this again."
  fi
  node_ok || fail "Node.js did not install. Install it from https://nodejs.org and run this again."
fi
say "Node.js $(node --version)"

# From npm, or the latest release's package file when npm does not have it (yet),
# or ATLAS_PKG: a package file copied here (ATLAS_PKG=./atlas-ai-assistant.tgz sh install.sh).
PKG="${ATLAS_PKG:-atlas-ai-assistant}"
[ -n "${ATLAS_PKG:-}" ] || npm view atlas-ai-assistant version >/dev/null 2>&1 || PKG="https://github.com/abdullahliaqatali31/atlas-assistant/releases/latest/download/atlas-ai-assistant.tgz"
say "Installing Atlas..."
if ! npm install -g "$PKG" >/dev/null 2>&1; then
  say "npm needs permission for its global folder; using sudo..."
  $SUDO npm install -g "$PKG"
fi
ROOT="$(npm root -g)/atlas-ai-assistant"
[ -f "$ROOT/out/gateway/index.js" ] || fail "Atlas did not install (missing $ROOT)."

case "$ROLE" in
  desktop)
    say "Starting Atlas..."
    atlas start || fail "Atlas did not start. Run: atlas logs"
    ok "Atlas is installed.  atlas | atlas open | atlas stop | atlas status | atlas update"
    ;;

  hands)
    [ -n "$ADDRESS" ] && [ -n "$CODE" ] || fail "Usage: sh -s -- --connect <address> <code>   (both from Settings › Machines › Add a machine)"
    atlas connect "$ADDRESS" "$CODE"
    ok "This machine is now Atlas's hands. atlas disconnect stops it; atlas connect resumes."
    ;;

  server)
    command -v systemctl >/dev/null 2>&1 || fail "No systemd here. Run Atlas with: atlas server   (or use Docker: see docs/SERVER.md)"
    USER_NAME="$(id -un)"
    HOME_DIR="$HOME"
    NODE_BIN="$(readlink -f "$(command -v node)")"
    UNIT=/etc/systemd/system/atlas.service

    # Something else already serves ports 80 and 443 (Dokploy's Traefik, Nginx, Caddy): Atlas stays on 47800
    # and the domain goes through that web server. Otherwise Atlas does its own HTTPS.
    port_busy() { (ss -ltnH 2>/dev/null || netstat -ltn 2>/dev/null) | awk '{print $4}' | grep -Eq "[:.]$1$"; }
    DOKPLOY=""
    [ -d /etc/dokploy/traefik/dynamic ] && DOKPLOY=1
    PROXY=""
    if [ -n "$DOKPLOY" ] || port_busy 80 || port_busy 443; then PROXY=1; fi
    if [ -n "$DOKPLOY" ]; then say "Dokploy is here: Atlas runs beside it (its own service, port 47800); your apps are not touched."; fi

    # /etc/atlas.env (only root and the service read it): the key that seals API keys, kept apart from the
    # data, and the domain for the first start.
    if ! $SUDO test -f /etc/atlas.env; then
      KEY="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
      printf 'ATLAS_SECRET_KEY=%s\n' "$KEY" | $SUDO tee /etc/atlas.env >/dev/null
      $SUDO chmod 600 /etc/atlas.env
    fi
    if [ -n "$DOMAIN" ]; then
      $SUDO sed -i '/^ATLAS_DOMAIN=/d;/^ATLAS_HTTPS=/d' /etc/atlas.env
      printf 'ATLAS_DOMAIN=%s\nATLAS_HTTPS=%s\n' "$DOMAIN" "$([ -n "$PROXY" ] && echo proxy || echo acme)" | $SUDO tee -a /etc/atlas.env >/dev/null
    fi

    say "Setting up the atlas service (runs as $USER_NAME, data in $HOME_DIR/.local/share/atlas)..."
    $SUDO tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=Atlas personal assistant (server)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
Environment=HOME=$HOME_DIR
Environment=ATLAS_ROOT=$ROOT
Environment=ATLAS_ROLE=server
# Keys are sealed in a file on a server; set ATLAS_SECRET_KEY here (or in /etc/atlas.env) to keep the sealing key apart from the data.
EnvironmentFile=-/etc/atlas.env
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning $ROOT/out/gateway/index.js --server
Restart=always
RestartSec=3
# Ports 80 and 443 for the domain's HTTPS (Settings › Security › Address & HTTPS), without running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable --now atlas >/dev/null 2>&1 || $SUDO systemctl restart atlas
    say "Waiting for Atlas..."
    i=0
    until atlas status 2>/dev/null | grep -q "is running"; do
      i=$((i + 1))
      [ $i -gt 60 ] && fail "Atlas did not start. See: journalctl -u atlas -n 50"
      sleep 1
    done
    IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"

    # The page must be reachable at first, by IP: a firewall that is on gets port 47800 opened.
    if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
      $SUDO ufw allow 47800/tcp >/dev/null && say "Opened port 47800 in the firewall (ufw)."
    fi

    if [ -n "$DOKPLOY" ]; then
      # Dokploy's Traefik will serve the domain once it is set in the page (Settings › Address & HTTPS):
      # Atlas then writes its own route file. Prepared now, while this has root: that one file, owned by
      # the service's user (nothing else in Dokploy's folders), the address Traefik's container reaches
      # Atlas at (checked, not guessed), and the name of Dokploy's Let's Encrypt resolver.
      TRAEFIK="$($SUDO docker ps --format '{{.Names}}' 2>/dev/null | grep -m1 traefik || true)"
      RESOLVER="$($SUDO awk '/certificatesResolvers:/{f=1;next} f&&/^  [A-Za-z0-9_-]+:/{gsub(/[: ]/,"");print;exit}' /etc/dokploy/traefik/traefik.yml 2>/dev/null || true)"
      UPSTREAM=""
      if [ -n "$TRAEFIK" ]; then
        for ip in $($SUDO docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}' "$TRAEFIK" 2>/dev/null) 172.17.0.1 $(hostname -I 2>/dev/null); do
          [ -n "$ip" ] || continue
          if $SUDO docker exec "$TRAEFIK" wget -q -T 3 -O /dev/null "http://$ip:47800/api/me" 2>/dev/null; then UPSTREAM="$ip"; break; fi
        done
      fi
      if [ -n "$UPSTREAM" ]; then
        ROUTE=/etc/dokploy/traefik/dynamic/atlas.yml
        $SUDO test -f "$ROUTE" || printf '# Atlas: written by Atlas itself (Settings › Security › Address & HTTPS).\n# No domain set yet.\n' | $SUDO tee "$ROUTE" >/dev/null
        $SUDO chown "$USER_NAME" "$ROUTE"
        $SUDO sed -i '/^ATLAS_TRAEFIK_/d' /etc/atlas.env
        printf 'ATLAS_TRAEFIK_FILE=%s\nATLAS_TRAEFIK_UPSTREAM=http://%s:47800\nATLAS_TRAEFIK_RESOLVER=%s\n' "$ROUTE" "$UPSTREAM" "${RESOLVER:-letsencrypt}" | $SUDO tee -a /etc/atlas.env >/dev/null
        $SUDO systemctl restart atlas
        i=0
        until atlas status 2>/dev/null | grep -q "is running"; do
          i=$((i + 1))
          [ $i -gt 60 ] && fail "Atlas did not start again. See: journalctl -u atlas -n 50"
          sleep 1
        done
        say "Ready for Dokploy's Traefik: set your domain in the page and it serves it with HTTPS."
      else
        printf '\n  \033[33mDokploy'"'"'s Traefik cannot reach Atlas on port 47800 from its container (a firewall?):\n    ufw allow from 172.16.0.0/12 to any port 47800 proto tcp\n  then run this line again, so the domain can go through Traefik later.\033[0m\n'
      fi
    fi

    ok "Atlas is running as a server."
    if [ -n "$DOMAIN" ] && [ -z "$PROXY" ]; then printf '  Open  https://%s  (or http://%s:47800) in your browser.\n' "$DOMAIN" "${IP:-<this server>}"
    else printf '  Open  http://%s:47800  in your browser.\n' "${IP:-<this server>}"; fi
    atlas pair || true
    printf '\n  In the page: Setup (your AI and voice keys), Settings › Security › Address & HTTPS (your domain),\n  and Settings › Security › Machines (one line on each PC).\n'
    printf '  Manage it: systemctl status atlas | journalctl -u atlas -f | atlas pair | atlas update\n\n'
    ;;
esac
