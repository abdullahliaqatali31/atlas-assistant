# Atlas on the PC: system awareness, a system map, and Full control

Written 2026-10-19 from the owner's ask: "be aware of my Bluetooth and Wi-Fi",
"a Full control mode where you don't ask for permission", "know where things
are, so 'open my WSL project in VS Code' or 'open this project in the Claude
app' just works", and "make this folder there, create this document / sheet
for me".

## What exists today (researched)

- **Permissions.** Every tool call goes through `evaluate()` (packages/policy).
  Classes: observe < draft < modify < external-send < destructive < credential
  < payment. Destructive, credential and payment always ask. After untrusted
  content (web, email, WhatsApp, file contents) every non-observe action asks.
  Owner rules can allow a named tool, never `*`.
- **Doing things.** Files only inside folders the owner picked (move, mkdir,
  organise, trash; no writing contents, no documents). Apps only from the
  owner's own list (UI Automation, WhatsApp). Code projects the owner approved
  (run, status); WSL projects are invisible. No shell tool. Nothing opens VS
  Code or the Claude app. No index of the PC.
- **Modes** (companion/work/focus/quiet) only change when Atlas speaks up,
  never permissions.

## Research findings that shape the design

- **Wi-Fi.** `netsh wlan` needs Windows location services on (Windows 11
  24H2+); on this machine it is off device-wide, so netsh fails. Without it:
  `Get-NetConnectionProfile` (network name, internet or not) and
  `Get-NetAdapter` (up/down, speed). With it: signal, band, channel.
- **Bluetooth.** WinRT through PowerShell (~0.6 s): radio on/off
  (`Windows.Devices.Radios`), paired devices and which are connected right
  now, with their kind (headphones, mouse/keyboard, phone).
- **Cheap extras.** Battery and charging, idle time, lock/sleep from Electron's
  `powerMonitor`; VPN from adapters; airplane mode = all radios off.
- **Opening.** VS Code CLI `code <dir>`, WSL: `code --remote wsl+<distro>
  <path>`. Claude desktop has an official deep link:
  `claude://code/new?folder=<path>` (the app asks to trust the folder once).
  Claude Code in a terminal: `claude-cli://open?cwd=<path>`. Apps:
  `Get-StartApps` (Win32 + Store, ~3 s, cached) launched with
  `explorer shell:AppsFolder\<AppID>`. WhatsApp: its Store app, or
  `whatsapp://send?phone=&text=` (prefills, never sends).
- **Documents.** `docx` and `exceljs` are already dependencies.

## The design

### 1. System awareness

A main-process `SystemService` with one long-lived PowerShell worker (no
spawn per question). Every 30 s, and at once on Electron's online/offline,
lock, resume and power events:

- Wi-Fi: on/off, network name, internet / local only / none; signal and band
  when location services allow (otherwise it says how to allow them).
- Bluetooth: on/off; connected devices with their kind.
- Battery %, charging; VPN up; airplane mode.

Atlas gets one line in every turn ("Wi-Fi: Home-5G, internet · Bluetooth:
WH-1000XM4 (headphones) connected · battery 70%, charging") and a
`system_status` tool for detail. Changes become events (headphones connected,
Wi-Fi switched, internet lost, battery low) that Atlas can mention, and that
show on the Alerts timeline. Shortcuts: `system_settings` opens the right
Windows Settings page (Bluetooth, Wi-Fi, location).

### 2. The system map

An index of where things are, kept in `userData/sysmap.json`, built when the
owner turns it on (Setup → Atlas on this PC) and refreshed daily:

- **Apps:** every Start-menu app (Win32 and Store) with its launch id.
- **Projects:** VS Code and Cursor recent workspaces (including WSL ones),
  Claude Code project folders, Atlas's code projects, and git repositories
  found under the usual places (Desktop, Documents, OneDrive, source, dev
  folders) and inside each WSL distro's home.
- **Places:** Desktop, Documents, Downloads, Pictures, OneDrive and their
  folders two levels down.

Never indexed: Windows, Program Files, AppData, other users, password
stores, and any folder the owner excludes. Names and paths only, never file
contents. `system_find` searches it by name and kind ("WSL project", "the
Atlas project", "WhatsApp"); "this project" means the one in the window in
front (from the window activity Atlas already records when allowed).

### 3. Opening and making things

- `open_item` {target, with}: a folder in Explorer, a file in its app, a
  project in **VS Code** (WSL projects through Remote-WSL), the **Claude
  app's Code section**, or **Claude Code in a terminal**.
- `launch_app` {app}: any app in the map ("WhatsApp kholo").
- `make_folder`, `make_document` (.docx from headings, paragraphs, lists and
  tables), `make_sheet` (.xlsx with sheets, columns, rows, a header row and
  sums), then optionally open them.
- Without Full control: opening asks the first time per app, and making
  things outside the owner's chosen folders asks.

### 4. Full control

A switch, separate from the companion/work/focus/quiet modes, in Setup, the
tray and the Ask bar menu: **Normal** or **Full control**.

What Full control changes:

- Atlas acts on the owner's commands without asking: opening, launching,
  making folders, documents and sheets anywhere in the map, moving, organising,
  sending files to the Recycle Bin, reading files, using apps, sending a
  message the owner dictated.
- No first-time asks; the system map is searched without limits.

What stays, on purpose:

- **Always confirm:** permanent deletes, passwords and keys, payments. These
  are irreversible or theft-shaped, and one stray instruction should never
  reach them.
- **Prompt-injection guard:** when the same turn read something from outside
  (a web page, an email, a WhatsApp message, a file's contents), sending
  something out and "risky" app actions (Send, Delete, Pay buttons) still ask.
  A web page must never be able to tell Atlas to message someone. Ordinary
  actions continue.
- **Never touched:** terminals, security tools, password managers and Atlas
  itself (the existing never-touch list); Windows and Program Files folders.

Turning it on: only the owner (the owner check applies), from the switch or by
saying so ("full control on karo"), which shows a one-tap confirmation, so a
web page or message can never switch it on. It lasts **until the owner locks
the PC, leaves, or the PC sleeps** (default), or for an hour, or until turned
off. While on: an amber "Full control" badge in the title bar, an amber ring
on the widget, and every action in Activity with Undo where possible.

### Phases

1. System awareness (service, context line, tool, change events, Settings
   shortcuts).
2. System map (index, exclusions, `system_find`, Setup section).
3. Open and make (VS Code / WSL / Claude app / Claude Code / Explorer / apps;
   documents and sheets).
4. Full control (policy, switch, auto-off, indicators, voice request with
   confirmation).

Each phase ends with typecheck, tests and a commit.
