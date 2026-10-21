import {
  AppWindow,
  ArrowLeftRight,
  Bell,
  Brain,
  ChevronDown,
  Columns2,
  Compass,
  CheckSquare,
  Feather,
  MapPin,
  Palette,
  RefreshCw,
  Sparkles,
  FolderKanban,
  FolderOpen,
  Globe2,
  Fingerprint,
  Keyboard,
  Home as HomeIcon,
  ListTodo,
  Maximize2,
  MessageSquare,
  Minimize2,
  Newspaper,
  Pin,
  PinOff,
  ChevronsLeft,
  ChevronsRight,
  Expand,
  GripVertical,
  Move,
  PanelLeft,
  PanelRight,
  Shrink,
  Settings2,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import type { ControlState } from "../../shared/control.ts";
import type { IdentityView } from "../../shared/identity.ts";
import { MODES, type RuntimeStatus, type UiMode } from "../../shared/ipc.ts";
import { MAP3D_STATE_EVENT, type UiChange, type View } from "../../shared/ui.ts";
import {
  clampRatio,
  dropSurface,
  isSurface,
  setSide,
  showSurface,
  SURFACE_LABEL,
  SURFACES,
  type BrowserMode,
  type StageLayout,
  type Surface,
} from "../../shared/browser.ts";
import { AtlasBrowser, BrowserSlot } from "./browser/AtlasBrowser.tsx";
import logo from "./assets/logo.svg";
import { Companion } from "./Companion.tsx";
import { PausedBanner } from "./Controls.tsx";
import { Home } from "./Home.tsx";
import { ActivityCard, NowCard, TodayCard, type Presence } from "./Jarvis.tsx";
import { LockScreen } from "./LockScreen.tsx";
import { Setup } from "./Setup.tsx";
import { useCounts, type CountKey } from "./shell/counts.ts";
import { STRIP_W, usePanelLayout } from "./shell/panelLayout.ts";
import { ShortcutBoard } from "./shell/ShortcutBoard.tsx";
import { Rail, type RailItem } from "./shell/Rail.tsx";
import { useAlerts } from "./shell/alerts.ts";
import { AlertsTimeline } from "./shell/AlertsTimeline.tsx";
import { CornerWidget } from "./shell/CornerWidget.tsx";
import { PresencePill } from "./shell/PresencePill.tsx";
import {
  CommandPalette,
  type Command,
  type CommandSource,
} from "./shell/CommandPalette.tsx";
import { ASK_EVENT, requestNewsFocus } from "./shell/live.ts";
import { Peek, type PeekKind } from "./shell/Peek.tsx";
import {
  changeAppearance,
  currentAppearance,
  THEME_LABEL,
  THEMES,
} from "./theme.ts";
import { nameOf, useAssistantName } from "./ui/assistantName.ts";

// Pages load the first time they open: a lighter start.
const HabitsPage = lazy(() =>
  import("./habits/Habits.tsx").then((m) => ({ default: m.HabitsPage })),
);
const WorldPage = lazy(() =>
  import("./World.tsx").then((m) => ({ default: m.WorldPage })),
);
const NewsPage = lazy(() =>
  import("./News.tsx").then((m) => ({ default: m.NewsPage })),
);
const ProjectsHome = lazy(() =>
  import("./ProjectsHome.tsx").then((m) => ({ default: m.ProjectsHome })),
);
const FilesPage = lazy(() =>
  import("./Files.tsx").then((m) => ({ default: m.FilesPage })),
);
const AppsPage = lazy(() =>
  import("./Apps.tsx").then((m) => ({ default: m.AppsPage })),
);
const Learning = lazy(() =>
  import("./Learning.tsx").then((m) => ({ default: m.Learning })),
);
const Controls = lazy(() =>
  import("./Controls.tsx").then((m) => ({ default: m.Controls })),
);
const SetupSections = lazy(() =>
  import("./Personality.tsx").then((m) => ({ default: m.SetupSections })),
);

type DrawerId =
  | "chat"
  | "alerts"
  | "today"
  | "news"
  | "projects"
  | "files"
  | "apps"
  | "learning"
  | "controls"
  | "setup";
const DRAWER_TITLE: Record<DrawerId, string> = {
  chat: "Conversation",
  alerts: "Alerts · last 24 hours",
  today: "Today",
  news: "News",
  projects: "Projects",
  files: "Files",
  apps: "Apps",
  learning: "Learning",
  controls: "Connections",
  setup: "Settings",
};

/** The order "[" and "]" step through. */
const PANEL_ORDER: DrawerId[] = [
  "chat",
  "alerts",
  "today",
  "news",
  "projects",
  "files",
  "apps",
  "learning",
  "controls",
  "setup",
];

/** Wide enough to keep a pinned drawer beside the stage. */
const ROOMY = "(min-width: 1100px)";
/** Phone-width windows put the rail at the bottom. */
const PHONE = "(max-width: 639px)";

const useMedia = (query: string) => {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
};

const stored = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice lasts for this window only.
  }
};

/**
 * The shell, "minimal by default, detail on demand": one stage (Home or the
 * World map) fills the window; a slim rail on the right shows every module
 * with a live number; a module opens as a drawer beside the rail (pin it to
 * keep it open). The conversation is a drawer too, always mounted so nothing
 * is lost, and opens by itself when Atlas speaks up. Compact mode is a small
 * chat-only window. Atlas changes all of this through ui_control.
 */
