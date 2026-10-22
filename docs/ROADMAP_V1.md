# Atlas v1 roadmap (October 2026)

Built from three studies: an audit of this repo, the architectures of
OpenClaw and Hermes Agent, and current on-device voice and hybrid-AI
practice. Each phase ships on its own, gated by `pnpm check`. Order of work: 1, 6 (web interface, moved up by the owner), 2, 3, 4, 5, 7; all done.

## Phase 1 — Voice you can hear, that hears you (done)

- Playback chain for every spoken reply: make-up gain, 100 Hz high-pass,
  +2.5 dB presence shelf at 3 kHz, a gentle compressor, a limiter, a ceiling
  at about -1 dBFS. Each sentence is levelled to one loudness, so voices and
  sentences never jump.
- Loudness setting (Normal, Loud, Max) and output-device choice (setSinkId).
- Listening: an adaptive noise floor that keeps learning (not 300 ms once),
  a pre-roll so the first syllable is never cut, a microphone level meter
  with a "mic too quiet" hint.
- One microphone stream shared by recording and barge-in, and playback in the
  same audio context, so echo cancellation removes Atlas's own voice.
- Barge-in in live voice too.

## Phase 2 — Who is speaking (done)

- Speaker embeddings on the PC (sherpa-onnx; ERes2Net base, 40 MB, Apache-2.0:
  CAM++ did not separate voices in our test) in the gateway. Enrolment of the owner (about 30 s, 5 phrases) and
  optional family members. Only embeddings are kept, encrypted; "forget my
  voice" deletes them.
- Atlas knows who spoke: greets people by name, personal answers only to the
  owner, others treated as guests. Never used as a lock for payments, sends
  or deletes (voices can be cloned): those still need the owner's yes.
- Wake word checked against the owner's voice, so a TV does not wake it.

## Phase 3 — Memory, readable and smarter (done, except the flush before compaction and the size cap)

- SQLite stays the source of truth. A Markdown mirror the owner can read and
  edit: `MEMORY.md` (short, always in context), `USER.md`, `memory/YYYY-MM-DD.md`
  (daily notes); edits flow back.
- Hybrid recall: FTS5 keywords plus local embeddings (multilingual, so Urdu
  and English paraphrases meet), recent notes weigh more, the brain's links
  pull in neighbours.
- Memory flush before a long chat is compacted; a size cap on the always-on
  summary; an "edit what you learned" page.

## Phase 4 — Decide fast, without asking the LLM every time (done)

- Tier 0 (done): exact short phrases in English and Roman Urdu answered at once,
  offline: time, date, stop, modes, pause/resume automation, louder/softer,
  open a page, set a timer. Anything longer goes to the model.
- Tier 1 (tried, not kept): an embedding router (e5-small) misrouted everyday
  Roman Urdu ("mujhe map dikhao zara" went to tasks; "browser mein youtube
  kholo" lost the site), so exact phrases plus the model win.
- Rules and learner (done): quiet hours, a daily limit and a minimum gap set by
  the owner (Settings > Personality); a Beta-Bernoulli learner per kind and
  time of day (reactions fade over 14 days) turns unwelcome routine speak-ups
  into quiet notices. Shown and resettable in Learning > Your memory.

## Phase 5 — More hands (done, except OAuth sign-in for remote connectors)

- Telegram bot (official API): talk to Atlas from the phone, receive its
  notices, approve actions. Owner-only by pairing code.
- Email send and calendar write (with approval), remote MCP (HTTP) with
  sign-in, screen vision (screenshot + read), timers and alarms, commitments
  tool, quiet hours in the UI, skills in the shared SKILL.md format (checked
  before install).

## Phase 6 — Web interface (done)

- A local server in Atlas (loopback by default, paired devices only) serves
  the same interface in any browser: home and brain, world maps, news,
  profiles, notifications, PC status, chat and voice. Data still comes from
  the desktop app on the PC; the PC must be on.
- Atlas's own browser appears as a live picture you can click.
- Then (owner's choice) Electron went entirely: Atlas is one Node process,
  the gateway, serving this page; a PowerShell tray keeps the icon, notices,
  global shortcuts and lock/sleep/idle; Atlas's browser is the PC's Chrome or
  Edge through Playwright. One-command install (install.ps1 + the atlas
  command), about 260 MB of memory instead of about 1 GB.

## Phase 7 — Open-source ready (done, except code signing and the repo address)

- Done: no personal data in code or tests (made-up names, places and
  companies); time zone and language follow the PC and onboarding.
- Done: README, docs/ARCHITECTURE.md, CONTRIBUTING.md, SECURITY.md; CI on
  GitHub (typecheck, tests, build on Windows) and a release workflow (tag
  v* → draft release with the zip and install.ps1); issue and PR templates;
  licence inventory lists the downloaded models.
- Done: `atlas update` (and `--check`) installs the latest release.
- Published at github.com/abdullahliaqatali31/atlas-assistant from a fresh
  history (the old commits with personal test data stay private). Left: code
  signing needs a certificate.
