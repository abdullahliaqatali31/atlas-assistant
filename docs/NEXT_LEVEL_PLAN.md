# Atlas, next level: what we learned from God's Eye View and REA, and where we go

Written 2026-10-20. Two open-source projects were studied file by file (both
MIT, so code and ideas can be reused with credit in THIRD_PARTY_LICENSES):

- **God's Eye View (GEV)** — github.com/bilawalsidhu/gods-eye-view, a browser
  3D-globe OSINT app with a voice controller. ~2,100 files: 25 map layers, a
  voice module, a key manager, server proxies, display modes.
- **REA, "Reverse Engineer Anything"** — github.com/morluto/rea, one MCP server
  (and CLI) that lets an AI agent take apart binaries, Electron/JS apps,
  websites, APKs and network captures, returning evidence.

The first half says, feature by feature, what GEV does, how it works, what
Atlas already has, and how we would build it. The second half is the new
idea: an assistant nobody has quite built yet, and the order to build it in.

---

## Part 1 — God's Eye View, feature by feature

### 1. Keys and onboarding ("POWER UP")

**What it is.** A panel listing every service the app can use. Each row: name,
one sentence of what it unlocks ("Live ships, worldwide"), a cost dot (🟡 free
key, 🔴 metered/paid, 🟢 no key), a "browser-side" badge when the key ships to
the page, a green light when set, and a link that says **GET KEY ↗** before you
have one and **MANAGE ↗** after (straight to the provider's key page). A
password box per key, SAVE KEYS, REMOVE with a confirm. A chip in the corner
says "POWER UP · 3 KEYS WAITING" and disappears when all are set.

**How it works.** One frozen registry drives everything (panel, CLI doctor,
"needs X" hints, save validation):

```js
{ id: 'tomtom', title: 'TOMTOM', unlocks: 'Real live traffic (keyless runs a simulation)',
  getUrl: 'https://my.tomtom.com/keys', envVars: ['TOMTOM_API_KEY'], tier: 'free', clientExposed: false }
```

The server reports only *whether* each key is set (never values, never the
last four characters). Keys set outside the app (environment, keychain) show
as "CONFIGURED EXTERNALLY", read-only, and the server refuses to overwrite
them. Saving is atomic, locked to the user's account (on Windows via icacls,
verified). Format checks only — no live test call. **Nothing is required**:
"The globe already flies keyless." First run offers four *missions* (Live
contacts, Space missions, Environmental, Explore) instead of a key form.

**Atlas today.** Keys live in the Windows credential store (better than GEV's
.env file); Setup asks for the LLM and voice keys; AISStream and Windy keys are
pasted in their map panels; OpenSky is a checkbox. There is no single place
that lists everything, what it unlocks, and where to get it.

**How we build it (small, high value).**
- `shared/providers.ts`: one registry (id, title, unlocks, getUrl, manageUrl,
  secretName, tier free/metered/paid, keyless fallback text, which features
  need it). Rows: LLM providers (Anthropic, OpenAI, Gemini, OpenRouter,
  Ollama…), ElevenLabs, Azure Speech, OpenAI voice (new, below), AISStream,
  Windy Webcams, OpenSky, NASA FIRMS, Launch Library, Cesium ion (if we add
  3D), Google Maps (optional).
- **Setup › Power up** page built from it; a "N keys waiting · what they
  unlock" chip on the rail; every feature that needs a key says "Needs X — add
  it in Power up" with a link (GEV's `keyGuidance`).
- Better than GEV: a **Test** button per key that makes one cheap real call
  (list models, one AIS handshake) and turns the light green only on success;
  and a **monthly cost estimate** per metered key from the usage meter.

### 2. Voice: how GEV talks without ElevenLabs

**What it is.** One speech-to-speech model — **OpenAI Realtime**
(`gpt-realtime-2`, or the 3× cheaper `gpt-realtime-2.1-mini`, voice "marin") —
over WebRTC straight from the page. No separate speech-to-text → LLM →
text-to-speech chain, so it answers in well under a second and sounds natural.

