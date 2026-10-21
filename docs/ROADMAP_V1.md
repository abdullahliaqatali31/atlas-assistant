# Atlas v1 roadmap (October 2026)

Built from three studies: an audit of this repo, the architectures of
OpenClaw and Hermes Agent, and current on-device voice and hybrid-AI
practice. Each phase ships on its own, gated by `pnpm check`. Order of work: 1 (done), 6 (web interface, moved up by the owner), 2, 3, 4, 5, 7.

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

## Phase 2 — Who is speaking

- Speaker embeddings on the PC (sherpa-onnx, CAM++ 28 MB, Apache-2.0) in a
  utility process. Enrolment of the owner (about 30 s, 5 phrases) and
  optional family members. Only embeddings are kept, encrypted; "forget my
  voice" deletes them.
- Atlas knows who spoke: greets people by name, personal answers only to the
  owner, others treated as guests. Never used as a lock for payments, sends
  or deletes (voices can be cloned): those still need the owner's yes.
- Wake word checked against the owner's voice, so a TV does not wake it.

## Phase 3 — Memory, readable and smarter

- SQLite stays the source of truth. A Markdown mirror the owner can read and
  edit: `MEMORY.md` (short, always in context), `USER.md`, `memory/YYYY-MM-DD.md`
  (daily notes); edits flow back.
- Hybrid recall: FTS5 keywords plus local embeddings (multilingual, so Urdu
  and English paraphrases meet), recent notes weigh more, the brain's links
  pull in neighbours.
- Memory flush before a long chat is compacted; a size cap on the always-on
  summary; an "edit what you learned" page.

## Phase 4 — Decide fast, without asking the LLM every time

- Tier 0: fixed phrases (stop, louder, what time) answered at once, offline.
- Tier 1: a small local embedding router matches everyday commands to tools
  in milliseconds; the LLM handles the rest.
- A rules engine for hard limits (no interruptions in meetings, at most N an
  hour); a small learner (contextual bandit) picks when to speak up within
  those limits. "The LLM proposes, the rules decide."

## Phase 5 — More hands

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
- Atlas's own browser appears as a live picture you can click. The widget,
  glass panel, tray, global shortcuts and Windows Hello stay desktop-only.

## Phase 7 — Open-source ready

- No personal data in tests or code; locale defaults chosen at onboarding.
- README, architecture, user and developer guides; CI on GitHub (check,
  tests, lint); code signing and auto-update; skill and connector review.
