# Desktop app

Electron + React + TypeScript shell (plan sections 5, 6 and 15).

```
pnpm desktop            # same as pnpm --filter @assistant/desktop dev
pnpm --filter @assistant/desktop build
```

## Process layout

| Process | Code | Owns |
| --- | --- | --- |
| Main | `src/main/` | Tray, companion window, IPC validation, non-secret setup (`setup.json` in userData), runtime supervision |
| Runtime host (Electron utility process) | `src/runtime/host.ts`, `speaker.ts` | `Assistant`, `MemoryStore` (node:sqlite), providers, MCP host, OS credential store, speech-to-text and sentence TTS |
| Preload | `src/preload/index.ts` | `window.assistant`: status, send, sendVoice, stop, setMode, setSpeech, listTasks, saveSetup, answerApproval, onReply, onAction, onStatus. `window.controls`: connections, rules, activity, pause and stop (`src/shared/control.ts`) |
| Renderer (sandboxed) | `src/renderer/` | Setup screen and floating companion, mic capture and audio playback (`audio.ts`); no Node, no keys |

- The renderer runs with `sandbox`, `contextIsolation` and no `nodeIntegration`; navigation and new windows are blocked, and main rejects IPC from any other frame. Every payload is re-validated in `src/shared/ipc.ts`.
- Keys typed in setup go renderer → main → host once; the host writes them to the OS credential store (same store as `pnpm keys`). Main only ever learns whether each key is present, and the host scrubs key values from every log line and error it reports.
- Setup problems come straight from `loadConfig` plus the provider connection tests, so the LLM key, voice key and voice id are all required (`ASSISTANT_DEV_SKIP_VOICE=1` still works in development). In development the repo's `.env` is read too.
- Tools come from `localTools`, `open_application` (when the owner allow-listed apps) and the MCP servers turned on in Connections. When the policy gate says "ask", the companion shows an Allow once / Decline card (and reopens the window if it was closed); no answer within 2 minutes, Stop, or a new message counts as a no.
- Closing the window destroys the renderer; the tray and runtime keep running. Tray → Quit stops the runtime, then the app. An unexpected runtime exit restarts it with backoff (1 s doubling to 30 s) and ends any in-flight reply with an error.

## Connections, permissions and safety (plan sections 13, 13.1 and 14)

The sliders button in the companion opens three tabs. Main owns everything here (`src/main/controls.ts`); the runtime only receives it (`src/runtime/controls.ts`).

- **Connections** lists the servers in `mcp.servers.json` (userData) plus the starter catalogue, each with its state (off, starting, running · N tools, failed with the reason). Turning one on or off rewrites the file and restarts only the MCP host; the conversation and local tools keep going.
  - **Browser (Playwright):** `npx -y @playwright/mcp@latest --isolated`, a separate automation browser with an in-memory profile. It never uses the owner's own browser profile.
  - **Files:** `@modelcontextprotocol/server-filesystem`, started with only the folders picked in the folder chooser. The server refuses every other path. Whole drives and folders holding the app's own settings (userData, `mcp.servers.json`) are refused.
  - **Trust** lets a server's own tool annotations set the action class (for example, read-only means observe). While trust is off, every tool counts as external-send and asks first. The tools list shows each tool's class.
  - Google Calendar and Gmail are listed as coming later.
  - **Applications:** an allow list for `open_application`. The tool sends only an app id, and main opens that app's stored path with `shell.openPath`. It always asks first, because no owner rule can allow it.
- **Permissions** shows the built-in rules and the owner's rules (`controls.json` in userData). A rule names one tool or one whole connection (`playwright__*`) and has an action class, an optional folder or site, and an optional expiry. Main validates every rule and checks the file again on each read. The runtime receives rules over IPC and has no way to write them, so the LLM can never change a rule. Rules that are too broad (`*`), allow rules for destructive, credential or payment actions, and allow rules for `open_application` are refused. Scopes match on a boundary: `D:\Work` covers `D:\Work\a.md` but not `D:\Workshop`. A call's scope is its resolved `path`, or the host of its `url`. A call with several targets gets no scope, so it asks.
- **Activity** shows what is running now, followed by the last 100 entries of `action_log`. Each entry shows its decision, the rule that allowed it, the input, and the evidence or error. Tool output appears only as text.
- **Stop all:** the tray item ("Stop all automation"), the global hotkey **Ctrl+Alt+P** and the Stop all button all do the same thing. They silence playback, abort the reply and any in-flight tool call (an MCP cancellation), decline every pending approval, and pause automation. While paused, no tool runs, not even one a rule allows. A banner offers Resume, and the hotkey toggles pause back off. Pause is held in memory: it survives a runtime restart but not quitting the app.

## Voice