**How it works, and the clever parts.**
- The server holds the real key and mints a **short-lived client secret** per
  session with the model, voice, instructions and tools baked in, so the page
  can never change them.
- **Semantic turn detection** (it hears when you finished a thought, not just
  silence), low eagerness, and **no automatic barge-in** — you interrupt by
  holding Space, so room noise never cuts it off.
- **Hold Space to talk** (push-to-talk) or open mic. No wake word.
- **Model tier switch in the chat** (STANDARD / MINI), remembered; the server
  maps the tier to a model id so the page never sends a raw id.
- **Live cost meter** with a soft warning at $2 and a hard stop at $5 per
  session; unknown models are priced at the most expensive rate.
- **Hiding tool latency**: a soft two-note "earcon" after 0.7 s, then short
  spoken progress lines ("Finding the Capitol, then outlining its grounds")
  sent *outside* the conversation so they don't pollute history or the cache.
- **Tool results split into `say` (≤ 25 words, spoken) and `display` (shown on
  a card)**, plus numbered referents so "the second one" works later.
- **Seeing**: on "what is this?", one screenshot (JPEG, ≤ 200 KB) or a crop
  around the cursor is added; the previous image is deleted first, because
  images are re-billed every turn. Where you were pointing is captured when
  you *start* talking, because people point before they speak.
- **Context trimmed** (keep 50 %, 3k-token instructions) to keep cost flat.
- The same tools are exposed over **MCP**, so Claude Desktop can drive the globe.

**Atlas today.** Wake word, Whisper-style transcription, Claude (or any LLM)
with quick/main routing, ElevenLabs or Azure voices, barge-in by talking over.
Strong brain, but three hops and paid voices.

**How we build it.**
- A third voice engine: **"Live voice (OpenAI Realtime)"**. Main process mints
  the client secret (key stays in the credential store); the renderer opens the
  WebRTC session. Default tier MINI.
- **Brain stays Claude.** The realtime model handles the conversation and
  quick tools; for anything real (memory, files, Full control actions, code)
  it calls one tool, `ask_atlas`, which runs Atlas's normal turn and returns
  `{say, display}`. Fast chat, same capabilities, same permission gate.
- Copy: semantic VAD + hold-Space push-to-talk (keeps our wake word too),
  earcon + out-of-band progress lines, say/display split for all tools,
  per-session cost meter with warn/cap in the Usage card, one-image rule.
- Cheaper fallbacks for people without OpenAI: Azure F0 (free tier, has Urdu
  voices) stays the default; ElevenLabs optional; later a **local** voice
  (Kokoro/Piper) for zero cost.

### 3. Model switching in the chat

GEV: a STANDARD/MINI button. **Atlas** already routes quick vs main model; add
a **model chip in the Conversation header** (provider · model, e.g.
"Claude Opus 5.5 · auto"), a menu of the providers whose keys are set, with
"Auto (quick + main)", and a per-chat override. Remembered per chat.

### 4. Map layers (25) — what Atlas lacks, ranked by value ÷ effort

Atlas already has flights (adsb.lol sweep + adsbdb routes), ships, satellites,
quakes, EONET events, GDACS, public cameras, Windy webcams, news on the map.

