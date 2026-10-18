# Personal Assistant

An open source, proactive desktop assistant for Windows. It remembers your work across days, notices what matters, starts useful conversations at the right moment, talks with you by voice, and performs authorized work in your browser and on your computer.

It's not another command listener. It's a working companion. It is honest about being an AI, and it never claims progress it can't show evidence for.

> Status: early foundation (Phase 1). See [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for the full plan and [docs/roadmap.json](docs/roadmap.json) for progress.

## What you need

- Windows 11, Node.js 22.13+ and pnpm 9.
- **An AI provider** (required): Claude, OpenAI, Google Gemini, OpenRouter, Groq, DeepSeek, Mistral, xAI, any OpenAI-compatible server, or a free local model through Ollama (it must support tool calls for Atlas to act). Setup lists the models your key can use.
- **A voice provider API key** (required): ElevenLabs or Azure AI Speech.

You bring your own keys. Nothing is sent to this project, and there is no account to create. No GPU is needed: heavy work runs on your providers, and local models are an optional extra for capable machines.

## Quick start

```bash
pnpm install
pnpm keys set ANTHROPIC_API_KEY     # stored in Windows Credential Manager (hidden input)
pnpm keys set ELEVENLABS_API_KEY
cp .env.example .env                # set ELEVENLABS_VOICE_ID, your name and timezone (no keys needed here)
pnpm doctor --live                  # checks keys, one real reply, and a voice round trip
pnpm chat                           # developer text console
```

You can put keys in `.env` instead; environment variables take precedence over the credential store.

```bash
pnpm desktop                        # the desktop app (development)
pnpm check                          # typecheck and all tests
pnpm learning:demo                  # learning and curiosity on a throwaway database, with your real key
pnpm eval:workflows --full          # 20 browser + 10 file tasks, outcomes checked by code (a few cents of API use)
pnpm trial:skills                   # teach a task in conversation, then run it on request and on schedule (real key, throwaway data)
pnpm trial:provider ollama <model>  # try any LLM provider: a reply and a tool call, on throwaway data
pnpm trial:files                    # list, organise, undo, recycle and a taught file task, on throwaway folders
pnpm dist                           # license inventory + unsigned Windows installer in apps/desktop/release
```

The installer is not code-signed yet, so Windows SmartScreen warns on first run ("More info › Run anyway"). Connectors run through `npx`, so they need Node.js installed. Backups (Setup › Security & backups) are AES-256 encrypted with your passphrase and do not include API keys.

Talk normally in the console ("Ahmed ko kal quote bhejna hai, yaad rakhna"). The assistant can add and complete tasks and save facts through tools, and it asks you `[y/N]` before anything outside its standing permissions. Shortcuts: `/task Send revised quote @2026-10-18T10:00`, `/tasks`, `/done 1 sent email #123`, `/promise revised quote to Ahmed @2026-10-18T17:00`, `/remember Ahmed prefers WhatsApp`, `/mode focus`, `/exit`.

## The app

The window has a rail on the left, the conversation as a side panel next to it, and a broad canvas on the right (Home, News, Projects, Learning, Controls, Setup). The panel can be hidden from the rail, and it opens by itself when Atlas speaks up. Home shows presence, today's tasks, your code projects, the news with pictures and recent actions.

The layout adapts to the window: side panel when wide, a drawer over the canvas when narrower, and a bottom tab bar at phone width. Compact mode (rail button, or ask) shrinks Atlas to a small chat window in the corner, optionally kept on top; the full window comes back as it was. Atlas knows what its window shows and can change it when you ask (“compact ho jao”, “news dikhao”, “chat band karo”, “bari window kar do”, “upar rakho”).

News comes from public RSS feeds, refreshed every 30 minutes, with each story's own picture where the feed provides one. Pictures are fetched by the app and cached, so pages never load remote content. You can choose sources (News › Sources) and save stories for later (News › Saved). Sources on by default: Dawn, Express Tribune, BBC World, Dawn Business and The Verge. Optional: Geo News, BBC Technology and TechCrunch. Atlas can read the headlines to you ("aaj ki khabrein?").

Files: Atlas looks after only the folders you add in Files, read-only until you allow organising. It can list and search, read Word, Excel, PowerPoint, PDF and text files (asking you first for every file: “Abdullah, kya main … parh loon?”), move, rename and copy, make folders, tidy loose files by type, month or year (plan first), and remove to the Recycle Bin (always asks). Nothing is overwritten or permanently deleted, and every change has Undo in Files. File routines are taught like any task ("every Friday tidy Downloads").

Apps: Atlas uses desktop apps you add in Apps through Windows UI Automation (the accessibility interface screen readers use), driven by a small worker built from Windows PowerShell and a C# helper that ship with Windows. Per app you choose open, read the screen, or control (click, type, keys). Send, Delete, Pay, Call and similar buttons, Enter in chat apps and select-all wipes always ask; typing is read back and checked; password fields are never read or typed. Terminals, system tools, Windows security, password managers and browsers are never controllable. WhatsApp Desktop has its own tools: chat list and unread, read a chat, download a document someone sent into Downloads and review it (asks first), and send, which opens the chat by search, checks the message box names that person before typing, and asks you each time with the exact text. Questions Atlas needs a yes for are asked in the conversation, aloud when you are talking; a short “chalo kar lo / haan” or “nahi, main khud bata dunga”, typed or spoken, answers them (the buttons still work). Teach by showing: Watch me records your clicks and typing in the chosen apps (never passwords) and turns them into a task. Reading an app sends what it shows to your AI provider. Live check: `ATLAS_LIVE=1 pnpm vitest run apps/desktop/src/main/desktop/desktop.live.test.ts` (Notepad on a fresh tab, WhatsApp read-only).

## Layout

```text
packages/shared       typed events, ids, clock
packages/policy       deterministic permission gate (outside the LLM)
packages/initiative   when to speak: cooldowns, budgets, quiet hours, modes
packages/memory       SQLite + FTS5 memory, tasks with evidence, corrections
packages/providers    LLM and voice contracts + Claude and ElevenLabs adapters
packages/mcp          MCP client host with policy mapping
packages/runtime      conversation manager, persona, dev console
apps/desktop          Electron shell (next)
workers/              optional local voice and Windows accessibility workers
```

## Connectors (MCP)

Copy `mcp.servers.example.json` to `mcp.servers.json` and enable the servers you authorize. Every tool goes through the policy gate. Tools without safety annotations are treated as external sends and need your confirmation.

## Principles

- Memory is local, inspectable, correctable and deletable.
- Every action passes a deterministic policy gate; webpages, emails and messages are data, not instructions.
- The assistant speaks up sparingly: one routine check-in per hour, five per day, and never during quiet hours, by default.
- No keystroke logging, no continuous screen recording.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
