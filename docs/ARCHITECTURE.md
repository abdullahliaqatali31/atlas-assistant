# Architecture

Atlas is a pnpm monorepo. The app is `apps/desktop`; the reusable core is in `packages/`.

## Processes

```text
 browser tab(s) ──HTTP + WebSocket──▶ gateway (Node)  ──fork, IPC──▶ runtime (Node)
                                        │                              │
                                 tray (PowerShell)              LLM, voice, MCP servers,
                                 Chrome/Edge (Playwright)       SQLite memory
```

| Process | Code | Owns |
| --- | --- | --- |
| **Gateway** | `src/gateway/index.ts`, `src/main/*` | The web server and WebSocket (`main/web`), device pairing, the handler registry every page call goes through (`OWNER_ONLY`, `requireOwner()`), settings (`setup.json`), supervision of the runtime, Atlas's browser (`main/browser.ts`), files, apps, PC map, Voice ID, timers, Telegram, world data, backups. |
| **Runtime** | `src/runtime/host.ts` | The `Assistant` (conversation, tools, initiative), `MemoryStore`, LLM and voice providers, the MCP host, the credential store. Forked by the gateway with `serialization: 'advanced'`; restarted with backoff if it exits. Exits when the gateway goes. |
| **Tray** | `src/main/host/tray.ps1`, `tray.ts` | A PowerShell helper with a C# NotifyIcon: icon and menu, balloons, global hotkeys (`RegisterHotKey`), lock / idle / resume signals, alarm sound. Talks to the gateway over stdin/stdout lines. |
| **Page** | `src/renderer/` | React UI. Calls the gateway through `window.assistant`, `window.controls`, `window.learning`… (`src/shared/bridges.ts`), all over one WebSocket (`renderer/src/web/transport.ts`). Microphone capture, audio playback, wake word. No keys. |

`src/main/host/index.ts` stands in for what Electron used to give: app paths, opening links and files, Windows pickers, power events, the network.

## Message flow

1. The page calls a bridge method → a channel name from `src/shared/ipc.ts` (or `learning.ts`, `telegram.ts`…) → the gateway's handler. Every payload is validated in the gateway; the runtime trusts only the gateway.
2. Conversation requests go to the runtime (`HostRequest`), which streams `HostEvent`s back: text deltas, audio, approvals, tool activity, initiative.
3. The gateway forwards what the page needs and acts on the rest (stop, mode, timers, notices to the tray and Telegram).

## Core packages

| Package | Does |
| --- | --- |
| `shared` | Typed events, ids, the clock, personality types. |
| `policy` | `evaluate()`: the deterministic permission gate. Each tool has an action class (observe, local-write, external-send, …); rules allow, ask or deny. Untrusted content never raises a permission. |
| `initiative` | `decide()`: whether and how to speak up (speak, notify, later, suppress) given mode, quiet hours, a daily budget, a cooldown and what the owner's reactions taught (`welcome.ts`). |
| `memory` | SQLite (`node:sqlite`) with FTS5: messages, tasks with evidence, commitments, facts, corrections, personality versions, initiative log, vectors for recall by meaning. |
| `providers` | LLM adapters (Anthropic, OpenAI-compatible, Gemini, Ollama…) and voice (ElevenLabs, Azure, OpenAI), sentence chunking for speech. |
| `mcp` | MCP client host over stdio and HTTP, with policy mapping and allow-lists. |
| `runtime` | The `Assistant`, persona and system prompt, context packets, config, the CLI tools (`chat`, `doctor`, `keys`, trials). |

## Data

Everything is under `%APPDATA%\Personal Assistant` (override with `ATLAS_DATA_DIR`):

- `data/assistant.db`: the memory database. `data/memory-files/`: `MEMORY.md` and daily notes (edits flow back).
- `setup.json` (non-secret settings), `controls.json` (rules), `mcp.servers.json`, `gateway.json` (where the gateway runs, for the `atlas` command), `logs/`.
- Secrets are in Windows Credential Manager only (`SECRET_NAMES` in the runtime's credential store). Voice prints are encrypted with a key stored there.

## Design rules

- The model proposes; code decides. Permissions, budgets, quiet hours and instant commands are plain code with tests.
- Anything that leaves the PC or cannot be undone asks the owner, every time, unless the owner made a rule.
- Hardware-neutral: no GPU needed. Local models (recall by meaning, Voice ID, wake word) are small, optional and download only when turned on.
- Each feature ships with tests; `pnpm check` must pass.