| # | Layer | Source | Key | Effort | Notes |
|---|---|---|---|---|---|
| 1 | Military flights, re-tinted amber; emergency squawks red | adsb.lol `/v2/mil` | none | S | Atlas fetches /mil already; just style + FL labels |
| 2 | Smooth aircraft motion | none | none | S | Dead-reckon between polls (≈12 Hz), turn arcs, slew cap, 900 ms blend of jumps |
| 3 | Nearby contacts panel ("250 km") + Live signals feed | our layers | none | S | Join flights/ships/sites near a pick or me, with sources; great for voice ("what's near me?") |
| 4 | Space missions (30 days) | Launch Library 2 | none (15/h) | S–M | Pads + list now; replay animation later |
| 5 | Weather radar, IR clouds, lightning; cyclone cones | NOAA nowCOAST WMS, NHC | none | S | Raster sources fit MapLibre directly |
| 6 | Active fires + fire perimeters | NASA FIRMS (free key), NIFC | FIRMS key | S | GeoJSON |
| 7 | GPS jamming map | adsb.lol NIC/NACp, GPSJAM-style 0.5° cells | none | M | Very "OSINT", unique |
| 8 | World radio | Radio Browser | none | S | Click a city, hear its radio; tuner with static |
| 9 | Wind particles | NOAA GFS byte-range GRIB | none | M | MapLibre wind plugins exist |
| 10 | More cameras | Fintraffic, Vegvesen HLS, DriveBC, NSW, WSDOT… | none | S each | Atlas already has the camera machinery |
| 11 | Installations, datacenters, dams, submarine cables | bundled OSM/Overture | none | M | Cables are non-commercial licence |
| 12 | Transit (GTFS-RT), bikeshare (GBFS) | 16 + 30 feeds | none | M | City-specific; nice locally |
| 13 | Recent satellite imagery A/B swipe | NASA GIBS | none | M | We already use GIBS for "Today" |
| 14 | 3D photoreal planet, 3D aircraft, cockpit view | Google 3D Tiles / Cesium | metered | L | Needs a 3D engine; see 5 |

### 5. Display modes and the HUD

**What it is.** Visual modes as full-screen shaders: Night Vision (PVS-14
green, noise, honeycomb), FLIR thermal (white-hot / ironbow), CRT terminal,
anime, noir, snow; 500 ms crossfades; keys 1–7. A **scope vignette** (a 2D
canvas radial gradient, repainted only on resize — no per-frame cost). A
tactical HUD: classification banner, ┌┐└┘ corner brackets, blinking REC + UTC,
MGRS coordinates, GSD and NIIRS computed from altitude, sun elevation. HUD
layouts Tactical / Operator / Minimal / Cyber (sonar sweep).

**Label budget.** Not "draw every label": a budget table by zoom band ×
density (e.g. street 9→90 labels, global up to 56), split across layers
(ELASTIC: equal shares, unused share redistributed), solved every 125 ms,
reprojected every frame, with stable identity so labels never flicker.

**Polish details.** Loading chips appear only after 160 ms (no flash), stay
2.2 s on success, 5 s on failure; split-flap "departure board" text; map
provider failures fall back to a free map and retry in the background (30 s
doubling to 10 min); idle render governor (no animation loop when nothing
moves — they measured 60 % GPU on an idle globe before); FPS readout on a key;
recording mode with 16:9 / 9:16 safe frames; shareable state links.

**How we build it in Atlas (MapLibre, Lite mode).**
- **World › Display**: modes Normal / NVG / Thermal / CRT / Noir as CSS
  filters + an SVG colour matrix + a noise/scanline overlay on the map element
  (cheap, Lite-safe); a WebGL post-process version for full mode later.
- **Tactical HUD** as a DOM overlay: corners, REC/UTC, lat-lon/MGRS of the
  centre, scale, sun elevation; layouts Tactical / Minimal; scope vignette as a
  CSS radial gradient.
- **Label budget** on top of MapLibre's collision: per-layer `symbol-sort-key`
  and a per-zoom cap; density slider in Display.