export function App() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [controls, setControls] = useState<ControlState | null>(null);
  const [layout, setLayoutState] = useState<StageLayout>(() => {
    try {
      const l = JSON.parse(stored("layout", "")) as Partial<StageLayout>;
      if (isSurface(l.main))
        return {
          main: l.main,
          side: isSurface(l.side) && l.side !== l.main ? l.side : null,
          ratio: clampRatio(Number(l.ratio)),
        };
    } catch {
      // First run or an old choice: start from the old single stage.
    }
    return {
      main: stored("stage", "home") === "world" ? "world" : "home",
      side: null,
      ratio: 0.5,
    };
  });
  /** The pane a tab opens in when two show. */
  const [focusedPane, setFocusedPane] = useState<"main" | "side">("main");
  /** Where the browser shows when it is not one of the panes. */
  const [browserFloat, setBrowserFloat] = useState<"mini" | "full" | "hidden">("hidden");
  const [driving, setDriving] = useState(false);
  const panesRef = useRef<HTMLDivElement>(null);
  /** The stage-and-panel area: the side panel docks to its edges or floats inside it. */
  const areaRef = useRef<HTMLDivElement>(null);
  // Every page loads in the background once the app is idle, so opening one never blinks a loader.
  useEffect(() => {
    // The World page brings the whole map engine: on a modest machine (Lite) it loads when first opened.
    const lite = document.documentElement.dataset.lite === "true";
    const pages = [...(lite ? [] : [() => import("./World.tsx")]), () => import("./News.tsx"), () => import("./ProjectsHome.tsx"), () => import("./Files.tsx"), () => import("./Apps.tsx"), () => import("./Learning.tsx"), () => import("./Controls.tsx"), () => import("./Personality.tsx"), () => import("./habits/Habits.tsx")];
    let i = 0;
    let handle = 0;
    const next = () => {
      const load = pages[i++];
      if (!load) return;
      void load().catch(() => undefined).finally(() => (handle = window.setTimeout(() => requestIdleCallback(next, { timeout: 4000 }), 300)));
    };
    handle = window.setTimeout(() => requestIdleCallback(next, { timeout: 4000 }), 6000);
    return () => clearTimeout(handle);
  }, []);
  // The assistant's own name, everywhere on screen: renaming it re-renders the app (and the taskbar title).
  const assistantName = useAssistantName();
  useEffect(() => {
    document.title = assistantName;
  }, [assistantName]);
  const stage = layout.main;
  const [drawer, setDrawer] = useState<DrawerId | null>(() => {
    const d = stored("drawer", "chat");
    return d in DRAWER_TITLE ? (d as DrawerId) : null;
  });
  const [pinned, setPinned] = useState(
    () => stored("drawer.pinned", "true") === "true",
  );
  const [presence, setPresence] = useState<Presence>({
    state: "idle",
    level: 0,
  });
  const roomy = useMedia(ROOMY);
  const phone = useMedia(PHONE);
  const panel = usePanelLayout(
    areaRef,
    drawer ?? "chat",
    ["setup", "controls", "learning", "news", "projects"].includes(drawer ?? ""),
  );
  const [placeMenu, setPlaceMenu] = useState(false);
  const [board, setBoard] = useState(false);
  // Ten minutes out of sight: the World map (its engine, tiles and data) is let go; it comes back when shown.
  const [dormant, setDormant] = useState(false);
  useEffect(() => {
    let t = 0;
    const on = () => {
      clearTimeout(t);
      if (document.hidden) t = window.setTimeout(() => setDormant(true), 10 * 60_000);
      else setDormant(false);
    };
    document.addEventListener("visibilitychange", on);
    return () => {
      clearTimeout(t);
      document.removeEventListener("visibilitychange", on);
    };
  }, []);
  const [compact, setCompact] = useState(false);
  const [map3d, setMap3d] = useState(false);
  const [onTop, setOnTop] = useState(false);
  const [identity, setIdentity] = useState<IdentityView | null>(null);
  const [suggestions, setSuggestions] = useState(0);
  const [unread, setUnread] = useState(0);
  const [palette, setPalette] = useState(false);
  const drawerRef = useRef(drawer);
  drawerRef.current = drawer;

  const open = (d: DrawerId | null) => {
    setDrawer(d);
    store("drawer", d ?? "");
    if (d === "chat") setUnread(0);
  };
  const setLayout = (f: (l: StageLayout) => StageLayout) =>
    setLayoutState((l) => {
      const next = f(l);
      store("layout", JSON.stringify(next));
      return next;
    });
  const focusedRef = useRef(focusedPane);
  focusedRef.current = focusedPane;
  /** Show a surface (a tab): where it already shows, else in the focused pane. */
  const goStage = (s: Surface) => {
    setLayout((l) => showSurface(l, s, focusedRef.current));
    if (s !== "browser") setBrowserFloat((f) => (f === "full" ? "mini" : f));
  };
  /** The browser's place: a pane, the corner, the whole window or away. */
  const setBrowserMode = (m: BrowserMode) => {
    if (m === "pane") {
      setLayout((l) => (l.main === "browser" || l.side === "browser" ? l : setSide(l, "browser")));
      setBrowserFloat("hidden");
    } else if (m === "full") setBrowserFloat("full");
    else {
      setLayout((l) => dropSurface(l, "browser"));
      setBrowserFloat(m);
    }
  };
  const setBrowserModeRef = useRef(setBrowserMode);
  setBrowserModeRef.current = setBrowserMode;
  const openChat = (yes: boolean) => open(yes ? "chat" : null);
  /** "/" and the palette: open the conversation with its box ready to type in. */
  const focusAsk = () => {
    open("chat");
    setTimeout(() => document.querySelector<HTMLTextAreaElement>("aside textarea")?.focus(), 60);
  };

  useEffect(() => {
    void window.assistant.status().then(setStatus);
    const off = window.assistant.onStatus(setStatus);
    void window.controls.state().then(setControls);
    const offControls = window.controls.onState(setControls);
    void window.identity.get().then(setIdentity, () => undefined);
    const offIdentity = window.identity.onChanged(setIdentity);
    void window.learning.get().then(
      (v) => setSuggestions(v.pending.length),
      () => undefined,
    );
    const offLearning = window.learning.onChanged((v) =>
      setSuggestions(v.pending.length),
    );
    void window.ui.state().then(
      (s) => setOnTop(s.pinned),
      () => undefined,
    );
    const offReply = window.assistant.onReply((e) => {
      // Atlas speaks up on its own: show the conversation.
      if (e.type === "initiative") open("chat");
      // A reply finished while the conversation is put away: count it on the rail.
      else if (e.type === "done" && drawerRef.current !== "chat")
        setUnread((n) => n + 1);
    });
    // Atlas (through main) changes the stage, a drawer, the conversation or compact mode.
    const offCommand = window.ui.onCommand((c) => {
      if (c.compact !== undefined) setCompact(c.compact);
      if (isSurface(c.view)) {
        goStage(c.view);
        setDrawer((d) => (d === "chat" ? d : null));
      } else if (c.view) open(c.view as DrawerId);
      if (c.side !== undefined) setLayout((l) => setSide(l, c.side ?? null));
      if (c.browser?.mode) setBrowserModeRef.current(c.browser.mode);
      if (c.browser?.driving !== undefined) setDriving(c.browser.driving);
      if (c.palette) setPalette(true);
      if (c.shortcuts) setBoard(true);
      if (c.news) {
        open("news");
        requestNewsFocus(c.news);
      }
      if (c.chat === true) open("chat");
      else if (c.chat === false) setDrawer((d) => (d === "chat" ? null : d));
    });
    return () => {
      off();
      offControls();
      offIdentity();
      offLearning();
      offReply();
      offCommand();
    };
  }, []);

  // Main (and so Atlas) always knows what the window shows.
  const inPanes = layout.main === "browser" || layout.side === "browser";
  const browserMode: BrowserMode =
    browserFloat === "full" ? "full" : inPanes ? "pane" : browserFloat;
  // Its size, whether it is in front and whether its tab is showing too (re-told when they change).
  const [screenTick, setScreenTick] = useState(0);
  useEffect(() => {
    let t = 0;
    const bump = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => setScreenTick((n) => n + 1), 300);
    };
    for (const e of ["resize", "focus", "blur"]) window.addEventListener(e, bump);
    document.addEventListener("visibilitychange", bump);
    return () => {
      window.clearTimeout(t);
      for (const e of ["resize", "focus", "blur"]) window.removeEventListener(e, bump);
      document.removeEventListener("visibilitychange", bump);
    };
  }, []);
  useEffect(() => {
    const view: View = drawer && drawer !== "chat" ? drawer : stage;
    window.ui.report({
      view,
      chatOpen: drawer === "chat",
      compact,
      map3d,
      side: layout.side,
      browser: browserMode,
      width: window.innerWidth,
      height: window.innerHeight,
      focused: document.hasFocus(),
      visible: document.visibilityState === "visible",
    });
  }, [stage, drawer, compact, map3d, layout.side, browserMode, screenTick]);

  // Which World map is in front, 2D or 3D, so Atlas works on the one the owner sees.
  useEffect(() => {
    const on = (e: Event) => setMap3d((e as CustomEvent<boolean>).detail === true);
    window.addEventListener(MAP3D_STATE_EVENT, on);
    return () => window.removeEventListener(MAP3D_STATE_EVENT, on);
  }, []);

  // Keys: Ctrl+K palette, Esc puts the drawer away (unless pinned), "/" asks,
  // G H / G W switch the stage, [ and ] step through the panels.
  const gRef = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable);
      if (typing || e.ctrlKey || e.metaKey || e.altKey || palette || compact)
        return;
      if (e.key === "Escape" && drawer && !pinned) open(null);
      else if (e.key === "?") {
        e.preventDefault();
        setBoard(true);
      } else if (e.key === "/") {
        e.preventDefault();
        focusAsk();
      } else if (e.key === "g" || e.key === "G") gRef.current = Date.now();
      else if (
        Date.now() - gRef.current < 1200 &&
        (e.key === "h" || e.key === "w" || e.key === "b")
      ) {
        gRef.current = 0;
        goStage(e.key === "h" ? "home" : e.key === "w" ? "world" : "browser");
        if (drawer && drawer !== "chat" && !pinned) open(null);
      } else if (e.key === "[" || e.key === "]") {
        const at = drawer ? PANEL_ORDER.indexOf(drawer) : -1;
        const step = e.key === "]" ? 1 : -1;
        open(
          PANEL_ORDER[(at + step + PANEL_ORDER.length) % PANEL_ORDER.length] ??
            null,
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer, pinned, palette, compact]);

  const setWindow = async (change: UiChange) => {
    const s = await window.ui.set(change).catch(() => null);
    if (s) setOnTop(s.pinned);
  };

  const locked = identity?.locked === true;
  const counts = useCounts({
    status:
      status ??
      ({
        phase: "starting",
        approvals: [],
        later: [],
      } as unknown as RuntimeStatus),
    controls,
    locked,
    suggestions,
    unread,
  });

  const alerts = useAlerts({
    status,
    controls,
    active: status?.phase === "ready" && !locked,
  });
  const needYou = alerts.filter((a) => a.open).length;

  if (!status) return <div className="aurora" />;

  // First run: setup fills the window until the connection works.
  if (status.phase === "setup") {
    return (
      <Frame status={status}>
        <div className="glass mx-auto my-3 h-[calc(100%-1.5rem)] w-full max-w-xl overflow-hidden rounded-3xl sm:my-6 sm:h-[calc(100%-3rem)]">
          <Setup status={status} onSaved={setStatus} />
        </div>
      </Frame>
    );
  }

  const setup = (
    <Setup
      status={status}
      onSaved={(s) => setStatus(s)}
      onCancel={() => open(null)}
    />
  );
  const peek = (kind: PeekKind) => (
    <Peek kind={kind} ctx={{ status, controls, alerts }} />
  );
  const item = (
    id: DrawerId,
    label: string,
    icon: ReactNode,
    count?: CountKey,
  ): RailItem => ({
    id,
    label,
    icon,
    count: count ? counts[count] : undefined,
    active: drawer === id,
    onClick: () => open(drawer === id ? null : id),
    peek: peek(id),
  });
  const top: RailItem[] = [
    {
      id: "home",
      label: "Home",
      icon: <HomeIcon />,
      active: (layout.main === "home" || layout.side === "home") && (!drawer || drawer === "chat"),
      onClick: () => goStage("home"),
      peek: peek("home"),
    },
    {
      id: "world",
      label: "World",
      icon: <Globe2 />,
      count: counts.world,
      active: (layout.main === "world" || layout.side === "world") && (!drawer || drawer === "chat"),
      onClick: () => goStage("world"),
      peek: peek("world"),
    },
    {
      id: "browser",
      label: "Browser",
      icon: <Compass />,
      active: browserMode !== "hidden" && (!drawer || drawer === "chat"),
      onClick: () => (browserMode === "hidden" ? setBrowserMode("pane") : goStage("browser")),
    },
  ];
  const items: RailItem[] = [
    item("chat", "Talk", <MessageSquare />, "chat"),
    {
      ...item("alerts", "Alerts", <Bell />),
      count: {
        value: alerts.length ? String(alerts.length) : null,
        hint: alerts.length
          ? `${alerts.length} in the last 24 hours${needYou ? `, ${needYou} need you` : ""}`
          : "Alerts",
        attention: needYou > 0,
      },
    },
    item("today", "Today", <ListTodo />, "today"),
    item("news", "News", <Newspaper />, "news"),
    item("projects", "Code", <FolderKanban />, "projects"),
    item("files", "Files", <FolderOpen />, "files"),
    item("apps", "Apps", <AppWindow />, "apps"),
    item("learning", "Learning", <Brain />, "learning"),
    item("controls", "Links", <SlidersHorizontal />, "controls"),
  ];
  const bottom: RailItem[] = [
    {
      id: "compact",
      label: "Compact",
      icon: <Minimize2 />,
      active: false,
      onClick: () => void setWindow({ size: "compact" }),
      peek: peek("compact"),
    },
    {
      id: "shortcuts",
      label: "Shortcuts",
      icon: <Keyboard />,
      active: board,
      onClick: () => setBoard(true),
    },
    item("setup", "Settings", <Settings2 />),
  ];

  // The command palette: everything in the rail, plus actions and live things.
  const RENAME: Record<string, string> = {
    Talk: "Conversation",
    Code: "Projects",
    Links: "Connections",
  };
  const ask = (text: string) =>
    window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: text }));
  const look = currentAppearance();
  const commands: Command[] = [
    {
      id: "shortcuts",
      group: "Do",
      label: "Keyboard shortcuts",
      icon: <Keyboard />,
      keywords: "keys hotkeys shortcut board",
      run: () => setBoard(true),
    },
    ...[...top, ...items].map((i) => ({
      id: `go-${i.id}`,
      group: "Go to",
      label: RENAME[i.label] ?? i.label,
      hint: i.count?.value ? i.count.hint : undefined,
      icon: i.icon,
      keywords: i.id,
      run:
        i.id === "home" || i.id === "world"
          ? i.onClick
          : () => open(i.id as DrawerId),
    })),
    {
      id: "go-setup",
      group: "Go to",
      label: "Settings",
      icon: <Settings2 />,
      keywords: "setup keys voice personality",
      run: () => open("setup"),
    },
    {
      id: "ask",
      group: "Do",
      label: `Ask ${nameOf()}`,
      hint: "/",
      icon: <Sparkles />,
      run: () => focusAsk(),
    },
    {
      id: "compact",
      group: "Do",
      label: "Compact mode",
      icon: <Minimize2 />,
      keywords: "small window mini",
      run: () => void setWindow({ size: "compact" }),
    },
    {
      id: "ontop",
      group: "Do",
      label: onTop ? "Stop keeping on top" : "Keep on top of other windows",
      icon: <Pin />,
      keywords: "pin always",
      run: () => void setWindow({ pinned: !onTop }),
    },
    {
      id: "refresh-world",
      group: "Do",
      label: "Refresh world data",
      icon: <RefreshCw />,
      keywords: "weather quakes air",
      run: () => void window.world.refresh().catch(() => undefined),
    },
    {
      id: "refresh-news",
      group: "Do",
      label: "Refresh news",
      icon: <RefreshCw />,
      keywords: "headlines",
      run: () => void window.news.list(true).catch(() => undefined),
    },
    {
      id: "lite",
      group: "Appearance",
      label:
        look.lite === "on" ? "Lite mode: back to automatic" : "Lite mode: on",
      icon: <Feather />,
      keywords: "fast light performance effects",
      run: () => changeAppearance({ lite: look.lite === "on" ? "auto" : "on" }),
    },
    ...THEMES.map((t) => ({
      id: `theme-${t}`,
      group: "Appearance",
      label: `Theme: ${THEME_LABEL[t].split(":")[0]}`,
      hint: look.theme === t ? "current" : undefined,
      icon: <Palette />,
      keywords: `theme ${THEME_LABEL[t]} ${t === "daylight" ? "light" : "dark"}`,
      run: () => changeAppearance({ theme: t }),
    })),
  ];
  const sources: CommandSource[] = [
    async () =>
      (await window.world.state()).places.map((p) => ({
        id: `place-${p.place.id}`,
        group: "Places",
        label: p.place.name,
        hint: p.weather
          ? `${Math.round(p.weather.temp)}° ${p.weather.summary}`
          : undefined,
        icon: <MapPin />,
        keywords: "place weather world",
        run: () => goStage("world"),
      })),
    async () =>
      (await window.assistant.listTasks()).map((t) => ({
        id: `task-${t.id}`,
        group: "Tasks",
        label: t.title,
        hint: t.dueAt
          ? new Date(t.dueAt).toLocaleDateString([], {
              day: "numeric",
              month: "short",
            })
          : undefined,
        icon: <CheckSquare />,
        keywords: "task todo",
        run: () => open("today"),
      })),
    async () =>
      (await window.code.state()).projects.map((p) => ({
        id: `project-${p.id}`,
        group: "Projects",
        label: p.name,
        hint: p.git?.branch,
        icon: <FolderKanban />,
        keywords: "project code",
        run: () => open("projects"),
      })),
    async () =>
      (await window.desktop.state()).apps.map((a) => ({
        id: `app-${a.id}`,
        group: "Apps",
        label: `Open ${a.name}`,
        icon: <AppWindow />,
        keywords: "app launch",
        run: () => ask(`Open ${a.name}`),
      })),
  ];

  const drawerContent = (d: DrawerId): ReactNode => {
    switch (d) {
      case "alerts":
        return (
          <AlertsTimeline
            items={alerts}
            onOpen={(t) => {
              if (t === "world") {
                goStage("world");
                open(null);
              } else open(t);
            }}
          />
        );
      case "today":
        return (
          <div className="h-full space-y-3 overflow-y-auto p-3">
            <NowCard status={status} controls={controls} />
            <TodayCard status={status} />
            <ActivityCard controls={controls} presence={presence} />
          </div>
        );
      case "news":
        return <NewsPage />;
      case "projects":
        return <ProjectsHome />;
      case "files":
        return <FilesPage onTalk={() => open("chat")} />;
      case "apps":
        return <AppsPage onTalk={() => open("chat")} />;
      case "learning":
        return <Learning onTalk={() => open("chat")} />;
      case "controls":
        return controls ? (
          <Controls state={controls} />
        ) : null;
      case "setup":
        return status.phase === "ready" ? (
          <SetupSections connection={setup} onClose={() => open(null)} />
        ) : (
          setup
        );
      default:
        return null;
    }
  };

  const panes: Surface[] =
    layout.side && roomy && !phone ? [layout.main, layout.side] : [layout.main];

  // The drawer sits beside the stage when pinned in a roomy window; otherwise it floats over the stage's edge.
  const docked = pinned && roomy && !phone;
  // Pinned panels can be docked left or right (resizable), floated anywhere over the stage,
  // collapsed to a slim strip or expanded over the whole stage. Unpinned ones slide over the stage's edge.
  const free = !compact && !phone;
  const place = panel.layout.place;
  const expanded = free && !!drawer && panel.layout.expanded;
  const dockedSide = free && docked && place !== "float" && !expanded;
  const floating = free && pinned && place === "float" && !expanded;
  const collapsed = free && pinned && !!drawer && panel.layout.collapsed && !expanded;
  const hide = drawer ? "" : "hidden";
  let drawerStyle: CSSProperties | undefined;
  let drawerClass: string;
  if (compact) drawerClass = "mx-2 mb-2 flex-1";
  else if (phone) drawerClass = `absolute inset-0 z-30 mx-2 mb-2 bg-solid ${hide}`;
  else if (panel.drag) {
    const r = panel.drag.rect;
    drawerClass = "absolute z-40 bg-solid opacity-90 shadow-2xl ring-2 ring-accent/60";
    drawerStyle = { left: r.x, top: r.y, width: r.w, height: r.h };
  } else if (expanded) drawerClass = "absolute inset-0 z-30 mx-2 mb-2 bg-solid shadow-2xl";
  else if (dockedSide) {
    drawerClass = `relative mb-2 shrink-0 transition-[width] duration-150 ${place === "left" ? "ml-2" : "mr-2"} ${hide}`;
    drawerStyle = { width: collapsed ? STRIP_W : panel.width, order: place === "left" ? 0 : 2 };
  } else if (floating) {
    const f = panel.float;
    drawerClass = `absolute z-30 bg-solid shadow-2xl ${hide}`;
    drawerStyle = { left: f.x, top: f.y, width: collapsed ? 260 : f.w, height: collapsed ? undefined : f.h };
  } else {
    drawerClass = `absolute inset-y-0 z-30 mb-2 bg-solid shadow-2xl ${place === "left" ? "left-0 ml-2" : "right-0 mr-2"} ${hide}`;
    drawerStyle = { width: Math.min(panel.width, Math.max(320, panel.size.w - 16)) };
  }

  return (
    <Frame
      status={status}
      locked={locked}
      tabs={
        !compact && !phone ? (
          <StageTabs
            layout={layout}
            focused={focusedPane}
            browserShown={browserMode !== "hidden"}
            canSplit={roomy}
            onShow={(x) => (x === "browser" && browserMode !== "pane" && browserMode !== "hidden" && !inPanes ? setBrowserMode("pane") : goStage(x))}
            onSplit={() =>
              setLayout((l) =>
                l.side ? { ...l, side: null } : setSide(l, l.main === "home" ? "world" : "home"),
              )
            }
            onSwap={() => setLayout((l) => (l.side ? { ...l, main: l.side, side: l.main, ratio: 1 - l.ratio } : l))}
          />
        ) : null
      }
      overlay={
        identity && locked ? (
          <LockScreen
            view={identity}
            ownerName={status.setup.ownerName}
            voice={status.speech.available}
          />
        ) : null
      }
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 min-w-0 flex-1">
          {/* Stage and drawer: a floating drawer covers the stage's edge, never the rail. */}
          <div ref={areaRef} className="relative flex min-h-0 min-w-0 flex-1">
            {/* Moving the panel: the edges it would dock to light up. */}
            {panel.drag &&
              (["left", "right"] as const).map((z) => (
                <div
                  key={z}
                  aria-hidden
                  className={`pointer-events-none absolute inset-y-0 z-30 mb-2 w-24 rounded-2xl border-2 border-dashed transition-colors ${z === "left" ? "left-2" : "right-2"} ${panel.drag?.zone === z ? "border-accent bg-accent/15" : "border-border bg-transparent"}`}
                />
              ))}
            {!compact && (
              <div ref={panesRef} style={{ order: 1 }} className={`relative flex min-h-0 min-w-0 flex-1 ${phone ? "mb-1" : "mb-2"}`}>
                {SURFACES.filter((x) => panes.includes(x)).map((x) => {
                  const at = panes.indexOf(x);
                  return (
                    <main
                      key={x}
                      style={{
                        order: at * 2,
                        flex: panes.length > 1 ? `${at === 0 ? layout.ratio : 1 - layout.ratio} 1 0` : "1 1 0",
                      }}
                      onPointerDownCapture={() => setFocusedPane(at === 0 ? "main" : "side")}
                      className={`@container glass relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl ${panes.length > 1 ? (at === 0 ? "ml-2" : "mr-2") : "mx-2"} ${panes.length > 1 && (focusedPane === "main") === (at === 0) ? "ring-1 ring-accent/40" : ""}`}
                    >
                      {controls && at === 0 && <PausedBanner state={controls} />}
                      <div className="min-h-0 flex-1">
                        <Suspense fallback={<Loading />}>
                          {x === "home" ? (
                            <Home
                              status={status}
                              controls={controls}
                              presence={presence}
                              ownerName={status.setup.ownerName}
                              open={(t) => (t === "world" ? goStage("world") : open(t))}
                            />
                          ) : x === "world" ? (
                            dormant ? null : <WorldPage />
                          ) : x === "habits" ? (
                            <HabitsPage />
                          ) : (
                            <BrowserSlot />
                          )}
                        </Suspense>
                      </div>
                      {x === "world" && (
                        <div className="pointer-events-none absolute bottom-3 left-3 z-[35] hidden @[720px]:block">
                          <CornerWidget
                            state={
                              controls?.paused
                                ? "paused"
                                : status.phase !== "ready"
                                  ? "offline"
                                  : presence.state
                            }
                            presence={presence}
                            onHome={() => goStage("home")}
                          />
                        </div>
                      )}
                    </main>
                  );
                })}
                {panes.length > 1 && (
                  <PaneDivider
                    onRatio={(r) => setLayout((l) => ({ ...l, ratio: clampRatio(r) }))}
                    container={panesRef}
                  />
                )}
              </div>
            )}

            {/* Atlas's own browser: over its pane, in the corner, or over everything. */}
            {!compact && (
              <AtlasBrowser
                mode={browserMode}
                driving={driving}
                panes={panesRef}
                onMode={setBrowserMode}
              />
            )}

            {/* Atlas's presence on any page while the conversation is closed. */}
            {!compact && drawer !== "chat" && (
              <PresencePill presence={presence} onOpen={() => open("chat")} />
            )}

            {/* A floating drawer: clicking the stage puts it away. */}
            {!compact && !docked && drawer && !pinned && (
              <button
                type="button"
                aria-label="Close the panel"
                className="absolute inset-0 z-20 cursor-default"
                onClick={() => open(null)}
              />
            )}

            {/* The drawer (and the whole compact window). The conversation inside it is always mounted. */}
            <aside
              aria-label={
                compact
                  ? "Conversation"
                  : drawer
                    ? DRAWER_TITLE[drawer]
                    : "Panel"
              }
              className={`glass flex min-h-0 flex-col overflow-hidden rounded-2xl ${drawerClass}`}
              style={drawerStyle}
            >
              {/* Resize: the docked panel's inner edge; a floating one's sides and corner. */}
              {free && drawer && !collapsed && !expanded && !panel.drag && (
                <>
                  {(floating ? (["w", "e", "s", "se"] as const) : ([place === "left" ? "e" : "w"] as const)).map((edge) => (
                    <div
                      key={edge}
                      role="separator"
                      aria-orientation={edge === "s" ? "horizontal" : "vertical"}
                      aria-label="Resize the panel"
                      onPointerDown={(e) => panel.startResize(e, edge)}
                      className={`group/rs absolute z-10 ${
                        edge === "w"
                          ? "inset-y-3 left-0 w-2 cursor-ew-resize"
                          : edge === "e"
                            ? "inset-y-3 right-0 w-2 cursor-ew-resize"
                            : edge === "s"
                              ? "inset-x-3 bottom-0 h-2 cursor-ns-resize"
                              : "bottom-0 right-0 size-4 cursor-nwse-resize"
                      }`}
                    >
                      {edge !== "se" && (
                        <span
                          className={`absolute rounded-full bg-accent/0 transition-colors group-hover/rs:bg-accent/70 ${edge === "s" ? "inset-x-1/3 bottom-0.5 h-1" : `inset-y-1/3 w-1 ${edge === "w" ? "left-0.5" : "right-0.5"}`}`}
                        />
                      )}
                    </div>
                  ))}
                </>
              )}
              {collapsed && (
                // Collapsed: a slim strip (docked) or a small bar (floating); click to open it again.
                <button
                  type="button"
                  onClick={() => panel.update((l) => ({ ...l, collapsed: false }))}
                  className={`flex flex-1 items-center gap-2 text-sm text-muted hover:text-text ${floating ? "px-3 py-2" : "flex-col py-3"}`}
                  title="Open the panel again"
                  aria-label={`Open ${drawer ? DRAWER_TITLE[drawer] : "the panel"} again`}
                >
                  {place === "left" ? <ChevronsRight className="size-4" aria-hidden /> : <ChevronsLeft className="size-4" aria-hidden />}
                  <span className={floating ? "truncate" : "[writing-mode:vertical-rl]"}>{drawer ? DRAWER_TITLE[drawer] : ""}</span>
                </button>
              )}
              {compact ? (
                <div className="flex items-center gap-1 border-b border-border px-2 py-1">
                  <span className="hud-label flex-1 pl-1">Compact</span>
                  <button
                    type="button"
                    className="icon-btn size-8"
                    onClick={() => void setWindow({ pinned: !onTop })}
                    aria-pressed={onTop}
                    aria-label={
                      onTop
                        ? "Stop keeping on top"
                        : "Keep on top of other windows"
                    }
                    title={onTop ? "Stop keeping on top" : "Keep on top"}
                  >
                    {onTop ? (
                      <PinOff className="size-4" aria-hidden />
                    ) : (
                      <Pin className="size-4" aria-hidden />
                    )}
                  </button>
                  <button
                    type="button"
                    className="icon-btn size-8"
                    onClick={() => void setWindow({ size: "normal" })}
                    aria-label="Back to the full window"
                    title="Full window"
                  >
                    <Maximize2 className="size-4" aria-hidden />
                  </button>
                </div>
              ) : (
                <header
                  onPointerDown={free ? panel.startMove : undefined}
                  className={`relative flex items-center gap-1 border-b border-border px-2 py-1.5 ${free ? "cursor-grab touch-none select-none active:cursor-grabbing" : ""} ${collapsed ? "hidden" : ""}`}
                  title={free ? "Drag to move: drop on the left or right edge to dock, anywhere else to float" : undefined}
                >
                  {free && <GripVertical className="size-3.5 shrink-0 text-muted" aria-hidden />}
                  <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
                    {drawer ? DRAWER_TITLE[drawer] : ""}
                  </h2>
                  {free && (
                    <>
                      <button
                        type="button"
                        className={`icon-btn size-7 ${placeMenu ? "text-accent" : ""}`}
                        onClick={() => setPlaceMenu((v) => !v)}
                        aria-expanded={placeMenu}
                        aria-label="Where the panel sits"
                        title="Dock left, dock right or float"
                      >
                        {place === "left" ? <PanelLeft className="size-3.5" aria-hidden /> : place === "right" ? <PanelRight className="size-3.5" aria-hidden /> : <Move className="size-3.5" aria-hidden />}
                      </button>
                      {placeMenu && (
                        <div className="pop-in absolute right-2 top-full z-50 mt-1 w-44 rounded-xl border border-border bg-solid p-1 shadow-2xl" role="menu">
                          {(
                            [
                              ["left", "Dock left", <PanelLeft key="l" className="size-3.5" aria-hidden />],
                              ["right", "Dock right", <PanelRight key="r" className="size-3.5" aria-hidden />],
                              ["float", "Float over the stage", <Move key="f" className="size-3.5" aria-hidden />],
                            ] as const
                          ).map(([p, label, icon]) => (
                            <button
                              key={p}
                              type="button"
                              role="menuitemradio"
                              aria-checked={place === p}
                              onClick={() => {
                                setPlaceMenu(false);
                                if (!pinned) {
                                  setPinned(true);
                                  store("drawer.pinned", "true");
                                }
                                panel.update((l) => ({ ...l, place: p, expanded: false, collapsed: false }));
                              }}
                              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-surface-strong ${place === p ? "text-accent" : ""}`}
                            >
                              {icon}
                              {label}
                            </button>
                          ))}
                        </div>
                      )}
                      {pinned && !expanded && (
                        <button
                          type="button"
                          className="icon-btn size-7"
                          onClick={() => panel.update((l) => ({ ...l, collapsed: true }))}
                          aria-label="Collapse the panel"
                          title="Collapse"
                        >
                          {place === "left" ? <ChevronsLeft className="size-3.5" aria-hidden /> : <ChevronsRight className="size-3.5" aria-hidden />}
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-btn size-7"
                        onClick={() => panel.update((l) => ({ ...l, expanded: !l.expanded, collapsed: false }))}
                        aria-pressed={expanded}
                        aria-label={expanded ? "Back to its size" : "Expand over the stage"}
                        title={expanded ? "Back to its size" : "Expand"}
                      >
                        {expanded ? <Shrink className="size-3.5" aria-hidden /> : <Expand className="size-3.5" aria-hidden />}
                      </button>
                    </>
                  )}
                  {!phone && (
                    <button
                      type="button"
                      className="icon-btn size-7"
                      onClick={() => {
                        setPinned((p) => !p);
                        store("drawer.pinned", String(!pinned));
                      }}
                      aria-pressed={pinned}
                      aria-label={
                        pinned
                          ? "Unpin: close when I click the stage"
                          : "Pin: keep this panel open"
                      }
                      title={pinned ? "Pinned" : "Pin"}
                    >
                      {pinned ? (
                        <Pin className="size-3.5" aria-hidden />
                      ) : (
                        <PinOff className="size-3.5" aria-hidden />
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-btn size-7"
                    onClick={() => open(null)}
                    aria-label="Close the panel"
                    title="Close (Esc)"
                  >
                    <X className="size-4" aria-hidden />
                  </button>
                </header>
              )}
              <div
                className={`min-h-0 flex-1 flex-col ${(compact || drawer === "chat") && !collapsed ? "flex" : "hidden"}`}
              >
                <Companion
                  status={status}
                  onOpenSetup={() => open("setup")}
                  onOpenControls={() => open("controls")}
                  onPresence={setPresence}
                />
              </div>
              {!compact && !collapsed && drawer && drawer !== "chat" && (
                <div className="drawer-body @container min-h-0 flex-1">
                  <Suspense fallback={<Loading />}>
                    {drawerContent(drawer)}
                  </Suspense>
                </div>
              )}
            </aside>
          </div>

          {!compact && !phone && (
            <Rail top={top} items={items} bottom={bottom} />
          )}
        </div>
        {!compact && phone && (
          <Rail top={top} items={items} bottom={bottom} horizontal />
        )}
      </div>
      {board && <ShortcutBoard onClose={() => setBoard(false)} />}
      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        commands={commands}
        sources={sources}
      />
    </Frame>
  );
}

const Loading = () => (
  <div className="grid h-full place-items-center text-xs text-muted">
    Loading…
  </div>
);

/**
 * Window frame. While the owner check waits, the app stays mounted (the
 * conversation survives) but is hidden and inert behind the lock screen.
 */
function Frame({
  children,
  status,
  locked = false,
  overlay,
  tabs,
}: {
  children: ReactNode;
  status?: RuntimeStatus | null;
  locked?: boolean;
  overlay?: ReactNode;
  tabs?: ReactNode;
}) {
  return (
    <div className="relative flex h-full flex-col">
      <div className="aurora" aria-hidden />
      <TitleBar status={status ?? null} tabs={tabs} />
      <div
        className={`flex min-h-0 flex-1 ${locked ? "invisible" : ""}`}
        inert={locked}
        aria-hidden={locked || undefined}
      >
        {children}
      </div>
      {overlay && (
        <div className="absolute inset-x-0 bottom-0 top-10 z-40 flex">
          {overlay}
        </div>
      )}
    </div>
  );
}

const PHASE: Record<RuntimePhaseName, string> = {
  starting: "Starting",
  setup: "Setup needed",
  checking: "Checking providers",
  ready: "Online",
  restarting: "Restarting",
  stopped: "Stopped",
};
type RuntimePhaseName = RuntimeStatus["phase"];

/**
 * The window's own title bar: a drag region with the logo and live status.
 * Windows draws its real caption buttons over the right edge (titleBarOverlay);
 * the env() insets keep our content clear of them.
 */
function TitleBar({ status, tabs }: { status: RuntimeStatus | null; tabs?: ReactNode }) {
  const phase = status?.phase ?? "starting";
  // Full control is never on unnoticed: an amber badge here, one click turns it off.
  const [fullControl, setFullControl] = useState(false);
  useEffect(() => {
    void window.controls.state().then((s) => setFullControl(s.fullControl.on), () => undefined);
    return window.controls.onState((s) => setFullControl(s.fullControl.on));
  }, []);
  return (
    <header className="titlebar flex h-10 shrink-0 items-center gap-2.5 pl-4 select-none">
      <img
        src={logo}
        alt=""
        className="size-5 drop-shadow-[0_0_8px_rgba(34,211,238,0.6)]"
      />
      <span className="text-[13px] font-semibold tracking-wide">{nameOf()}</span>
      <ModeChip
        phase={phase}
        label={PHASE[phase]}
        mode={status?.mode ?? null}
      />
      {tabs}
      {fullControl && (
        <button
          type="button"
          onClick={() => void window.controls.setFullControl(false).catch(() => undefined)}
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          className="flex items-center gap-1.5 rounded-full border border-warm/70 bg-warm/15 px-2 py-0.5 text-[11px] font-medium text-warm shadow-[0_0_12px_rgba(251,191,36,0.35)] hover:bg-warm/25"
          title={`${nameOf()} acts on your commands without asking. Click to turn it off.`}
        >
          <span className="size-1.5 animate-pulse rounded-full bg-warm" aria-hidden />
          Full control
        </button>
      )}
    </header>
  );
}

const SURFACE_ICON: Record<Surface, ReactNode> = {
  home: <Brain className="size-3.5" aria-hidden />,
  world: <Globe2 className="size-3.5" aria-hidden />,
  habits: <Fingerprint className="size-3.5" aria-hidden />,
  browser: <Compass className="size-3.5" aria-hidden />,
};

/** The window's tabs: Brain, World, Browser; split into two panes side by side, and swap them. */
function StageTabs({
  layout,
  focused,
  browserShown,
  canSplit,
  onShow,
  onSplit,
  onSwap,
}: {
  layout: StageLayout;
  focused: "main" | "side";
  browserShown: boolean;
  canSplit: boolean;
  onShow: (s: Surface) => void;
  onSplit: () => void;
  onSwap: () => void;
}) {
  const split = canSplit && layout.side !== null;
  return (
    <nav
      aria-label="Views"
      className="ml-2 flex items-center gap-0.5 rounded-full border border-border bg-surface p-0.5"
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
    >
      {SURFACES.map((x) => {
        const where = layout.main === x ? "main" : split && layout.side === x ? "side" : null;
        const on = where !== null || (x === "browser" && browserShown);
        return (
          <button
            key={x}
            type="button"
            onClick={() => onShow(x)}
            aria-pressed={on}
            title={where ? `${SURFACE_LABEL[x]} (${split ? (where === "main" ? "left pane" : "right pane") : "showing"})` : `Show ${SURFACE_LABEL[x]}${split ? ` in the ${focused === "main" ? "left" : "right"} pane` : ""}`}
            className={`flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${on ? "bg-accent/20 text-text" : "text-muted hover:text-text"} ${where && split && where === focused ? "ring-1 ring-accent/60" : ""}`}
          >
            {SURFACE_ICON[x]}
            {SURFACE_LABEL[x]}
          </button>
        );
      })}
      {canSplit && (
        <button
          type="button"
          onClick={onSplit}
          aria-pressed={split}
          title={split ? "One pane" : "Two panes side by side"}
          className={`icon-btn size-6 ${split ? "text-accent" : ""}`}
        >
          <Columns2 className="size-3.5" aria-hidden />
        </button>
      )}
      {split && (
        <button type="button" onClick={onSwap} title="Swap the panes" className="icon-btn size-6">
          <ArrowLeftRight className="size-3.5" aria-hidden />
        </button>
      )}
    </nav>
  );
}

/** The bar between two panes: drag to share the width. */
function PaneDivider({
  onRatio,
  container,
}: {
  onRatio: (r: number) => void;
  container: React.RefObject<HTMLDivElement | null>;
}) {
  const [drag, setDrag] = useState(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panes"
      style={{ order: 1 }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDrag(true);
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const r = container.current?.getBoundingClientRect();
        if (r) onRatio((e.clientX - r.left) / r.width);
      }}
      onPointerUp={() => setDrag(false)}
      className="group relative z-20 mx-0.5 flex w-2 shrink-0 cursor-col-resize items-center justify-center"
    >
      <span className={`h-12 w-1 rounded-full transition-colors ${drag ? "bg-accent" : "bg-border group-hover:bg-accent/60"}`} />
    </div>
  );
}

const MODE_HINT: Record<UiMode, string> = {
  companion: "Talks with you and speaks up when it helps",
  work: "Task-first; still speaks up when it helps",
  focus: "Only urgent things interrupt; the rest waits",
  quiet: "Nothing spoken; urgent shown silently, the rest waits",
};

/** The status chip in the title bar: online state and mode; click to change the mode from anywhere. */
function ModeChip({
  phase,
  label,
  mode,
}: {
  phase: RuntimePhaseName;
  label: string;
  mode: UiMode | null;
}) {
  const [open, setOpen] = useState(false);
  const ready = phase === "ready";
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement | null)?.closest?.("[data-mode-chip]")) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <span
      data-mode-chip
      className="relative"
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
    >
      <button
        type="button"
        disabled={!ready}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={ready ? "Change mode" : label}
        className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-muted hover:border-accent/60 hover:text-text disabled:hover:border-border"
      >
        <span
          className={`size-1.5 rounded-full ${phase === "ready" ? "bg-ok" : phase === "setup" || phase === "stopped" ? "bg-danger" : "thinking-dot bg-warm"}`}
          aria-hidden
        />
        {label}
        {mode && ready ? <span className="capitalize"> · {mode}</span> : null}
        {ready && <ChevronDown className="size-3" aria-hidden />}
      </button>
      {open && (
        <div
          role="menu"
          className="glass absolute left-0 top-full z-50 mt-1.5 w-64 rounded-xl p-1 shadow-2xl"
        >
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="menuitemradio"
              aria-checked={mode === m}
              onClick={() => {
                setOpen(false);
                void window.assistant.setMode(m).catch(() => undefined);
              }}
              className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-strong ${mode === m ? "text-accent" : ""}`}
            >
              <span
                className={`mt-1.5 size-1.5 shrink-0 rounded-full ${mode === m ? "bg-accent" : "bg-border"}`}
                aria-hidden
              />
              <span>
                <span className="block text-xs font-medium capitalize">{m}</span>
                <span className="block text-[10px] text-muted">{MODE_HINT[m]}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
