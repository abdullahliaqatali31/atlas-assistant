# Atlas

An open source, proactive personal assistant for Windows. Atlas remembers your work across days, notices what matters, speaks up at the right moment (and learns when not to), talks with you by voice in English and Roman Urdu, and does authorized work in your browser and on your PC.

It runs on your own computer as one small Node.js process and opens in your browser. You bring your own AI and voice keys: nothing is sent to this project and there is no account.

> Status: 0.4, before the first public release. See [docs/ROADMAP_V1.md](docs/ROADMAP_V1.md).

## Install

You need Windows 10 or 11. The installer brings Node.js 22 if it is missing.

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -From .\atlas-<version>-win-x64.zip
```

Then:

```text
atlas            start Atlas (if needed) and open it in your browser
atlas stop       stop it
atlas status     is it running, and where
atlas logs       the last lines of its log
atlas update     install the latest release, if newer (--check only says)
```

On first start Atlas walks you through setup: an **AI provider** (Claude, OpenAI, Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI, any OpenAI-compatible server, or a local model through Ollama), a **voice provider** (ElevenLabs, Azure AI Speech or OpenAI), your name, and how Atlas should talk. Keys are kept in Windows Credential Manager, never in files.

Your data lives in `%APPDATA%\Personal Assistant`; the program in `%LOCALAPPDATA%\Atlas`. A tray icon gives quick access, notices and global shortcuts.

## What it does

- **Conversation and voice.** Type or talk; Atlas answers aloud, can be interrupted, and understands Roman Urdu and English. Optional wake word and live voice.
- **Voice ID.** Knows the owner's voice from others (voice prints stay on the PC, encrypted). Personal answers only to the owner; never used as a lock.
- **Memory.** Tasks, commitments, facts and preferences in a local SQLite database, mirrored to `MEMORY.md` that you can read and edit. Optional recall by meaning with a small multilingual model that runs on the PC.
- **Speaking up.** Morning briefings, due reminders, welcome-backs, project nudges. Quiet hours, a daily limit and a minimum gap are yours to set, and Atlas learns which speak-ups you usually pass on and shows those quietly instead.
- **Instant commands.** "What time is it", "stop", "focus mode", "louder", "open the news", "5 minute ka timer": answered at once without the model.
- **Hands.** Its own browser (your Chrome or Edge through Playwright, with a live picture you can click), files in the folders you add, desktop apps through Windows UI Automation, Gmail and Calendar, timers and alarms, a look at the screen, Telegram on your phone, skills in the shared `SKILL.md` format, and any MCP connector (local or remote).
- **World and news.** Weather, air quality, earthquakes and natural events for the places you care about; news from public feeds.
- **Phone and other devices.** The same interface on any paired browser on your network, if you turn it on.

## Safety

- Every action passes a deterministic policy gate outside the model. Sending, paying, deleting and anything new asks you first; webpages, emails and messages are data, never instructions.
- **Stop all** (tray, `Ctrl+Alt+P`, or a button) silences Atlas and cancels everything it is doing.
- Memory is local, inspectable, correctable and deletable. No keystroke logging, no continuous screen recording.
- The web interface listens on this PC only, unless you allow other devices; every device is paired by code.

More in [SECURITY.md](SECURITY.md).

## From source

```bash
pnpm install
pnpm dev            # builds, starts the gateway, reloads on changes, opens http://localhost:47800
pnpm check          # typecheck and all tests
pnpm dist           # license inventory, build and the release zip in apps/desktop/release
```

Developer tools: `pnpm chat` (text console), `pnpm doctor --live` (checks keys with one real reply and a voice round trip), `pnpm keys set <NAME>` (store a key). The `trial:*` and `eval:workflows` scripts use your real keys on throwaway data and cost a little.

How it fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE) and [docs/THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md).
