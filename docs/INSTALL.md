# Installing Atlas

Atlas has two halves:

- **The brain:** the AI, memory, reminders, the web page and Telegram.
- **The hands:** what it does on a computer: apps, files, code, PC status and the widget.

Pick where the brain lives.

| You want | Install | Go to |
| --- | --- | --- |
| Atlas on your own PC, nothing else | the full app on that PC | [A. On one PC](#a-on-one-pc) |
| Atlas awake 24/7, reachable from your phone anywhere, working on your PCs | the brain on a server, hands on each PC | [B. On a server](#b-on-a-server) |
| A PC to join an Atlas that already runs elsewhere | the hands only | [C. Hands only on a PC](#c-hands-only-on-a-pc) |
| Atlas on your PC already, and now you are moving to a server | B, then C, then bring your data | [D. Moving your data](#d-moving-your-data-from-a-pc-to-the-server) |

Every option needs [Node.js](https://nodejs.org) 22.13 or newer. The installers below get it for you if it is missing.

## A. On one PC

**Windows 10/11.** In PowerShell:

```powershell
iwr -useb https://github.com/abdullahliaqatali31/atlas-assistant/releases/latest/download/install.ps1 | iex
```

**macOS.** In Terminal:

```sh
curl -fsSL https://github.com/abdullahliaqatali31/atlas-assistant/releases/latest/download/install.sh | sh
```

**With Node.js already installed:**

```sh
npm install -g atlas-ai-assistant
atlas
```

Atlas starts, opens in your browser, and starts with your PC from then on. Setup asks for your AI key and voice key.

## B. On a server

### Ubuntu, Debian or Fedora (a VPS or a home server)

```sh
curl -fsSL https://github.com/abdullahliaqatali31/atlas-assistant/releases/latest/download/install.sh | sh
```

It installs Node.js and Atlas and sets up an `atlas` systemd service. That service restarts Atlas after a crash or a reboot. At the end the installer prints the address to open and a code for your browser.

The installer ends by printing `http://<server IP>:47800` and a pairing code. Open that address, enter the code, and go through Setup.

**Your domain, later, in the page.** Point the domain's DNS at the server (an A record). Then open **Settings › Security › Address & HTTPS**, type the domain and save. What happens depends on what is already on the server:

| On the server | When you save the domain |
| --- | --- |
| Nothing on ports 80 and 443 | Atlas gets its own Let's Encrypt certificate and renews it. |
| **Dokploy** (its Traefik holds 80 and 443) | Atlas adds its route to Dokploy's Traefik. The certificate comes from Dokploy's own Let's Encrypt setup, so there is nothing to do in Dokploy. Atlas runs **beside** Dokploy as its own service, not as a Dokploy app, and your apps are not touched. |
| Nginx, Caddy or another web server | Choose "behind a proxy", and add the few lines the page shows to that web server. |

**What the installer prepares, on a Dokploy server:**

- It makes one route file, `/etc/dokploy/traefik/dynamic/atlas.yml`, that Atlas is allowed to write. That is the only file it touches in Dokploy's folders.
- It checks that Traefik's container can reach Atlas.
- It opens port 47800 if the `ufw` firewall is on.

It also writes `/etc/atlas.env`, readable only by root. That file holds the key that seals your API keys, kept apart from the data.

**To remove the route:** choose "No domain" in the page, or delete `atlas.yml`.

### Docker

```sh
git clone https://github.com/abdullahliaqatali31/atlas-assistant && cd atlas-assistant
export ATLAS_SECRET_KEY="$(openssl rand -base64 32)"     # keep it: it seals your API keys
docker compose -f docker/compose.yaml up -d --build
docker compose -f docker/compose.yaml exec atlas atlas pair
```

### As a Dokploy or Coolify app (instead of beside it)

If you would rather manage Atlas inside the panel, as one of its apps:

1. **Create Service › Compose.** Use this repository. Set the Compose Path to `./docker/compose.dokploy.yaml`.
2. **Environment.** Set `ATLAS_DOMAIN=atlas.example.com`, and set `ATLAS_SECRET_KEY` to the output of `openssl rand -base64 32`.
3. **Domains.** Add your domain, pointing to service `atlas` on port `47800`, with HTTPS on. The panel gets the Let's Encrypt certificate.
4. **Deploy.** The first build takes several minutes because it builds the page with its 3D globe. The pairing code is in the service's **Logs**. To make a new one, run `atlas pair` in the service's terminal.

### Then, in the page

- **Settings › Security › Address & HTTPS:** your domain with a free certificate that renews by itself. Skip this if Dokploy or another proxy does it.
- **Settings › Security › Machines:** connect your PCs (C below).
- **Setup:** your AI and voice keys. Alternatively, bring them from your PC (D below).

More: [SERVER.md](SERVER.md), which covers what runs where, safety and every command.

## C. Hands only on a PC

On the brain's page, open **Settings › Security › Machines › Add a machine**. It shows **one line**, already holding the brain's address and a one-time code. Paste it on the PC:

**Windows (PowerShell):**

```powershell
irm "https://atlas.example.com/hands/install.ps1?code=ABCD-EFGH" | iex
```

**macOS or Linux (Terminal):**

```sh
curl -fsSL "https://atlas.example.com/hands/install.sh?code=ABCD-EFGH" | sh
```

That line:

1. Installs Node.js if it is missing.
2. Installs Atlas's hands **from the brain itself**. They are the same version as the brain, so the two always understand each other, and nothing comes from GitHub or npm.
3. Connects the PC, and makes it start with the PC from then on.

On a Mac or Linux it installs in `~/.atlas`, so no administrator password is needed.

Without the brain's page at hand, the installers from the release do the same:

```powershell
& ([scriptblock]::Create((iwr -useb https://github.com/abdullahliaqatali31/atlas-assistant/releases/latest/download/install.ps1))) -Connect https://atlas.example.com -Code ABCD-EFGH
```

```sh
curl -fsSL https://github.com/abdullahliaqatali31/atlas-assistant/releases/latest/download/install.sh | sh -s -- --connect https://atlas.example.com ABCD-EFGH
```

**With Node.js already installed:**

```sh
npm install -g atlas-ai-assistant
atlas connect https://atlas.example.com ABCD-EFGH
```

The PC gets a tray icon: Open Atlas, the connection, Reconnect, Quit. It reconnects by itself after sleep or a network change, and starts with the PC. No full Atlas runs on it: the brain does the thinking.

```text
atlas disconnect   stop, and do not start with the PC any more
atlas connect      connect again (the pairing is remembered)
```

## D. Moving your data from a PC to the server

If Atlas used to run on your PC, it holds your memories, notes, settings and keys there. To move them:

1. Set up the server (B), and connect the PC as its hands (C). The full Atlas on the PC can stay running for now.
2. In the server's page, open **Settings › Security › Machines**. On that PC's row, choose **Bring its Atlas data here**.
3. Tick **Bring the API keys too** if you want them, then **Bring it here**.

What comes over:

- the memory database
- `MEMORY.md` and the daily notes
- skills
- your name and voice choice
- rules and connections
- the security code, the chosen model, timers, watches, and the Telegram settings

The server first keeps a safety copy of what it had, then restarts with your data.

What stays on the PC: its folders, apps, browser habits, and connectors that point at its disk. The PC keeps doing that work as Atlas's hands.

4. On the PC, run `atlas stop` so only the server answers you. Keep `atlas connect` running.

Nothing syncs by itself: the move happens once, when you choose it. From then on, everything Atlas learns is kept on the server.

## Updating

```sh
atlas update          # on a PC or a server installed with install.sh or npm
docker compose -f docker/compose.yaml up -d --build      # Docker: rebuild from the latest code (git pull first)
```

Dokploy: **Redeploy** after pulling.
