# Atlas on a server, your PCs as its hands

Atlas has two halves:

- **The brain:** the model, memory, reminders, the briefing, Telegram, the world feeds, and the web page you talk to it in.
- **The hands:** what it does on a computer. That covers apps, files, code projects, PC status, notices, alarms and the desktop widget.

Installed on your PC, both halves run there, in one process. The brain can also run on its own: a VPS, a home server or a Docker container, awake around the clock. Your PCs then connect to it as its hands. The page opens from any browser, at your own domain over HTTPS.

```text
              ┌──────────── Atlas brain (24/7) ─────────────┐
              │ model, memory, reminders, Telegram, the page │
              │ https://atlas.example.com  (Let's Encrypt)   │
              └────────▲──────────────────────▲──────────────┘
                       │ wss, opened by the PC│
              ┌────────┴────────┐    ┌────────┴────────┐
              │ hands: Windows  │    │ hands: Mac/Linux│   phone, tablet:
              │ apps, files,    │    │ files, code,    │   just the page
              │ widget, notices │    │ status          │
              └─────────────────┘    └─────────────────┘
```

Each PC opens its own connection to the brain. Nothing on a PC needs an open port, a public address or a VPN.

### What runs where

| On the brain (the server) | On a connected PC (its hands) |
| --- | --- |
| The model, the conversation and its history | PC status: Wi-Fi, battery, Bluetooth, Windows Settings |
| Memory: the database, `MEMORY.md` and the daily notes (read and edit them in **Learning › Your memory › Read and edit here**) | Finding, opening and making files and documents on that PC |
| Reminders, timers, the briefing, speaking up | Desktop apps, WhatsApp desktop, "watch me" |
| Atlas's own browser, headless Chromium: browsing, reading pages, signing in to sites | Files in the folders you chose, code projects, VS Code |
| Gmail, Calendar, connectors (MCP), skills, Telegram | Browser habits (the Profiles tab reads that PC's history) |
| News, the World map, flights and the 3D globe | Windows notifications, the desktop widget, tray notices and alarms |

The brain works while every PC is off: you can talk to it from your phone, get reminders on Telegram, and have it browse. A PC only needs to be connected for work on that PC.

## 1. Run the brain

### Linux with systemd (Ubuntu, Debian, Fedora…)

```sh
curl -fsSL https://github.com/abdullahliaqatali31/atlas-assistant/releases/latest/download/install.sh | sh
```

What the installer does:

- Installs Node.js 22 if it is missing.
- Installs the `atlas` command.
- Sets up an `atlas` systemd service that runs as your user, so it starts after a reboot and restarts after a crash.

It prints the address to open and a code for your browser. Use `atlas pair` to make another code.

### Docker

```sh
git clone https://github.com/abdullahliaqatali31/atlas-assistant && cd atlas-assistant
export ATLAS_SECRET_KEY="$(openssl rand -base64 32)"   # keep this safe
docker compose -f docker/compose.yaml up -d --build
docker compose -f docker/compose.yaml exec atlas atlas pair
```

The image builds from the repository: several minutes the first time, because the page and its 3D globe are built. It includes Chromium, so Atlas's own browser works there. Everything the brain keeps lives in the `atlas-data` volume: memory, settings, sealed keys and certificates.

### Beside Dokploy (or Nginx, Caddy) on the same server

Over SSH, run the same Linux installer. Atlas runs as its own service on port 47800, beside the panel and not as one of its apps. The domain is set later in the page, in **Settings › Security › Address & HTTPS**:

- **Dokploy:** Atlas writes its route to `/etc/dokploy/traefik/dynamic/atlas.yml`, so Traefik sends your domain to Atlas with a certificate from Dokploy's own Let's Encrypt resolver. The installer prepared that one file, and checked that Traefik's container can reach Atlas.
- **Nginx or Caddy:** choose "behind a proxy" and add the lines the page shows.

Port 47800 then only needs to be reachable from the server itself. You can close it to the internet in your firewall.

### As a Dokploy or Coolify app

The panel already handles domains and HTTPS on ports 80 and 443, so Atlas runs behind it on port 47800:

1. **Create Service › Compose.** Use this repository, with the Compose Path `./docker/compose.dokploy.yaml`.
2. **Environment.** Set `ATLAS_DOMAIN=atlas.example.com`, and set `ATLAS_SECRET_KEY` to the output of `openssl rand -base64 32`.
3. **Domains.** Add your domain, pointing to service `atlas` on port `47800`, with HTTPS on.
4. **Deploy.** The pairing code is in the service's Logs. To make another, run `atlas pair` in its terminal.

Atlas starts knowing its domain and that the proxy does HTTPS. **Settings › Security › Address & HTTPS** shows "behind a proxy".

### Any machine with Node.js 22.13+

```sh
npm install -g atlas-ai-assistant
atlas server        # in the background; atlas pair prints a code, atlas stop stops it
```

Open `http://<server address>:47800`, enter the code, and go through Setup: your AI and voice keys, and your name.

## 2. Give it a domain with HTTPS

Open **Settings › Security › Address & HTTPS**:

1. At your DNS provider, add an **A record** for a name such as `atlas.example.com`, pointing at the server's public IP. The card shows both addresses, so you can compare them.
2. Open ports **80** and **443** in the server's firewall. Let's Encrypt checks port 80.
3. Choose **My domain, HTTPS by Atlas** and type the domain, plus an email if you want expiry notices. Then save.

Atlas then gets a free Let's Encrypt certificate. It answers at `https://atlas.example.com` and sends plain http there. It renews the certificate by itself when fewer than 30 days are left. The systemd service and the Docker container already have permission for ports 80 and 443. Anywhere else on Linux, run `sudo setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(which node)")"`.

**Already have a proxy** (Caddy, Traefik, Nginx, Dokploy or a Cloudflare Tunnel)? Choose **My domain, behind a proxy that does HTTPS**. Point the proxy at `http://<server>:47800` with WebSocket upgrades on, and have it send `X-Forwarded-Proto: https`.

Use HTTPS when Atlas is reachable from the internet. Browsers allow the microphone only over HTTPS, and HTTPS keeps your conversation and codes private on the way.

## 3. Connect your PCs

In the page, open **Settings › Security › Machines** and choose **Add a machine**. It shows one line with the address and a one-time code. On Windows that is `irm "https://atlas.example.com/hands/install.ps1?code=…" | iex`; on a Mac or Linux it is `curl -fsSL "…/hands/install.sh?code=…" | sh`. The line installs Node.js if needed and Atlas's hands from the brain (the same version), then connects. When Atlas is installed there already, run:

```sh
atlas connect https://atlas.example.com ABCD-EFGH
```

The PC pairs, then keeps a connection to the brain. It reconnects by itself after sleep or a network change, and starts with the PC (a Run entry on Windows, a LaunchAgent on a Mac, autostart on a Linux desktop). On Windows it has a tray icon with Open Atlas, the connection state, Reconnect and Quit. To stop and resume:

```sh
atlas disconnect     # stops the hands on this PC; they no longer start with it
atlas connect        # resumes, with the saved pairing
```

The installers do it in one line, Node.js included:

- **Windows:** `install.ps1 -Connect <address> -Code <code>`
- **macOS and Linux:** `install.sh` with `sh -s -- --connect <address> <code>`

See [INSTALL.md](INSTALL.md).

### Bringing your data from a PC

If Atlas used to run on the PC, its memory is there. On the PC's row in **Machines**, choose **Bring its Atlas data here**. These come over the PC's own connection:

- the memory database, `MEMORY.md` and the daily notes
- skills
- your setup, rules and connections
- the security code, timers and watches
- the API keys, only if you tick it

The server keeps a safety copy of its own data in `backups/before-move-…`, then restarts with yours. Afterwards, run `atlas stop` on the PC, so only the server answers you. Nothing syncs by itself; from then on the server keeps everything Atlas learns.

One machine at a time is **the one Atlas works on**. Its apps, files, status, notices and widget are what Atlas uses, and the This PC settings show that machine. Switch machines in **Machines**. Notices and alarms reach every connected machine.

### What a connected PC does

| | Windows | Mac | Linux desktop |
| --- | --- | --- | --- |
| Status, search, open and make files and documents | ✓ | ✓ (Spotlight) | open and make; search is coming |
| Files in folders you chose, code projects, VS Code | ✓ | ✓ | ✓ |
| Desktop apps, WhatsApp desktop, "watch me" | ✓ | – | – |
| Desktop widget, tray notices, alarms, lock and unlock | ✓ | menu-bar helper coming | – |

## Safety

- **Pairing.** Each machine pairs once, with a code that works one time and expires after 15 minutes. After five wrong codes, pairing stops until a new code is made. The brain keeps only a hash of each machine's token. **Remove** in Machines cuts the machine off at once, and its hands stop.
- **Approvals.** Approvals and the owner check stay with the brain. While Atlas is locked, a machine refuses owner-only work as well. Full control can only be turned on in the page, by you.
- **Machines connect out.** The brain cannot reach a machine that is not connected, and a page in a browser cannot open a machine connection.
- **Keys on a server.** A server has no keychain, so keys are sealed one by one with AES-256-GCM in `secrets.json`. The sealing key comes from `ATLAS_SECRET_KEY` (keep it outside the data, in `/etc/atlas.env` or a Docker secret). Without it, the key comes from a `secret.key` file beside the data that only the service's user can read.
- **The page.** Each browser pairs once. The cookie is HttpOnly, SameSite=Strict, and Secure over HTTPS. Every channel that changes something checks that it is you.

## Commands

```text
atlas server                 start the brain alone (no tray, no PC services)
atlas pair                   a code to pair a browser with this brain
atlas connect <addr> <code>  make this PC the hands of a brain elsewhere
atlas connect                resume, with the saved pairing
atlas disconnect             stop the hands on this PC
atlas status | logs | stop | update
```

Environment: `ATLAS_DATA_DIR` (where the data lives), `ATLAS_SECRET_KEY`, `ATLAS_HOST` (the address to listen on, `0.0.0.0` by default on a server), `ATLAS_HTTP_PORT` and `ATLAS_HTTPS_PORT` (80 and 443), and `ATLAS_ACME_STAGING=1` (Let's Encrypt's test service).
