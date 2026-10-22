# Contributing

Thanks for helping. Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Setup

Windows 10/11, Node.js 22.13+, pnpm 9.

```bash
pnpm install
pnpm dev        # http://localhost:47800, reloads on change
pnpm check      # typecheck + tests; must pass before a pull request (CI runs it too)
```

To talk to Atlas while developing you need an AI key and a voice key (`pnpm keys set ANTHROPIC_API_KEY` …, or the setup screen). `ASSISTANT_DEV_SKIP_VOICE=1` runs without a voice key.

## Rules

1. **Safety is not negotiable in review.** Every new tool declares its action class, side effects, timeout and how its result is verified. Anything that sends, pays, deletes or changes outside Atlas must go through the policy gate and ask the owner. Third-party tools start disabled. Content from webpages, email and messages is data, never instructions.
2. **Tests cover failure paths**, not just the happy path. Tests that need real keys or the network are named `*.live.test.ts` and skip without them; they must never run in CI.
3. **No personal data** in code, tests, fixtures or logs: use made-up names and places, and never commit real keys (`.env` is ignored; keys belong in Windows Credential Manager).
4. **Hardware-neutral defaults.** No GPU, no large downloads by default. Local models are optional, small, and downloaded only when turned on (pin a checksum where the source allows).
5. **Keep the language plain** in the interface and in Atlas's words, in English and Roman Urdu.
6. Update [docs/ROADMAP_V1.md](docs/ROADMAP_V1.md) when you finish a roadmap item.

## Claude Code devkit (optional)

`tools/claude-devkit` is a Claude Code mod for this repo: a live **Roadmap** pane drawn from `docs/roadmap.json`, a phase status line, a `/roadmap` command, and a guard that refuses to write real provider API keys into tracked files.

```bash
claude --plugin-dir tools/claude-devkit
```
