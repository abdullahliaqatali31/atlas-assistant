# Atlas polish plan: map reliability, a calmer chat, presence everywhere

Written 2026-10-19 from the owner's report (screenshots of the Conversation
drawer, an initiative card and the Ships panel). Five problems, five phases,
each small enough to ship and check on its own.

## What was reported, and what the code says

| # | Reported | Cause found |
|---|----------|-------------|
| 1 | Conversation header and cards feel cramped; chat text too big; no way to change it | The drawer header holds a status, the mode switch and six icons in one row; at drawer width (~440 px) the last icon is clipped. Bubbles are a fixed `text-sm`, 80 % wide, with no owner settings. |
| 2 | Planes mostly appear only when zoomed in; no route line on select | Zoomed out, the map asks only for military aircraft (`dist 0`); zoomed in it asks one circle around the centre. ADS-B carries no route, so nothing draws one. |
| 3 | Ships show for a few seconds, then "Could not reach AISStream" | One WebSocket `error` puts the feed in a permanent error state that is never retried ("wait for a new key or a restart"). Past 4000 ships every message re-sorts the whole list, which makes the client slow enough for AISStream to drop it. |
| 4 | Want an assistant presence that shows on any view, and outside the app | Presence (orb, captions, stop) exists only inside the Conversation drawer's voice view. |
| 5 | While speaking, the Stop button is covered | The voice view draws a fixed 340 px orb; in a 440 px drawer the orb and captions push the End button below the fold. |

## Phase 1: ships that stay (main/ships.ts)

- Reconnect on any drop with backoff: 2 s, 5 s, 15 s, 30 s, 60 s, reset after a
  minute of good data. Only a rejected key stops the feed.
- Keep the last positions while reconnecting; the panel says
  "Reconnecting… showing last positions" instead of an error.
- Watchdog: no message for 45 s on an open socket means reconnect.
- Evict old ships in batches (500 at a time) instead of sorting per message.
- Tests with a fake WebSocket: drop → reconnect → ships kept; bad key → stop.

## Phase 2: every plane in view, and its route (main/world.ts, world/*)

- **Coverage sweep.** adsb.lol answers up to 1000 nm around a point (checked:
  3414 aircraft around Frankfurt). Cover the visible area with 1000 nm cells,
  nearest the centre first, one call every 1.5 s, each cell cached 45 s; planes
  fill in as the sweep runs, and the whole view refreshes about once a minute.
  Military worldwide stays on top. At world zoom this is ~30 cells.
- The flights note says how much of the view is covered ("18 of 24 areas").
- **Route on select.** adsbdb.com (free, no key) gives origin and destination
  airports by callsign (checked: DLH400 → FRA–JFK). On select: a great-circle
  line origin → plane (solid, flown) and plane → destination (dashed, to go),
  airport dots with IATA codes, and "FRA → JFK · Lufthansa" plus progress in
  the hover card and Inspector. Cached per callsign for 30 min; no route
  known means the trail only, as today.

## Phase 3: a voice view that fits (VoiceMode.tsx)

- The orb sizes to its container (container query units), never above
  280 px, never pushing the controls.
- Controls are pinned at the bottom and always visible; captions take the
  space left over and clamp with a fade.
- While speaking or thinking, a Stop button also sits in the drawer header.

## Phase 4: a chat that is yours (Companion.tsx, Initiative.tsx)

- **Header in two tiers.** Row 1: status dot, state, speak toggle, New chat,
  and a "More" menu (Earlier chats, Connections, Setup, Chat view). Row 2: the
  mode switch, full width, segmented. Nothing clips at any width.
- **Chat view settings** (saved per owner, applied as CSS variables):
  - Text size: Small 13 px · Normal 14 px · Large 16 px · Extra large 18 px
  - Density: Compact · Comfortable
  - Style: Bubbles · Minimal (no boxes, a thin accent line for Atlas)
  - Width: bubbles 70 % · 85 % · full
- **Initiative cards** (the "aaj ka kaam" card): smaller type, the reason folded
  under "Why?", Not now / Don't remind as small text buttons on one line.

## Phase 5: Atlas presence, in the app and on the desktop

**In the app.** A floating presence pill on any stage (Home, World, drawers)
whenever Atlas is listening, thinking or speaking and the Conversation drawer
is closed: mini orb, one caption line, Stop. Drag it anywhere; it snaps to the
nearest edge and remembers where it was. Click opens the conversation.

**On the desktop (yes, Electron can do this).** A second, small, frameless,
transparent, always-on-top window, separate from the main window:

- Shapes itself to what it shows, growing and shrinking smoothly:
  - **Dot** (56 px): idle, a quiet orb; hover shows the time and one line.
  - **Pill** (~320×64): listening / thinking / speaking with caption and Stop.
  - **Card** (~360×auto, max 420 px tall): when Atlas speaks up (initiative)
    or asks for approval: text and Haan / Nahi buttons.
- Drag to move; the position is remembered per display. Right-click: Open
  Atlas, Hide widget, Size (S / M / L).
- Setting **Desktop widget**: Off · When Atlas is hidden or minimised (default)
  · Always.
- Same security as the main window: sandboxed renderer, its own small preload
  that exposes only presence state, stop, open and approval answers. The owner
  lock applies: when locked, the card shows nothing private.
- Light: no map, no polling; it only listens to presence events from main.

## Order and checks

Phases go in order 1 → 5; each ends with `pnpm check` and a commit. Phase 5
also needs a hands-on check by the owner (drag, sizes, multi-monitor).

## Phase 6: the glass panel (added 2026-10-19)

Owner's ask: say "aaj ki news dikhao" and see it beside the widget; "number 3
ki detail" opens it in full with its picture; "Karachi ka map" shows a map
with the same live layers as the app's World map; "side pe karo" puts it away.

- **Widget fix first.** The idle orb grew on hover, which moved the window
  under the cursor (open/close loop), and OS drag regions swallowed clicks.
  Now press-and-move drags (main follows the cursor), a press is a click, and
  size changes only with what Atlas is doing.
- **Invisible glass.** The panel window is fully transparent; only its pieces
  are drawn: smoky cards behind text, a thin neon edge in the owner's accent,
  soft glow and a top sheen. Clicks on see-through space fall through to the
  desktop. (Acrylic blur was dropped: Windows turns it solid whenever the
  window is unfocused, and this panel never takes focus.)
- **Placement.** Stacked above the widget (below it near the top of the
  screen), on the widget's corner edge, so orb ↔ pill changes do not move it.
- **Atlas drives it** with glass_show (news, story, map, note) and
  glass_close, through the window's `ui` requests; main fills news from its
  own feeds and validates every request. Observe-class: no asking.
- **The map** draws the app's own layer registry (flights, ships, quakes,
  natural events, disasters, places, cameras, satellites) for the layers the
  owner has switched on, from main's World service, and shows a card on click.
