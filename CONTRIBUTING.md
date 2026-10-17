# Contributing

1. `pnpm install`, then `pnpm check` must pass before a pull request.
2. Read [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md); the behaviour contract (section 4) and permissions (section 14) are not negotiable in code review.
3. New tools declare their action class, side effects, timeout and verification method. Third-party tools start disabled.
4. Tests cover failure paths, not just the happy path. Scenario tests live in `tests/scenarios`.
5. Update `docs/roadmap.json` when you start or finish a roadmap item.

## Claude Code devkit (optional)

`tools/claude-devkit` is a Claude Code mod for working on this repo: a live **Roadmap** pane drawn from `docs/roadmap.json`, a phase status line, a `/roadmap` command, and a guard that refuses to write real provider API keys into tracked files. Load it with:

```bash
claude --plugin-dir tools/claude-devkit
```