- **Talk:** tap the mic (or Ctrl+Space). Listening ends by itself about 1.3 s after you stop speaking (energy-based, with the room's noise level learned in the first 300 ms); tap again to send early, Esc to cancel. The recording goes renderer → main → host, and the host sends it to ElevenLabs Scribe, so the renderer never holds a key.
- **Urdu:** STT is pinned to Urdu when the owner picks Roman Urdu, Urdu script or a mix in Personality; with "Follow me" it uses the first non-English `ASSISTANT_LANGUAGES` entry. Spoken Urdu and Hindi sound alike, and auto-detection otherwise writes Urdu in Devanagari.
- **Spoken replies:** the host splits the streaming reply into sentences and synthesizes them one at a time, while the LLM keeps streaming. Each sentence reaches the renderer as one MP3 and plays strictly in order. Markdown, code and URLs are not read aloud. Quiet mode and the speaker toggle (saved in `setup.json`) keep replies on screen only.
- **Interrupting:** Stop, Esc, sending a new message or starting to talk silences playback at once and aborts the in-flight LLM and TTS requests.
- **Failures:** a TTS error (credits, a paid-only voice, rate limits) skips speech for that reply with a short note; text always arrives. Mic permission is granted only to the companion window and only for audio. If it is unavailable, the app says how to fix it and typing still works.
- **Testing without speaking:** build, then run Electron with Chromium's fake capture device. Feed it a 16 kHz mono WAV with a few seconds of silence at the end:

  ```
  pnpm --filter @assistant/desktop build
  apps/desktop/node_modules/electron/dist/electron.exe apps/desktop --use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=C:path	oclip.wav
  ```

## First run and personality (plan sections 10 and 15)

- **Onboarding:** once the keys pass, a fresh data directory starts a short scripted conversation in the companion: reply language, what to call the owner (e.g. "Boss"), the assistant's name, humour, reply length and how firmly to disagree. Questions are shown and spoken; chips answer the choices, and names can be typed or said (STT only, the field fills in for review). Every step has Skip, and "Skip setup" ends it. The answers are saved as one profile version, then the assistant greets the owner in the chosen language. The first-of-day briefing waits until onboarding is done.
- **Setup › Personality:** edit the same settings, undo (walks back through changes), reset to defaults (undoable), export the profile and its history as JSON, and run the intro again.
- **Storage:** append-only `personality_version` rows in the runtime's SQLite database (`MemoryStore.personality*`); onboarding state is separate, so a reset does not re-run it.
- **Prompt:** the system prompt is two cached blocks, the byte-stable identity (`packages/runtime/src/persona.ts`) and an owner profile block written from fixed wording. Names are limited to letters, digits, spaces and `. ' -`, the profile cannot touch safety rules, approvals or limits, and the model has no tool to change it. The first reply after a change gets a one-off context note so it doesn't apologise for earlier replies.
- **IPC:** `window.personality` (`src/shared/personality.ts`), validated in `src/main/personality.ts`. Onboarding speech is requested by question key; the spoken text comes from a fixed table in main, never from the renderer.

## Speaking up (plan sections 6 and 9)

- **Signals:** `src/main/session.ts` watches `powerMonitor` (lock/unlock, suspend/resume) and polls `getSystemIdleTime` (5 min without input = away) and forwards typed `session` messages to the host. A (re)started runtime is told whether the owner is away, so it never speaks to a locked screen.
- **Events:** `src/runtime/initiative.ts` turns app start and each return (unlock, resume, coming back from idle) into `session.first-of-day`, plus `session.return-from-idle` after 15+ minutes away. Every 30 s it raises `commitment.due` for open tasks and commitments that are due. Each event goes through `Assistant.considerEvent`, so `packages/initiative` still owns dedup, cooldown, the daily budget, quiet hours (`ASSISTANT_QUIET_HOURS=22:00-07:00`) and modes. Decisions are stored, so repeated unlocks never repeat the briefing. A spoken briefing covers overdue tasks, so they don't also get separate reminders. Each due item reminds at most once.
- **Channels:** *speak* streams through the normal sentence TTS as an assistant-initiated message. A closed window reopens without stealing focus and flashes in the taskbar; main holds reply events until the companion calls `ready()`. *notify* shows a silent Windows notification. *notify* and *queue* items also land in the companion's **Later** list (Tell me / Not now / Don't remind me again / Dismiss). Nothing is delivered over an owner turn or while away.
- **Owner controls:** under every unsolicited message: *Why did you say this?* (the policy's reason), *Not now* (back in 30 min), *Don't remind me again* (mutes that reminder for good; the task stays), and *Stop* while it speaks.
- **Privacy:** lock and sleep stop playback and the mic at once (main → renderer) and abort the in-flight reply and TTS (host). Quiet mode and the speaker toggle keep everything on screen.
- The Later list and snooze timers live in the runtime's memory. A restart clears the list, but stored decisions and mutes persist in `initiative_log`.

## Not yet

Streaming audio within a sentence (today each sentence is synthesized whole before it plays), wake word and hands-free continuous listening, a model-based VAD, Today/Projects/Memory surfaces, run-at-login, packaging.
