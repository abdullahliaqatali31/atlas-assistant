# Atlas UI redesign: "minimal by default, detail on demand"

Inspired by map-first tools (one living canvas, a slim rail of live counts,
detail panels that slide in), shaped for a personal assistant rather than a
surveillance map. Light on the machine: no heavy effects unless the machine can
afford them.

## 1. Principles

1. **One stage, nothing else by default.** The window shows a single canvas
   (Home or World) with a floating Ask bar. Everything else is one click,
   hover or keystroke away and goes away again.
2. **Detail where you look.** Selecting anything (a task, a story, a flight, a
   camera, a project, a file change) opens its card in the Inspector on the
   left, with the actions that make sense for it, including "Ask Atlas about
   this".
3. **Counts before content.** The right rail shows each module as an icon and
   a live number (1 task due, 3 servers running, 2 suggestions waiting, 12
   flights in view). Numbers change; the layout does not.
4. **Atlas can drive it too.** Every panel, the stage and the window size are
   reachable by Atlas's `ui_control` tool, so "news dikhao" or "compact ho
   jao" just works.
5. **Light.** Lazy-load every panel; the map only on the World stage; pause
   animations and polling when hidden; Lite mode turns off blur and motion.

## 2. Layout

```text
┌──────────────────────────────────────────────────────────────────────┐
│ ◉ Atlas · Online · Companion                 [⌘K Search]   _ □ ×    │ title bar (drag)
├────────────┬───────────────────────────────────────────┬─────┬──────┤
│ INSPECTOR  │                                           │DRAWER│ RAIL │
│ (left,     │                STAGE                      │(slide│ live │
│  on select)│     Home (calm)  or  World (full map)     │ in,  │counts│
│            │                                           │ pin) │      │
│            │        ┌───────────────────────────┐      │      │      │
│ mini orb · │        │ 🎙  Ask Atlas…        ➤   │      │      │      │
│ time · wx  │        └───────────────────────────┘      │      │      │
└────────────┴───────────────────────────────────────────┴─────┴──────┘
```

- **Title bar**: brand, status pill, mode, the command palette button (Ctrl+K).
- **Stage** (full bleed): `Home` (calm) or `World` (the map). Remembered.
- **Right rail** (64 px): module icons with live counts, a Stage switch
  (Home / World), Compact mode, Settings. Hover shows a tooltip with the
  number in words; click opens that module's Drawer.
