# Performance: making the web interface light and smooth

Audit of 22 October 2026: the page measured idle per view (Chrome DevTools
Protocol: CPU time, layouts, heap, WebSocket bytes and which calls made them),
plus three code reviews (2D map and world data, 3D globe, app shell and
server). Numbers are from a headless Chrome drawing in software, so drawing
costs are higher than on a real GPU; the ratios are what matter.

## Measured, before and after (10 s idle per view)

| View | CPU before | CPU after | Data before | Data after |
| --- | --- | --- | --- | --- |
| Brain (home) | 30 % | 18 % | 43 KB/s | 0 KB/s |
| Profiles | 13 % | 6 % | 293 KB/s | 4 KB/s |
| Browser (a still page) | 9 % | 1 % | 36 KB/s | 0.1 KB/s |
| World (first visit) | 56 % | data cached on the next visit | 913 KB/s | about a quarter on the wire (compressed) |

Served page files: 39.4 MB → 10.5 MB (gzip). 3D chunk: 4.65 MB → 4.03 MB.

## Techniques used

**Send less**
- WebSocket compression (permessage-deflate, no context takeover, so memory
  stays flat; compressed off the main thread; small messages sent as they are).
- Atlas's browser picture: only while its panel is shown; the page sends the
  last picture's fingerprint and the gateway answers "unchanged" instead of a
  new JPEG; a still page is looked at every 2.5 s instead of 0.9 s. Its 5-minute
  idle close now works again (the hidden page kept it awake: ~450 MB).
- Large slow lists (19,000 cameras, 30,000 fires) asked once and shared by
  every panel for an hour / 30 min.
- Gzip copies of the page's files made at build time (`scripts/compress.mjs`),
  ETag and 304, long cache only for hashed files; model files streamed.
- Bursts of control changes (a tool starting and ending) sent once.
- The intel feed (GDELT) rests after 30 minutes with nobody looking.

**Do less on the page**
- Messages parsed with plain `JSON.parse` unless they carry bytes or Atlas
  addresses (the reviver ran on every value before).
- Planes: card fields worked out once per fix; between polls only positions
  change; 10 moves a second only at street zoom, ~3 at country zoom.
- Nothing re-renders unless a value changed: the picked item, layer counts,
  the side panel's counts and filters, ships (redrawn only when one moved),
  the intel overlay (only after a style change).
- Satellites in 3D computed in a Web Worker; the globe's half-second
  re-render replaced by small components with their own timers; renders
  requested only when something moved; WebGL context released on close.
- Mic level kept out of React state (a small store), so the conversation does
  not re-render 25 times a second; messages and Markdown memoized; only the
  newest 150 lines drawn; one shared task list instead of four 60 s polls;
  panel drag moves with a CSS transform and commits on release.
- Timers that ignored a hidden window now pause.

**Paint less**
- No `mix-blend-mode` grain over the map (it re-blended the whole pane every
  frame); the aurora behind frosted panels holds still (a moving background
  makes every backdrop blur redo itself); map chips solid instead of frosted;
  decorations pause while the map moves; story dashes march for 8 s, not forever;
  the traffic canvas rests when there are no cars; the brain draws at a calm
  20 fps (10 when another app has the focus), full rate only while busy.
- Browser overlay placed on resize and drag, not by a per-frame layout read.

## Next, in order of expected gain

1. Flights as a compact column format (typed arrays) and only what changed
   since the last poll; `GeoJSONSource.updateData` for positions.
2. Planes drawn by a custom WebGL layer that moves them on the GPU from
   (position, track, speed, time), no per-tick `setData` at all.
3. Camera thumbnails as cached HTTP URLs instead of data URLs in JSON.
4. Display colour modes (thermal, NVG) as a shader instead of a CSS/SVG filter.
5. Lazy-load Setup and the Radix select; split `PausedBanner` and `useNews`
   out of the Controls and News chunks so they leave the first load.
6. Unused Cesium assets (NaturalEarthII, maki, lens flare: ~1.4 MB) out of the copy.

## How to measure again

`scratchpad`-style scripts drive the page through the DevTools protocol:
click a view, wait, then read `Performance.getMetrics` and count WebSocket
frames by channel over 10 s; `Profiler.start/stop` for the heaviest functions.
Start Chrome with `--remote-debugging-port` against `http://localhost:47800`.
