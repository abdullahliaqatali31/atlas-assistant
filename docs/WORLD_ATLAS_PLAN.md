# World Atlas plan: a living map the assistant can drive

Status: plan, 2026-10-18. Builds on the World page from the UI redesign (docs/UI_REDESIGN.md §4).
Reference studied: argosatlas.com (landing page, sources & methodology, attributions, owner screenshots of the signed-in map).

## 1. The idea in one paragraph

Today's World page is a map you look at. The new one is a map **the assistant works on**. You say
"Atlas, show me what matters in the news today" and it pins the stories where they happen, joins related
ones with lines, opens a news canvas on the map, and talks you through them. You say "focus on the
Hormuz one" and the camera flies there, zooms, opens the card and pulls in the ships, flights, quakes and
cameras around it. The map does what Argos does, but nobody else's map has an assistant that remembers what you
care about, notices things on its own and explains them in your language.

## 2. What Argos Atlas is, and what we learned

**Stack.** A MapLibre GL 2D map with deck.gl overlays (seen in its bundle: `maplibre-*.js`, `deck-*.js`). The 3D
globe is a paid tier on CesiumJS. It is a server product: the site collects the feeds, the browser only draws.

**Data.** All from open sources, each credited on its card (methodology and attributions pages):

| Layer | Argos source |
|---|---|
| Basemaps | OpenFreeMap, OpenMapTiles, OSM, CARTO Dark Matter; imagery "Esri, Maxar, Earthstar Geographics"; Mapzen terrain |
| Cameras | official traffic and city portals (DOTs, 511, TfL, DGT…), latest frame only, no face or plate recognition |
| Flights | adsb.lol (ODbL) and OpenSky; tar1090 aircraft silhouettes |
| Ships | AIS (provider not named); AIS-off ("dark") ships drawn on an estimated course and flagged |
| Conflict | GeoConfirmed (verified events with media), UCDP history, frontlines (source not named; DeepState and ISW are cited in its blog) |
| AI intelligence | GDELT every 15 min plus an LLM reading the press hourly: geocoded items with 0-10 severity, risk zones, theatre summaries |
| Hazards | USGS quakes, NASA FIRMS fires, volcanoes, storms, WHO outbreaks |
| Infrastructure | power plants, airports (OurAirports), ports, data centres, dams, submarine cables |
| People and companies | Forbes net worth, company HQs, linked jets and yachts |
| Markets | Polymarket on the map, 15k stocks/ETFs/commodities/crypto, own "value signal" |
| Context | World Bank indicators, Natural Earth, OFAC sanctioned ships and aircraft |

**UX patterns worth taking** (from the screenshots):
- A **right rail of layers with live counts and one-key shortcuts** (A, V, O, F, B, S, C…). Click toggles; hover opens that layer's panel.
- **Layer panels with two tabs**, *Now* (what is happening in this layer) and *Layers* (filters). For example Ships → chokepoints with counts and a mix bar, sanctioned ships, AIS-off ships; Satellites → sky dome "above you", ISS crew, next visible passes, next launches.
- A **hover card on a leader line** ("Wildfire Craig Lake 1 · WILDFIRES · 10 d · click for more info").
- A **rich left card** for any selected thing, with "Centre on map", region and links onward.
- A **mini globe** bottom left showing the view footprint, with clock, UTC offset, weather and coordinates.
- A bottom **Ask bar** for the AI.
- **Basemap choice**: satellite, relief, dark; 2D map or 3D globe.
- **Every item cites its source; estimates are labelled as estimates.**

**What we will not copy:**
- **Keyless Esri imagery.** It is licensed for ArcGIS use only.
- **Data we may not redistribute:** GeoConfirmed, DeepState or ISW frontlines, TeleGeography cables, PeeringDB, Forbes, LiveATC audio.
- **Tracking named people's jets and yachts.** For a personal assistant this is stalking-shaped.
- **The "arbitrage / Buy YES" trading push.** We show odds as context, never a buy button or a "value signal" that reads as advice.