- 160 ms / 2.2 s / 5 s chip timing, background retry for map sources, an
  owner-keyed animation hold set (Lite never gets stuck animating), FPS on `.

### 6. Engineering habits worth copying

- One registry per concern (providers, layers, styles) driving UI, checks and
  tests — Atlas already does this for layers.
- Server/main owns secrets; the page gets short-lived tokens; rate limits and
  redacted logs on every metered call.
- A **doctor** (`pnpm doctor` exists in Atlas) that reports where each key was
  found without printing it — extend ours to the full registry.
- Tests that forbid expensive APIs, allocation budgets per frame, per-PR
  changelog fragments.

---

## Part 2 — REA, and how Atlas would use it

REA gives an AI agent evidence-backed answers to "how does this app do X?":
pseudocode and calls for native binaries (with Ghidra/Hopper/IDA), modules,
IPC and source maps for Electron/JS apps, page structure and network
observations for websites, decompiled APKs, network captures, SQLite files.

**For Atlas:** an **optional, off-by-default "Research lab" connector** in
Controls › Connections (it is an MCP server; Atlas already speaks MCP). Then
"Atlas, how does Notion's clipboard work?" or "study this repo/app and tell me
what we can borrow" becomes a skill Atlas can run on request — exactly what we
just did by hand. Guard rails: its tools stay *external-send*-strict (ask every
time) even in Full control, static analysis only by default, runtime capture
only when the owner names the target. Not for anything Atlas would do on its
own.

---

## Part 3 — The idea: Atlas, the companion that keeps getting better

Not a voice skin on a chatbot, and not a dashboard. A presence that lives on
the PC, knows the owner's world (their files, apps, people, places and the
planet outside), brings things to them, and gets measurably better every week —
with a sense of humour and the self-awareness to laugh at itself.

### The eight pillars

1. **"Bring me" — the courier.** Ask for *anything* and Atlas fetches it from
   wherever it lives: a file on the PC, an attachment in email, a WhatsApp
   document, a web page, a flight overhead, last month's invoice, the photo
   from Lahore. It lands on the glass panel with where it came from, and one
   tap opens, saves, shares or explains it. (Builds on the system map,
   connectors, WhatsApp tools, glass panel, Full control.)

2. **Night shift — it learns by itself.** While the PC is idle and charging,
   Atlas reviews the day: what it got wrong, what the owner corrected, what
   took too long, which jokes landed. It writes lessons, drafts new skills,
   **tests them in a sandbox** against the day's real requests, and in the
   morning shows one card: "I learned 3 things last night — keep them?"
   Nothing changes without a yes. (Builds on Learning, skills, improvements,
   usage meter; new: replay-based evaluation.)

3. **It keeps improving its own code.** For its own repository, Atlas files
   improvement briefs (exists), and with the owner's yes hands them to Claude
   Code in a branch, runs the tests, and shows the diff. A self-repairing
   assistant: when a feature breaks (a feed dies, a selector changes), it
   notices, finds the cause, and proposes the fix.

4. **Self-care: it watches its own health.** Memory, CPU, failing feeds, slow
   tools, rising costs — Atlas keeps a vitals card, restarts what hangs, falls
   back to free sources (GEV's background retry), and tells the owner only
   when it matters. "Main thoda thak gaya tha, khud ko restart kar liya."

5. **Humour with a memory.** A personality that jokes in the owner's language
   (Roman Urdu / English), learns their taste (which jokes got a "haha", which
   got silence), roasts itself when it fails ("Mera GPS bhi tumhare Wi-Fi jaisa
   hai — signal hai, location nahi"), knows when *not* to joke (quiet mode,
   bad news, late at night), and never repeats a joke the same week.

6. **Always there, never in the way.** Background running with a tiny footprint;
   the desktop widget and glass panel; Live voice with push-to-talk and the
   wake word; Full control when the owner wants Jarvis, Normal when they don't.

7. **The world as context.** The Atlas World map becomes a mission control the
   assistant narrates: "Three military aircraft over the Arabian Sea, a 5.1
   quake near Quetta, heavy rain moving into Lahore by 6" — with GEV-style
   display modes, nearby-contacts, live signals, radio, missions.

8. **Trust you can see.** Every action logged with undo; the owner can always
   see *why* it did something; Full control is amber and ends on lock; keys
   never leave the credential store; outside content can never make it act.

### What makes it different

Most assistants answer. Atlas **notices** (system awareness, the world,
initiative), **fetches** (the courier), **acts** (Full control), and
**improves itself overnight** (night shift) — and it is honest about each.

---

## Part 4 — Roadmap

Order chosen for value per effort; each phase ends with tests and a commit.

| Phase | What | Size | Needs from the owner |
|---|---|---|---|
| A | **Power up**: provider registry, Setup › Power up page with GET KEY / MANAGE links, tier dots, Test button, "N keys waiting" chip, "Needs X" hints | S | — |
| B | **Model chip in the chat**: provider · model picker, Auto (quick+main), per-chat | S | — |
| C | **Live voice (OpenAI Realtime)**: minted session, WebRTC, push-to-talk, semantic VAD, earcon + progress lines, `ask_atlas` bridge to Claude, cost meter warn/cap | M | an OpenAI key (Power up shows where) |
| D | **World, GEV-grade**: military styling + FL labels + emergency squawks, smooth motion, nearby contacts + live signals, Launch Library missions, NOAA radar/clouds/lightning + NHC cones, FIRMS + NIFC fires, Radio Browser | M | optional FIRMS key |
| E | **Display**: NVG / Thermal / CRT / Noir modes, tactical HUD, scope vignette, label budget, polish timings | M | — |
| F | **Courier ("bring me")** across PC, email, WhatsApp, web; results on the glass panel | M | connectors as wanted |
| G | **Night shift**: idle-time review, lessons, skill drafts, sandbox replay tests, morning card | M–L | — |
| H | **Humour memory + self-care vitals** | S–M | — |
| I | **Research lab** (REA connector, off by default) and self-repair briefs → Claude Code | M | REA installed (npx) |
| J | 3D globe / cockpit (Cesium or deck.gl), only if wanted after D–E | L | Google or Cesium key |

Phase A starts now.

---

## Part 5 — God's Eye View's signature features, one by one (added 2026-10-20)

The owner asked for every GEV feature, not only the layers. What GEV does,
and how Atlas gets it:

| # | Feature | GEV | Atlas plan |
|---|---|---|---|
| J1 | **3D globe** | CesiumJS; keyless = Esri World Imagery + Re:Earth terrain; Google key = photorealistic 3D cities; Cesium ion token (free) = world terrain + 3D buildings | A **3D view** on the World page (CesiumJS, loaded only when opened), same three tiers; Google and Cesium ion rows in Power up |
| J2 | **Live planes in 3D** | billboards everywhere, real glTF models (787, ATR 72, Cessna, Citation, Bell 206, MQ-9, ship) within 150 km, true altitude, gliding | Same: models (CC BY 4.0, credited) near the camera, icons elsewhere, at real altitude, gliding between polls |
| J3 | **Plane view (cockpit)** | camera rides the aircraft; speed/altitude rims, compass tape, horizon; FROM→TO flight plan; PREV/NEXT targets | **Fly with it**: chase and cockpit cameras, HUD with speed, altitude, heading tape and vertical speed, route card with progress, prev/next aircraft |
| J4 | **Plane navigation** | track, follow, orbit, fly-to, search, nearest | Track and orbit a plane, jump to the next nearby one, by click, keys or voice ("PIA301 ke saath udo") |
| J5 | **Satellite services** | ~840 sats in groups (stations, visual, GPS, GLONASS, Galileo, GEO), Starlink dense mode, orbits, follow camera | Same groups and filters, Starlink on demand, orbit paths at true height in 3D, follow a satellite |
| J6 | **Camera services** | ~20 keyless city/DOT packs; cameras as 3D frustums with the live frame projected | More keyless packs; in 3D, each camera's view cone with its latest frame |

Order: J1 → J2 → J3/J4 → J5 → J6. Each ends with tests and a commit.
