# apps/desktop

The Atlas app: the gateway, the runtime, the tray helper and the web page. Despite the folder name there is no Electron; see [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

```bash
pnpm dev                                   # from the repo root: build, run, reload on change
pnpm --filter @assistant/desktop build     # out/gateway (Node) and out/renderer (the page)
pnpm --filter @assistant/desktop start     # run the built gateway
pnpm --filter @assistant/desktop run pack  # release/atlas-<version>-win-x64.zip (build first)
```

| Folder | What |
| --- | --- |
| `src/gateway` | Entry point of the gateway process; registers every handler. |
| `src/main` | Gateway services: web server, settings, browser, files, apps, PC map, Voice ID, timers, Telegram, world data, backups, the host shim and tray. |
| `src/runtime` | The runtime process: assistant, memory, tools, initiative, learning. |
| `src/shared` | Types and pure logic used by both sides and the page (validated channels, instant commands, consent wording…). |
| `src/renderer` | The React page. |
| `bin` | The `atlas` command and the hidden-start script. |
| `scripts` | Dev runner, release packer, icons. |
