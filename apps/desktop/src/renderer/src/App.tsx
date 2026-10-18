import {
  AppWindow,
  Brain,
  FolderKanban,
  FolderOpen,
  Globe2,
  Home as HomeIcon,
  ListTodo,
  Maximize2,
  MessageSquare,
  Minimize2,
  Newspaper,
  Pin,
  PinOff,
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
  type ReactNode,
} from "react";

import type { ControlState } from "../../shared/control.ts";
import type { IdentityView } from "../../shared/identity.ts";
import type { RuntimeStatus } from "../../shared/ipc.ts";
import type { UiChange, View } from "../../shared/ui.ts";
import logo from "./assets/logo.svg";
import { Companion } from "./Companion.tsx";
import { PausedBanner } from "./Controls.tsx";
import { Home } from "./Home.tsx";
import { ActivityCard, NowCard, TodayCard, type Presence } from "./Jarvis.tsx";
import { LockScreen } from "./LockScreen.tsx";
import { Setup } from "./Setup.tsx";
import { useCounts, type CountKey } from "./shell/counts.ts";
import { Rail, type RailItem } from "./shell/Rail.tsx";

// Pages load the first time they open: a lighter start.
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

type Stage = "home" | "world";
type DrawerId =
  | "chat"
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
  today: "Today",
  news: "News",
  projects: "Projects",
  files: "Files",
  apps: "Apps",
  learning: "Learning",
  controls: "Connections",
  setup: "Settings",
};

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
  const [stage, setStage] = useState<Stage>(() =>
    stored("stage", "home") === "world" ? "world" : "home",
  );
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
  const [compact, setCompact] = useState(false);
  const [onTop, setOnTop] = useState(false);
  const [identity, setIdentity] = useState<IdentityView | null>(null);
  const [suggestions, setSuggestions] = useState(0);
  const [unread, setUnread] = useState(0);
  const drawerRef = useRef(drawer);
  drawerRef.current = drawer;

  const open = (d: DrawerId | null) => {
    setDrawer(d);
    store("drawer", d ?? "");
    if (d === "chat") setUnread(0);
  };
  const goStage = (s: Stage) => {
    setStage(s);
    store("stage", s);
  };
  const openChat = (yes: boolean) => open(yes ? "chat" : null);

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
      if (c.view === "home" || c.view === "world") {
        goStage(c.view);
        setDrawer((d) => (d === "chat" ? d : null));
      } else if (c.view) open(c.view as DrawerId);
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
  useEffect(() => {
    const view: View = drawer && drawer !== "chat" ? drawer : stage;
    window.ui.report({ view, chatOpen: drawer === "chat", compact });
  }, [stage, drawer, compact]);

  // Esc puts the drawer away (unless pinned).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        drawer &&
        !pinned &&
        !(
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement
        )
      )
        open(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer, pinned]);

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
  });
  const top: RailItem[] = [
    {
      id: "home",
      label: "Home",
      icon: <HomeIcon />,
      active: stage === "home" && (!drawer || drawer === "chat"),
      onClick: () => goStage("home"),
    },
    {
      id: "world",
      label: "World",
      icon: <Globe2 />,
      count: counts.world,
      active: stage === "world" && (!drawer || drawer === "chat"),
      onClick: () => goStage("world"),
    },
  ];
  const items: RailItem[] = [
    item("chat", "Talk", <MessageSquare />, "chat"),
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
    },
    item("setup", "Settings", <Settings2 />),
  ];

  const drawerContent = (d: DrawerId): ReactNode => {
    switch (d) {
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
          <Controls state={controls} onBack={() => open(null)} />
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

  // The drawer sits beside the stage when pinned in a roomy window; otherwise it floats over the stage's edge.
  const docked = pinned && roomy && !phone;
  const wideDrawer =
    drawer === "setup" ||
    drawer === "controls" ||
    drawer === "learning" ||
    drawer === "news" ||
    drawer === "projects";
  const drawerClass = compact
    ? "mx-2 mb-2 flex-1"
    : phone
      ? `absolute inset-0 z-30 mx-2 mb-2 bg-solid/95 ${drawer ? "" : "hidden"}`
      : docked
        ? `mb-2 mr-2 shrink-0 ${wideDrawer ? "w-[min(560px,40vw)]" : "w-[clamp(360px,30vw,440px)]"} ${drawer ? "" : "hidden"}`
        : `absolute inset-y-0 right-0 z-30 mb-2 mr-2 ${wideDrawer ? "w-[min(620px,calc(100%-1rem))]" : "w-[min(440px,calc(100%-1rem))]"} bg-solid/95 shadow-2xl ${drawer ? "" : "hidden"}`;

  return (
    <Frame
      status={status}
      locked={locked}
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
          <div className="relative flex min-h-0 min-w-0 flex-1">
            {!compact && (
              <main
                className={`glass mx-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl ${phone ? "mb-1" : "mb-2"}`}
              >
                {controls && <PausedBanner state={controls} />}
                <div className="min-h-0 flex-1">
                  <Suspense fallback={<Loading />}>
                    {stage === "home" ? (
                      <Home
                        status={status}
                        controls={controls}
                        presence={presence}
                        ownerName={status.setup.ownerName}
                        go={(v) =>
                          v === "news" ? open("news") : open("projects")
                        }
                      />
                    ) : (
                      <WorldPage />
                    )}
                  </Suspense>
                </div>
              </main>
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
            >
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
                <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                  <h2 className="flex-1 truncate text-sm font-medium">
                    {drawer ? DRAWER_TITLE[drawer] : ""}
                  </h2>
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
                className={`min-h-0 flex-1 flex-col ${compact || drawer === "chat" ? "flex" : "hidden"}`}
              >
                <Companion
                  status={status}
                  onOpenSetup={() => open("setup")}
                  onOpenControls={() => open("controls")}
                  onPresence={setPresence}
                />
              </div>
              {!compact && drawer && drawer !== "chat" && (
                <div className="min-h-0 flex-1">
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
}: {
  children: ReactNode;
  status?: RuntimeStatus | null;
  locked?: boolean;
  overlay?: ReactNode;
}) {
  return (
    <div className="relative flex h-full flex-col">
      <div className="aurora" aria-hidden />
      <TitleBar status={status ?? null} />
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
function TitleBar({ status }: { status: RuntimeStatus | null }) {
  const phase = status?.phase ?? "starting";
  return (
    <header className="titlebar flex h-10 shrink-0 items-center gap-2.5 pl-4 select-none">
      <img
        src={logo}
        alt=""
        className="size-5 drop-shadow-[0_0_8px_rgba(34,211,238,0.6)]"
      />
      <span className="text-[13px] font-semibold tracking-wide">Assistant</span>
      <span className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-muted">
        <span
          className={`size-1.5 rounded-full ${phase === "ready" ? "bg-ok" : phase === "setup" || phase === "stopped" ? "bg-danger" : "thinking-dot bg-warm"}`}
          aria-hidden
        />
        {PHASE[phase]}
        {status?.mode && phase === "ready" ? (
          <span className="capitalize"> · {status.mode}</span>
        ) : null}
      </span>
    </header>
  );
}
