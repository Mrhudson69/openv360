# Running openv360 behind your own reverse proxy

By default [`deploy/setup-server.sh`](../../deploy/setup-server.sh) bundles
**Caddy** for automatic HTTPS. If you already run **nginx, Traefik, HAProxy,**
or another reverse proxy (often in its own container), skip Caddy and point your
proxy at openv360 instead.

The openv360 **`server`** container is a plain HTTP app on port **8080**. It sets
`trustProxy: true` and honours `X-Forwarded-Proto` / `X-Forwarded-Host`, so it
works cleanly behind a proxy that terminates TLS.

---

## TL;DR

1. Run **without Caddy** — only `db` + `server`.
2. Let your proxy reach the server container (shared Docker network, recommended)
   or the published loopback port.
3. In your proxy, forward to `:8080`, set the `X-Forwarded-*` headers, and raise
   **`client_max_body_size` to at least 10 MB** (screenshots).
4. Set **`PUBLIC_URL`** so install one-liners and download URLs use your real
   domain.

---

## Option 1 — one command (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Mrhudson69/openv360/main/deploy/setup-server.sh \
  | sudo bash -s -- --no-caddy
```

`--no-caddy` (aliases: `--proxy`, `--behind-proxy`) installs everything **except**
Caddy, publishes the server on `127.0.0.1:8080`, and prints a ready-to-paste
nginx `location` block. It asks for the **public domain** your proxy serves and
writes `PUBLIC_URL=https://<domain>` into `/opt/openv360/.env`.

Then point your proxy at `127.0.0.1:8080` (host) — see the nginx example below —
**or** join a shared Docker network (Option 3) if your proxy is containerised.

## Option 2 — manual (compose)

```bash
git clone https://github.com/Mrhudson69/openv360.git /opt/openv360
cd /opt/openv360
cp .env.example .env
# edit .env:
#   PUBLIC_URL=https://v360.example.com
#   POSTGRES_PASSWORD=<something strong>
#   SERVER_BIND=127.0.0.1           # loopback only; the proxy forwards to it
#   ADMIN_EMAIL=... ADMIN_PASSWORD=... ORG_NAME="..."
#   (do NOT set the Caddy COMPOSE_FILE)
docker compose up -d --build
```

Server is now at `http://127.0.0.1:8080`. Configure your proxy (below).

## Option 3 — proxy in a container (shared network)

If your nginx/Traefik runs in Docker, give both a shared network so the proxy can
reach openv360 by name — no host ports needed.

```bash
# in /opt/openv360/.env
COMPOSE_FILE=docker-compose.yml:deploy/docker-compose.proxy.yml
PROXY_NETWORK=<your proxy's docker network>   # `docker network ls` to find it
PUBLIC_URL=https://v360.example.com
```

```bash
docker compose up -d --build
```

[`deploy/docker-compose.proxy.yml`](../../deploy/docker-compose.proxy.yml)
attaches the `server` to that external network with the alias **`openv360`**, so
your proxy does `proxy_pass http://openv360:8080`.

---

## nginx

A full example is in
[`deploy/nginx.conf.example`](../../deploy/nginx.conf.example):

```nginx
server {
    listen 443 ssl http2;
    server_name v360.example.com;

    ssl_certificate     /etc/letsencrypt/live/v360.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/v360.example.com/privkey.pem;

    client_max_body_size 25m;                 # screenshots upload up to ~10 MB (nginx default is 1 MB!)

    location / {
        proxy_pass         http://openv360:8080;   # or http://127.0.0.1:8080; for a host-published server
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   X-Forwarded-Host  $host;
        proxy_read_timeout 120s;
    }
}
server { listen 80; server_name v360.example.com; return 301 https://$host$request_uri; }
```

## Traefik (labels)

```yaml
# add to the server service in a compose override
services:
  server:
    labels:
      - traefik.enable=true
      - traefik.http.routers.openv360.rule=Host(`v360.example.com`)
      - traefik.http.routers.openv360.entrypoints=websecure
      - traefik.http.routers.openv360.tls.certresolver=letsencrypt
      - traefik.http.services.openv360.loadbalancer.server.port=8080
    networks: [default, edge]   # edge = your Traefik network
```
Traefik's default buffering allows large bodies; if you've restricted it, raise
the request body limit to ≥ 10 MB.

---

## Checklist / gotchas

- **`client_max_body_size` ≥ 10 MB** (we suggest 25 MB). Without it, screenshot
  uploads fail with **413 Request Entity Too Large**. This is the #1 mistake.
- **`PUBLIC_URL`** (or forwarding `X-Forwarded-Proto: https` + `X-Forwarded-Host`)
  is what makes the dashboard's **install one-liners** and the agent **download
  URLs** use `https://your-domain`.
- **No WebSockets** — the app polls over plain HTTP, so you don't need
  `Upgrade`/`Connection` handling.
- **Don't publish 80/443 from openv360** in proxy mode — your proxy owns them.
  Keep `SERVER_BIND=127.0.0.1` (loopback) or use the shared-network override.
- **Health check:** `curl -s http://127.0.0.1:8080/api/health` on the host (or
  `docker compose exec server wget -qO- http://localhost:8080/api/health`).
