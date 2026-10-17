# Personal Assistant

An open source, proactive desktop assistant for Windows. It remembers your work across days, notices what matters, starts useful conversations at the right moment, talks with you by voice, and performs authorized work in your browser and on your computer.

It's not another command listener. It's a working companion. It is honest about being an AI, and it never claims progress it can't show evidence for.

> Status: early foundation (Phase 1). See [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for the full plan and [docs/roadmap.json](docs/roadmap.json) for progress.

## What you need

- Windows 11, Node.js 22.13+ and pnpm 9.
- **An LLM API key** (required). Claude is supported first.
- **A voice provider API key** (required). ElevenLabs is supported first.

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
pnpm dist                           # license inventory + unsigned Windows installer in apps/desktop/release
```

The installer is not code-signed yet, so Windows SmartScreen warns on first run ("More info › Run anyway"). Connectors run through `npx`, so they need Node.js installed. Backups (Setup › Security & backups) are AES-256 encrypted with your passphrase and do not include API keys.

Talk normally in the console ("Ahmed ko kal quote bhejna hai, yaad rakhna"). The assistant can add and complete tasks and save facts through tools, and it asks you `[y/N]` before anything outside its standing permissions. Shortcuts: `/task Send revised quote @2026-10-18T10:00`, `/tasks`, `/done 1 sent email #123`, `/promise revised quote to Ahmed @2026-10-18T17:00`, `/remember Ahmed prefers WhatsApp`, `/mode focus`, `/exit`.

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