- **Drawer** (380 to 460 px, slides in left of the rail): the module's full
  content (today's existing pages, restyled). Pin keeps it open beside the
  stage; unpinned it closes when you click the stage. One drawer at a time.
- **Inspector** (left, 340 px): the selected item's detail card. Closes with
  Esc or ×.
- **Ask bar** (bottom centre, floating): type or hold the mic. A reply shows
  as a compact bubble above the bar; "Open conversation" expands the full
  thread in a Drawer. Approval questions appear right here ("haan / nahi").
- **Corner widget** (bottom left): small orb, time, local weather and AQI for
  the first watched place. Click: Home.

### Responsive

| Width | Behaviour |
| --- | --- |
| ≥ 1400 | Stage + pinned Drawer + Inspector side by side |
| 1100–1399 | Drawer and Inspector overlay the stage edge |
| 640–1099 | Rail stays; Drawer and Inspector become full-height sheets |
| < 640 | Rail moves to a bottom bar; Drawer/Inspector full screen |
| Compact | 400×640 window: Ask bar + conversation only |

## 3. Modules (rail order, with their live count)

| Module | Count shown | Drawer content |
| --- | --- | --- |
| Conversation | unread replies | full chat thread, voice controls |
| Today | open tasks / overdue | tasks, commitments, follow-ups, briefing |
| World | alerts in 24 h | places, layer switches (stage becomes the map) |
| News | new since last look | categories, saved |
| Code | running servers | projects, run commands, status files |
| Files | changes today | folders, history, undo |
| Apps | apps under control | apps, Watch me |
| Learning | waiting suggestions | skills, memories, improvements |
| Alerts | in the last 24 h | world alerts, approvals, failures, in one timeline |
| Connections | links running / total | connectors, permissions, activity |
| Settings | – | setup, personality, security, themes, usage |

## 4. Stages

**Home (calm)**: centre: the orb (reacts to voice), time, greeting, one line
on what matters now ("WSL updates at 6 PM · Lahore AQI 145"). Below: up to
three "now" cards (next task, running server, top alert). No grid of
everything: that lives in the drawers.

**World (map)**: full-bleed map with layers (places, flights, ships,
satellites, cameras, earthquakes, events). Selecting a feature opens it in
the Inspector (camera frame, flight card, quake card) with "Centre on map",
"Ask Atlas about this" and "Watch this place".

## 5. Themes

Design tokens on `:root[data-theme]`, chosen in Settings (or follow Windows):

| Theme | Feel | Base | Accent |
| --- | --- | --- | --- |
| Midnight (default) | deep navy, cyan glow | #050a16 | cyan #22d3ee |
| Graphite | neutral dark, calm | #0d0f12 | soft blue #60a5fa |
| Aurora | vivid dark | #070816 | violet #a78bfa |
| Daylight | clean light | #f4f7fb | teal #0891b2 |

Plus an accent override (cyan, blue, violet, emerald, amber, rose). One
accent colour per theme; amber only for attention, rose only for danger.

**Lite mode** (auto-on for weak machines: ≤ 4 CPU threads or ≤ 4 GB memory,
or `prefers-reduced-transparency`): no backdrop blur, no aurora, no scanline,
reduced shadows, map at lower pixel ratio. Also follows
`prefers-reduced-motion`.

## 6. Interaction

- **Ctrl+K command palette**: pages, places, tasks, projects, files, apps and
  actions ("Compact mode", "Theme: Daylight", "Refresh world").
- **Keys**: Esc closes the Inspector, then the Drawer; `[` `]` cycle drawers;
  `G H` / `G W` go Home / World; `/` focuses the Ask bar.
- **Ask about this**: from any Inspector card; the item's summary goes with
  the question so Atlas answers about exactly that.
- **Motion**: 160–220 ms, transform and opacity only.

## 7. Performance budget

- First paint of the shell < 300 ms; each drawer lazy-loaded.
- Idle CPU near 0: polling only for visible things (flights 20 s, ships 8 s,
  satellites 2 s only on World and when the window is visible).
- No blur over the map; glass only on small floating surfaces.
- Long lists virtualised beyond 200 rows.

## 8. Build order

1. **Foundation**: theme tokens, theme and accent picker, Lite mode; the new
   shell (stage, right rail with counts, drawer system, inspector slot).
   Existing pages become drawers unchanged. *(done)*
2. **Ask bar** and conversation drawer (the chat panel becomes a drawer;
   replies show as a bubble above the bar). *(done: one thread through the
   conversation; streaming bubble; Haan / Nahi for waiting questions; mic)*
3. **Command palette** and keyboard shortcuts. *(done: Ctrl+K with pages,
   places, tasks, projects, apps, actions, themes and "Ask Atlas"; Esc, /,
   G H, G W, [ ])*
   Also done: the **mini rail** (16 px icons, small badges, 48 px wide) with
   **hover overview cards** (the top few items per module, read only while
   shown); a click opens the full drawer. Phone width gets a bottom bar that
   fits without scrolling.
4. **Home stage** (calm) and **World stage** with the Inspector for map items. *(done: Home is the orb, time, one line on what matters and up to
   three now cards; World is a full-bleed map with a floating toolbar, place
   chips, a layers popover and an Inspector (left; bottom sheet when narrow)
   for places, cameras, flights, ships, satellites, quakes and events, with
   Centre and Ask Atlas)*
5. **Alerts timeline** and the corner widget. *(done: Alerts in the rail with a count and hover card; one
   timeline of world alerts, waiting questions (Haan / Nahi in place), overdue
   tasks, failures and what Atlas raised, "Needs you" first, filter chips;
   corner widget on the World stage when it is wide enough)*
6. Restyle each drawer's content to the new density; responsive and
   performance pass; `ui_control` maps to stages and drawers.