**Where we beat it.** Argos is a map with a chatbot box. We are an assistant with a map:
- It knows the owner's places, projects and interests.
- It decides what is worth interrupting for (the initiative engine).
- It speaks Roman Urdu or English.
- It can build a *story* on the map: pins, links, a narrated tour.
- It runs locally with no account and no server, using the owner's own keys where a source needs one.

## 3. Where our World page is today (verified in code)

- `apps/desktop/src/renderer/src/World.tsx` (874 lines, one file) uses MapLibre GL 5.24 with flat Mercator.
  - Basemap: OpenFreeMap dark, or positron for the Daylight theme, chosen once.
  - No satellite view, no globe, no terrain, no clustering.
- Layers are WebGL GeoJSON: quakes, EONET events, cameras, satellites (satellite.js), flights (adsb.lol, zoom ≥ 4), ships (AISStream with the owner's key) and places.
- **Hover changes only the cursor.** Click opens the Inspector (Centre, Ask Atlas, Source).
- Feeds:
  - Runtime `apps/desktop/src/runtime/world.ts`: Open-Meteo weather, air and geocoding; USGS; EONET; GDELT per place, every 15 min.
  - Main `apps/desktop/src/main/world.ts`, `ships.ts`, `cameras.ts`: flights, satellites, ships, cameras.
- **The assistant cannot touch the map.** Its tools are `world_places`, `world_place_add`, `world_place_remove` and `world_now`, plus `ui_control` to switch to the World page. It cannot pan, zoom, focus, pin, draw, toggle layers or open a card.

The foundation is right: MapLibre, every feed through main, untrusted text labelled. Three things are missing: the basemap choice, map control for the assistant, and the story and hover layer.

## 4. Target experience

### 4.1 Map styles: a real-world view by default

A style switcher sits on the map toolbar and in Ctrl+K. The choice is remembered, and Satellite is the default.

| Style | Source (keyless unless noted) | Notes |
|---|---|---|
| **Satellite** (default) | EOX Sentinel-2 cloudless 2016 (CC BY 4.0) raster; labels and borders from OpenFreeMap vector on top | real-world look out of the box; sharp to about z13 |
| Satellite HD | Esri World Imagery or another provider **with the owner's own key** | opt-in in Settings → Map; the key goes in the credential store |
| Today from space | NASA GIBS daily MODIS/VIIRS true colour plus clouds | "what the Earth looked like this morning" |
| Dark | OpenFreeMap dark | today's style |
| Light | OpenFreeMap positron | Daylight theme |
| Relief | AWS Terrain Tiles (terrarium) hillshade over OpenFreeMap | also powers 3D terrain |

- **2D / Globe toggle.** MapLibre 5 has a native globe projection (`setProjection({ type: 'globe' })`), so there is no Cesium and no second engine. Optional 3D terrain on the same terrain tiles. Lite mode forces 2D, no terrain and a lower pixel ratio.
- **Overlays**, independent of the style: clouds (GIBS), day/night terminator (computed), radar (RainViewer, opt-in and flagged non-commercial, or OpenWeatherMap with the owner's key).
- **Attribution** follows the active style and layers, always visible and small, like Argos.

### 4.2 The layer rail

- A right rail like Argos: one row per layer with an icon, a live count and a shortcut key.
- Click shows or hides the layer; hover (after 150 ms) opens its panel; pinning keeps the panel open.
- It replaces today's Layers popover.
- Groups: **Intel** (News, Conflict, Alerts), **Moving** (Flights, Ships, Satellites), **Earth** (Quakes, Fires, Storms, Volcanoes, Outbreaks, Weather), **Built** (Cameras, Airports, Ports, Power, Dams, Data centres, Cables), **Money** (Markets, Prediction markets), **Mine** (Places, Pins, Stories, Projects).
- Each panel has *Now* and *Filters* tabs:
  - **News, Now:** today's top stories by severity, clustered by theme, "Show all on map".
  - **Ships, Now:** chokepoints (Hormuz, Malacca, Suez, Panama, Gibraltar, Dover, Bosporus) with counts by type, AIS-off ships, OFAC-sanctioned ships.
  - **Satellites, Now:** above you (sky dome), ISS position and crew, next visible passes, next launches.
  - **Conflict, Now:** active theatres with their latest events and a 30-day sparkline.
  - **Markets, Now:** indices, commodities, FX and crypto with sparklines, plus prediction markets pinned where they are decided.

### 4.3 Hover cards (animated)

- **Trigger.** Pointer rests 120 ms on an item. Moving to another item swaps the card without closing; leaving for 200 ms closes it.
- **Look.**
  - A leader line grows from the point (stroke-dashoffset, 160 ms). The card then scales from 0.96 to 1 and fades in (140 ms, ease-out), placed on the side with the most room.
  - It shows the kind's colour bar, title, kind and age, 2-3 key facts and "Click for more".
  - Reduced-motion and Lite mode show it at once with no animation.
- **Content by kind:**
  - Flight: callsign, type, altitude, speed, from → to.
  - Ship: name, type, flag, speed, destination, AIS-off flag.
  - Quake: magnitude, depth, "felt near <your place>".
  - Fire: confidence, age.
  - News: headline, outlet, time, severity.
  - Camera: a live thumbnail.
  - Satellite: name, altitude, next pass.
  - Market: price and 24 h change.
- **Click pins it** into the Inspector (left card) with full details, sources, "Centre", "Ask Atlas", "Watch this place" and "Nearby" (cameras, flights, ships and quakes within a radius).
- **Built as one DOM overlay** positioned from `map.project()` on each frame while visible, not one MapLibre popup per item. That keeps animation and theming in React.

### 4.4 News on the map: stories, lines and the canvas

- **Geocoded news layer.**
  - The GDELT GEO 2.0 API (GeoJSON of the places in matching coverage, every 15 min) plus the owner's own RSS feeds.
  - Headlines with no coordinates are geocoded by the runtime: an LLM picks the place name, then Open-Meteo or a Natural Earth gazetteer resolves it. Results are cached, and every point says how it was placed.
  - Severity 0-10 and a theme (conflict, politics, economy, disaster, health, tech) come from a short LLM classification pass. It runs in batches and its cost appears in Usage.
- **Stories** are the new object: a named set of pins with an order, optional links between them, a note per pin and a source per pin. Stories are saved in memory, so "yesterday's Red Sea story" can come back.
- **Lines.** Links between pins are drawn as great-circle arcs: an animated dash along the line for the current story, faint for others. A link says why it exists ("same actors", "cause → effect", "same event, other coverage"). The assistant creates links and the owner can remove them.
- **News canvas.** A floating, draggable, resizable panel on the map:
  - Tabs: Feed, Story, Watching.
  - It lists the story's items in order. Hovering an item lights its pin; clicking it flies there.
  - It can be docked left or right or minimised to a chip. It is part of the map, not a separate page.
  - "Play" runs a **tour**: flies pin to pin, opens each card for N seconds and has the assistant narrate one sentence per stop.
- **Focus.** "Focus on this news" resolves *this* in order: the item under the pointer, the selected item, the item the assistant last mentioned, then a search. Focus does three things:
  - Flies to the item at a sensible zoom (city 9, region 6, country 4), pitched slightly on Globe.
  - Opens its card.
  - Turns on context layers for a radius (cameras, flights, ships, quakes, fires) and dims the rest.
  "Back" returns to the previous view (a view history stack).

### 4.5 The assistant drives the map (new tools)

All map tools are **view-only**. They change what is on screen, never the owner's data or the outside world, so they are `observe` class. That means they keep working after the assistant has read untrusted news (the 2026-10-18 policy fix asks before *modify* actions in a tainted turn, not before view changes). Saving a story is `modify` and goes through the normal gate.

| Tool | Does |
|---|---|
| `map_view` | fly to a place, coordinates, bbox or item id; zoom, bearing, pitch; style; 2D/globe |
| `map_layers` | show or hide layers, set filters (e.g. ships: tankers only) |
| `map_find` | search places, flights (callsign or registration), ships (name or MMSI), satellites, cameras, news; returns ids and coordinates |
| `map_visible` | what is on screen now: counts per layer, top items, the selection; this is how the assistant "sees" the map |
| `map_select` | open an item's card (or clear it) |
| `map_pins` | add, update or clear temporary pins with a label, colour, icon and note |
| `map_links` | draw or remove lines between pins, with a reason |
| `map_canvas` | open, close or dock the news canvas; set its tab |
| `story_build` | build a story from a query ("important news today", "Red Sea shipping") and put it on the map |
| `story_save` / `story_open` | keep a story in memory or bring back an old one (save is `modify`) |
| `map_tour` | play, pause or stop a narrated tour of the current story |
| `map_focus` | the "focus on this" behaviour from §4.4 |
| `map_back` | return to the previous view |

- **Wiring.** Runtime tool → host → main → renderer, as a new `map-op` message on the same pattern as `world-op`. The renderer answers with a result, so the assistant knows the fly-to happened and what is now visible.
- **Narration.** Spoken lines and map moves are timed together: each tour stop waits for `moveend` before speaking.
- **Voice examples** (Roman Urdu and English):
  - "aaj ki important news map pe dikhao"
  - "Hormuz pe focus karo"
  - "is ship ke aas paas kya hai?"
  - "satellite view lagao"
  - "globe pe le jao"
  - "wapas"
  - "is story ko save kar lo"

### 4.6 Proactive

Existing world alerts (a quake near a place, AQI, extreme weather) become **map moments**. When the owner is present and the attention policy allows it, the assistant offers "Dekhna chahenge?" and, on yes, opens World focused on the event with its context layers. The morning briefing can end with "3 stories on your map". Nothing opens the map by itself while the owner is in focus mode.

### 4.7 Chrome around the map

- **Mini globe** bottom left with the view footprint, clock, UTC offset, local weather and coordinates under the pointer. This extends the existing CornerWidget.
- **Toolbar:** search (places, flights, ships, news), style switcher, 2D/Globe, time scrubber for the last 24 h of events (phase 4), share as image.
- **Command palette** additions: every layer, every style, "Focus…", "Open story…", "Play tour".

## 5. Data sources we will use (licence-checked)

Verdicts as of 2026-10-18; re-check the "verify" items before a release. **Default** means keyless and on by default. **Key** means it is
off until the owner pastes their own key; keys live in the Windows credential store, as AISStream's does today.

| Layer | Default | Owner's key / opt-in | Licence notes |
|---|---|---|---|
| Streets, dark, light | OpenFreeMap | — | credit OpenMapTiles and OSM |
| Satellite | EOX S2 cloudless 2016 | Esri World Imagery (ArcGIS key) | EOX 2018+ is non-commercial; never keyless Esri, never Google |
| Daily imagery, clouds | NASA GIBS | — | acknowledgement requested |
| Relief, terrain | AWS Terrain Tiles | — | credit SRTM and the other sources |
| Radar | — | RainViewer (flagged non-commercial), OpenWeatherMap | |
| Flights | adsb.lol (in use) | OpenSky | ODbL; adsb.fi and airplanes.live are non-commercial; verify adsb.lol terms |
| Ships | Digitraffic (Baltic), Kystverket (Norway) | AISStream (in use) | AISStream must stay in main, never the renderer |
| News | GDELT DOC (in use) + GEO 2.0 | — | cite and link GDELT |
| Conflict events | UCDP GED (CC BY 4.0, monthly CSV) + GDELT conflict themes | ACLED (owner's key, no caching for others) | GeoConfirmed, DeepState and ISW: link out only |
| Frontlines | none bundled; the owner can import a GeoJSON they are licensed to use | — | |
| Quakes | USGS (in use) | — | public domain |
| Natural events | EONET (in use), GDACS | — | verify GDACS licence |
| Storms | NOAA NHC CurrentStorms + GDACS | — | |
| Fires | NASA FIRMS keyless files | FIRMS MAP_KEY for area queries | |
| Volcanoes | Smithsonian GVP weekly | — | credit GVP |
| Outbreaks | WHO Disease Outbreak News API | — | WHO content is CC BY-NC-SA IGO; credit |
| Airports | OurAirports | — | public domain; bundle as PMTiles or GeoJSON |
| Ports | NGA World Port Index | — | public domain |
| Power plants | WRI Global Power Plant Database | — | CC BY 4.0, frozen 2021 |
| Dams | Global Dam Watch | — | CC BY 4.0 |
| Data centres, cables | OSM extracts | — | ODbL; not PeeringDB or TeleGeography |
| Companies | Wikidata (HQ, sector, ticker) | — | CC0 |
| Sanctions | OFAC SDN (vessels, aircraft) | — | public domain |
| Country cards | World Bank API, Wikidata | — | CC BY 4.0 / CC0 |
| Satellites, ISS | CelesTrak (in use; cache ≥ 1 h, OMM JSON) | — | |
| Launches | Launch Library 2 (The Space Devs) | — | free tier rate-limited; verify terms |
| Prediction markets | Polymarket Gamma (read-only), Kalshi public | — | odds as context only; verify redistribution terms |
| FX, crypto | Frankfurter, CoinGecko keyless | CoinGecko demo key | |
| Stocks, indices | — | Alpha Vantage, Finnhub or Twelve Data key | no Yahoo or Stooq scraping |
| Cameras | Caltrans, Digitraffic, HK TD, data.gov.sg (in use) | TfL (free app_key), 511 systems, Windy | official portals only; latest frame only |

**Static layers** (airports, ports, power, dams, OSM data centres and cables, Natural Earth) are built by a script
(`tools/atlas-data/`) into small vector tiles (PMTiles), shipped with the installer and loaded locally. That works
offline with no server. Each dataset's licence goes into `docs/THIRD_PARTY_LICENSES.md` through the existing inventory script.

## 6. Architecture

```
renderer (World page)
  MapView        MapLibre 5: style manager, globe/terrain, layer registry, hover overlay, view history
  LayerRail      counts + shortcuts + hover panels (Now / Filters)
  HoverCard      one animated DOM overlay
  Inspector      left card (exists; grows "Nearby" and per-kind detail)
  NewsCanvas     floating story/feed panel, tour player
      ▲ map-op / map-result (IPC, sender-checked; owner lock not needed for view ops)
main
  WorldService   live feeds (flights, ships, satellites, cameras) - exists
  AtlasData      static PMTiles via a custom protocol (like the news image protocol)
  FeedCache      per-source TTL, backoff, User-Agent, attribution string
      ▲ world-op / map-op
runtime
  WorldWatch     places, hazards, news - exists
  NewsGeo        GDELT GEO, LLM place + severity pass, cache, untrusted labels
  StoryStore     stories, pins and links in SQLite (new migration)
  map_* tools    observe-class view tools; story_save is modify
```

- **Split World.tsx first.** It is 874 lines in one file. Move it to `renderer/src/world/` (MapView, layers/*, HoverCard, LayerRail, Inspector, NewsCanvas, styles.ts) before adding anything.
- **A layer registry.** Each layer declares its id, group, icon, key, source, MapLibre layers, a hover-card renderer, a detail renderer, a count function and a refresh policy. The rail, hover, Inspector, search and `map_visible` all read from the registry, so a new layer is one file.
- **Performance** (hardware-neutral):
  - Feeds poll only while World is visible (as now).
  - Clustering for cameras, news and events below z6.
  - Flights and ships are viewport-bounded.
  - Satellites propagate in a worker.
  - deck.gl is **not** added unless arcs or heat layers prove too slow in MapLibre.
  - Lite mode: 2D, no terrain, pixel ratio 1, at most 3 live layers.
- **Security:**
  - Every feed text is untrusted: card text is rendered as text, never HTML; source links open externally only on https.
  - News-derived pins carry `untrusted: true`, and the assistant labels them.
  - Keys stay in main.

## 7. Phases

Each phase is small, ships on its own, and has a check the owner can do.

1. **Foundation: styles and the registry**
   - Split World.tsx; add the layer registry; add the style switcher with Satellite as default (EOX + OpenFreeMap labels), Dark, Light, Relief, GIBS daily; 2D/Globe toggle; per-style attribution; view history.
   - *Check:* the map opens on satellite; switching styles keeps layers and view; Globe spins; Lite mode stays 2D.
2. **Hover cards and the Inspector**
   - Animated hover overlay for every existing layer; Inspector grows per-kind detail and "Nearby".
   - *Check:* hovering a flight, ship, quake or camera shows the card in under 150 ms with the leader-line animation; reduced-motion shows no animation.
3. **The assistant drives the map**
   - Add the `map-op` channel and the `map_view`, `map_layers`, `map_find`, `map_visible`, `map_select`, `map_focus`, `map_back` and `map_pins` tools, with tests.
   - *Check (voice):* "Karachi pe le jao, satellite view" flies and switches; "kya dikh raha hai?" answers from `map_visible`.
4. **News on the map**
   - GDELT GEO, the LLM place and severity pass, the news layer with clustering, stories, links and arcs, the news canvas, the tour, `story_*` tools, and a stories migration.
   - *Check:* "aaj ki important news dikhao" pins 8-15 stories, links related ones and opens the canvas; "focus on the second one" flies and opens it; "save this story" asks once.
5. **Layer rail and panels**
   - The rail with counts and shortcuts, and the hover panels (Ships chokepoints, Satellites above you and passes, News, Conflict).
   - *Check:* each layer key toggles; hovering a row opens its panel.
6. **New layers** (one file each through the registry)
   - FIRMS fires, NHC storms, GDACS, GVP volcanoes, WHO outbreaks, UCDP events, OFAC flags on ships, Digitraffic and Kystverket ships, launches, prediction markets, FX and crypto.
   - *Check:* per layer, count matches the source and the card shows the source and time.
7. **Static infrastructure**
   - The `tools/atlas-data` build: OurAirports, ports, power, dams, OSM cables and data centres as PMTiles; the custom protocol in main; licence inventory.
   - *Check:* works offline; installer size grows by less than about 60 MB.
8. **Proactive map moments and the time scrubber**
   - Alerts offer a focused map; the briefing ends on the map; 24 h replay of events.

Phases 1-3 are the core. With them the map looks like a real-world atlas and the assistant can drive it. Phase 4 is the feature nobody else has.

## 8. Open questions for the owner

1. **Satellite HD.** Is the keyless EOX 2016 imagery (good to about city level) enough as the default, or should Setup also offer Esri or MapTiler imagery with your own key from day one?
2. **Frontlines.** Since no licensed open frontline data exists, is "UCDP events + GDELT conflict news + link out to DeepState/ISW" acceptable, or do you want to ask DeepState for permission?
3. **Markets.** Should prediction markets and stocks show at all, or stay out of a personal assistant? If shown, odds only, with no trading links.
4. **News LLM pass cost.** Classifying about 200 headlines an hour costs real tokens. Should it be hourly, on demand only ("show me the news"), or limited to the owner's places and interests?
