// Atlas desktop worker: Windows UI Automation, window control, keyboard and
// mouse input, and the "watch me" recorder. Compiled once by Windows
// PowerShell (C# 5, .NET Framework 4), driven by JSON lines from Atlas.
// Policy lives in Atlas, not here: this only does what it is asked, refuses
// password fields, and never reads or types secrets.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public static class AtlasUia
{
    // ── Win32 ────────────────────────────────────────────────────────────
    delegate bool EnumProc(IntPtr h, IntPtr l);
    delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern int ToUnicode(uint vk, uint scan, byte[] state, StringBuilder buf, int size, uint flags);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder s, ref int size);
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32First(IntPtr snap, ref PROCESSENTRY32 e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32Next(IntPtr snap, ref PROCESSENTRY32 e);

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr w; public IntPtr l; public uint time; public POINT pt; }
    [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vk; public uint scan; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32
    {
        public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID;
        public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 2, KEYEVENTF_UNICODE = 4;
    const uint MOUSEEVENTF_LEFTDOWN = 2, MOUSEEVENTF_LEFTUP = 4;
    const int SW_RESTORE = 9, SW_SHOWNOACTIVATE = 4;
    const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80;
    const uint GW_OWNER = 4, GA_ROOT = 2;

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };

    // ── entry point: one JSON request in, one JSON response out ─────────
    public static string Handle(string line)
    {
        object id = null;
        try
        {
            var req = (Dictionary<string, object>)Json.DeserializeObject(line);
            id = req.ContainsKey("id") ? req["id"] : null;
            var args = req.ContainsKey("args") && req["args"] is Dictionary<string, object> ? (Dictionary<string, object>)req["args"] : new Dictionary<string, object>();
            var cmd = (string)req["cmd"];
            object result;
            switch (cmd)
            {
                case "ping": result = "pong"; break;
                case "windows": result = Windows(); break;
                case "dialogs": result = Dialogs(Long(args, "hwnd")); break;
                case "snapshot": result = Snapshot(Long(args, "hwnd"), Int(args, "maxNodes", 300), Bool(args, "offscreen", false)); break;
                case "query": result = Query(Long(args, "hwnd"), Str(args, "role"), Str(args, "name"), Str(args, "match") ?? "contains", Str(args, "within"), Str(args, "notWithin"), Int(args, "limit", 50), Bool(args, "offscreen", false)); break;
                case "texts": result = Texts(Str(args, "ref"), Int(args, "limit", 200)); break;
                case "act": result = Act(Long(args, "hwnd"), Str(args, "ref"), Str(args, "action"), Str(args, "text")); break;
                case "keys": result = Keys(Long(args, "hwnd"), Str(args, "keys")); break;
                case "focus": result = Focus(new IntPtr(Long(args, "hwnd"))) ? "focused" : "could not bring the window to the front"; break;
                case "show": ShowWindow(new IntPtr(Long(args, "hwnd")), SW_SHOWNOACTIVATE); result = "shown"; break;
                case "launch": Process.Start("explorer.exe", "shell:AppsFolder\\" + Str(args, "appId")); result = "launched"; break;
                case "recordStart": result = RecordStart(); break;
                case "recordStop": result = RecordStop(); break;
                default: throw new Exception("Unknown command " + cmd);
            }
            return Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "result", result } });
        }
        catch (Exception e)
        {
            var msg = e is ElementNotAvailableException ? "That element is gone (the screen changed). Read the window again." : e.Message;
            return Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", msg } });
        }
    }

    static string Str(Dictionary<string, object> a, string k) { return a.ContainsKey(k) && a[k] != null ? Convert.ToString(a[k]) : null; }
    static long Long(Dictionary<string, object> a, string k) { if (!a.ContainsKey(k)) throw new Exception("Missing " + k); return Convert.ToInt64(a[k]); }
    static int Int(Dictionary<string, object> a, string k, int d) { return a.ContainsKey(k) && a[k] != null ? Convert.ToInt32(a[k]) : d; }
    static bool Bool(Dictionary<string, object> a, string k, bool d) { return a.ContainsKey(k) && a[k] != null ? Convert.ToBoolean(a[k]) : d; }

    // ── processes and windows ────────────────────────────────────────────
    static string ExePath(uint pid)
    {
        var h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (h == IntPtr.Zero) return "";
        try { var sb = new StringBuilder(1024); int n = sb.Capacity; return QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : ""; }
        finally { CloseHandle(h); }
    }

    static Dictionary<uint, uint> ParentMap()
    {
        var map = new Dictionary<uint, uint>();
        var snap = CreateToolhelp32Snapshot(2, 0);
        var e = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32)) };
        if (Process32First(snap, ref e)) do { map[e.th32ProcessID] = e.th32ParentProcessID; } while (Process32Next(snap, ref e));
        CloseHandle(snap);
        return map;
    }

    static HashSet<uint> Family(uint root)
    {
        var parents = ParentMap();
        var set = new HashSet<uint> { root };
        bool grew = true;
        while (grew) { grew = false; foreach (var kv in parents) if (!set.Contains(kv.Key) && set.Contains(kv.Value) && kv.Key != kv.Value) { set.Add(kv.Key); grew = true; } }
        return set;
    }

    static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
    static string Class(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }

    static List<Dictionary<string, object>> Windows()
    {
        var list = new List<Dictionary<string, object>>();
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h) || GetWindow(h, GW_OWNER) != IntPtr.Zero || (GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
            var title = Title(h);
            if (title.Length == 0) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            list.Add(new Dictionary<string, object> { { "hwnd", h.ToInt64() }, { "title", title }, { "pid", pid }, { "exe", ExePath(pid) }, { "minimized", IsIconic(h) }, { "className", Class(h) } });
            return true;
        }, IntPtr.Zero);
        return list;
    }

    /// <summary>Visible windows owned by an app's window: its Save, Open and message dialogs.</summary>
    static List<Dictionary<string, object>> Dialogs(long owner)
    {
        uint ownerPid; GetWindowThreadProcessId(new IntPtr(owner), out ownerPid);
        var family = Family(ownerPid);
        var list = new List<Dictionary<string, object>>();
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h)) return true;
            var o = GetWindow(h, GW_OWNER);
            if (o == IntPtr.Zero) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (o.ToInt64() != owner && !family.Contains(pid)) return true;
            list.Add(new Dictionary<string, object> { { "hwnd", h.ToInt64() }, { "title", Title(h) }, { "className", Class(h) }, { "pid", pid } });
            return true;
        }, IntPtr.Zero);
        return list;
    }

    static bool Focus(IntPtr h)
    {
        if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
        if (GetForegroundWindow() == h) return true;
        // Windows lets the process that sent the last input change focus. A zero-distance mouse
        // nudge is that input; no key is pressed (a tapped Alt would open menus in many apps).
        var nudge = new INPUT[1];
        nudge[0].type = INPUT_MOUSE;
        nudge[0].u.mi.dwFlags = 0x0001; // MOUSEEVENTF_MOVE, 0,0
        SendInput(1, nudge, Marshal.SizeOf(typeof(INPUT)));
        uint pid;
        var fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        var me = GetCurrentThreadId();
        var attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
        try
        {
            BringWindowToTop(h);
            SetForegroundWindow(h);
        }
        finally
        {
            if (attached) AttachThreadInput(me, fgThread, false);
        }
        for (int i = 0; i < 20 && GetForegroundWindow() != h; i++) Thread.Sleep(25);
        Thread.Sleep(60);
        return GetForegroundWindow() == h;
    }

    // ── the element tree ────────────────────────────────────────────────
    static readonly Dictionary<string, AutomationElement> Refs = new Dictionary<string, AutomationElement>();
    static int nextRef = 1;

    static string Ref(AutomationElement el)
    {
        if (Refs.Count > 6000) { Refs.Clear(); }
        var r = "e" + (nextRef++);
        Refs[r] = el;
        return r;
    }

    static AutomationElement Get(string r)
    {
        AutomationElement el;
        if (r == null || !Refs.TryGetValue(r, out el)) throw new Exception("Unknown element " + r + ". Read the window again.");
        return el;
    }

    /// <summary>The window, plus embedded Chromium content (WebView2 in WinUI apps such as WhatsApp) that Windows does not link into the tree.</summary>
    static List<AutomationElement> Roots(IntPtr hwnd)
    {
        var roots = new List<AutomationElement> { AutomationElement.FromHandle(hwnd) };
        // A Save or Open dialog is native: never mix the app's web content into it.
        if (Class(hwnd) == "#32770") return roots;
        var hasDocument = roots[0].FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document)) != null;
        if (hasDocument) return roots;
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        var family = Family(pid);
        var widgets = new List<IntPtr>();
        EnumWindows((top, l) =>
        {
            EnumChildWindows(top, (h, l2) =>
            {
                uint p; GetWindowThreadProcessId(h, out p);
                if (family.Contains(p) && Class(h) == "Chrome_RenderWidgetHostHWND" && IsWindowVisible(h)) widgets.Add(h);
                return true;
            }, IntPtr.Zero);
            return true;
        }, IntPtr.Zero);
        foreach (var w in widgets.Distinct()) { try { roots.Add(AutomationElement.FromHandle(w)); } catch { } }
        return roots;
    }

    static readonly HashSet<string> Interactive = new HashSet<string> { "button", "edit", "hyperlink", "menuitem", "checkbox", "radiobutton", "combobox", "tabitem", "listitem", "dataitem", "treeitem", "slider", "spinner", "splitbutton", "document" };
    static readonly HashSet<string> Structural = new HashSet<string> { "pane", "group", "custom", "window" };

    static string Role(AutomationElement.AutomationElementInformation c) { return c.ControlType.ProgrammaticName.Replace("ControlType.", "").ToLowerInvariant(); }

    static string Clip(string s, int n) { if (string.IsNullOrEmpty(s)) return ""; s = s.Replace("\r", " ").Replace("\n", " ").Trim(); return s.Length > n ? s.Substring(0, n) + "…" : s; }

    static string ValueOf(AutomationElement el, AutomationElement.AutomationElementInformation c)
    {
        if (c.IsPassword) return "(hidden)";
        object p;
        if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p)) { try { return ((ValuePattern)p).Current.Value; } catch { } }
        return "";
    }

    static string States(AutomationElement el)
    {
        var s = new List<string>();
        object p;
        try
        {
            if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p) && ((TogglePattern)p).Current.ToggleState == ToggleState.On) s.Add("on");
            if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p) && ((SelectionItemPattern)p).Current.IsSelected) s.Add("selected");
            if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) s.Add(((ExpandCollapsePattern)p).Current.ExpandCollapseState == ExpandCollapseState.Expanded ? "expanded" : "collapsed");
        }
        catch { }
        return s.Count > 0 ? " " + string.Join(" ", s) : "";
    }

    static string Snapshot(long hwnd, int maxNodes, bool offscreen)
    {
        var h = new IntPtr(hwnd);
        if (IsIconic(h)) { ShowWindow(h, SW_SHOWNOACTIVATE); Thread.Sleep(400); }
        var sb = new StringBuilder();
        uint pid; GetWindowThreadProcessId(h, out pid);
        sb.Append("Window \"").Append(Clip(Title(h), 120)).Append("\" (").Append(System.IO.Path.GetFileName(ExePath(pid))).Append(")\n");
        int count = 0;
        bool truncated = false;
        var walker = TreeWalker.ControlViewWalker;
        Action<AutomationElement, int, string> walk = null;
        walk = (el, depth, parentName) =>
        {
            if (count >= maxNodes) { truncated = true; return; }
            AutomationElement.AutomationElementInformation c;
            try { c = el.Current; } catch { return; }
            if (!offscreen && c.IsOffscreen && depth > 0) return;
            var role = Role(c);
            var name = Clip(c.Name, 200);
            var interactive = Interactive.Contains(role) && c.IsEnabled;
            var meaningful = interactive || (!Structural.Contains(role) && role != "image" && name.Length > 0 && name != parentName) || (role == "group" && name.Length > 0 && name.Length < 120 && name != parentName);
            var childDepth = depth;
            if (meaningful)
            {
                count++;
                sb.Append(new string(' ', Math.Min(depth, 20) * 2)).Append("- ").Append(role);
                if (name.Length > 0) sb.Append(" \"").Append(name.Replace("\"", "'")).Append("\"");
                if (role == "edit" || role == "combobox") { var v = Clip(ValueOf(el, c), 300); if (v.Length > 0) sb.Append(" value=\"").Append(v.Replace("\"", "'")).Append("\""); }
                if (c.IsPassword) sb.Append(" password");
                sb.Append(States(el));
                if (interactive) sb.Append(" [").Append(Ref(el)).Append("]");
                sb.Append("\n");
                childDepth = depth + 1;
            }
            var child = walker.GetFirstChild(el);
            while (child != null && count < maxNodes)
            {
                walk(child, childDepth, meaningful ? name : parentName);
                try { child = walker.GetNextSibling(child); } catch { break; }
            }
        };
        var roots = Roots(h);
        for (int i = 0; i < roots.Count; i++) { if (i == 1) sb.Append("(embedded web content)\n"); walk(roots[i], 0, ""); }
        if (truncated) sb.Append("…more elements not shown; use find with a name to reach them.\n");
        return sb.ToString();
    }

    static bool Matches(string have, string want, string mode)
    {
        if (string.IsNullOrEmpty(want)) return true;
        have = (have ?? "").ToLowerInvariant(); want = want.ToLowerInvariant();
        return mode == "exact" ? have == want : mode == "starts" ? have.StartsWith(want) : have.Contains(want);
    }

    static bool IsInside(AutomationElement el, AutomationElement ancestor)
    {
        var walker = TreeWalker.ControlViewWalker;
        var p = el;
        for (int i = 0; i < 60 && p != null; i++) { if (Automation.Compare(p, ancestor)) return true; try { p = walker.GetParent(p); } catch { return false; } }
        return false;
    }

    static List<Dictionary<string, object>> Query(long hwnd, string role, string name, string match, string within, string notWithin, int limit, bool offscreen)
    {
        var h = new IntPtr(hwnd);
        if (IsIconic(h)) { ShowWindow(h, SW_SHOWNOACTIVATE); Thread.Sleep(400); }
        var scopes = within != null ? new List<AutomationElement> { Get(within) } : Roots(h);
        var exclude = notWithin != null ? Get(notWithin) : null;
        var found = new List<Dictionary<string, object>>();
        foreach (var scope in scopes)
        {
            AutomationElementCollection all;
            try { all = scope.FindAll(TreeScope.Descendants, Condition.TrueCondition); } catch { continue; }
            foreach (AutomationElement el in all)
            {
                if (found.Count >= limit) break;
                AutomationElement.AutomationElementInformation c;
                try { c = el.Current; } catch { continue; }
                if (role != null && Role(c) != role.ToLowerInvariant()) continue;
                if (!offscreen && c.IsOffscreen) continue;
                if (!Matches(c.Name, name, match)) continue;
                if (exclude != null && IsInside(el, exclude)) continue;
                found.Add(new Dictionary<string, object> { { "ref", Ref(el) }, { "role", Role(c) }, { "name", Clip(c.Name, 600) }, { "value", Clip(ValueOf(el, c), 600) }, { "password", c.IsPassword } });
            }
        }
        return found;
    }

    /// <summary>Every name and value under an element, in order: what a row or panel says.</summary>
    static List<string> Texts(string r, int limit)
    {
        var el = Get(r);
        var list = new List<string>();
        var walker = TreeWalker.ControlViewWalker;
        Action<AutomationElement> walk = null;
        walk = e =>
        {
            if (list.Count >= limit) return;
            AutomationElement.AutomationElementInformation c;
            try { c = e.Current; } catch { return; }
            var n = Clip(c.Name, 2000);
            if (n.Length > 0 && (list.Count == 0 || list[list.Count - 1] != n)) list.Add(n);
            var child = walker.GetFirstChild(e);
            while (child != null && list.Count < limit) { walk(child); try { child = walker.GetNextSibling(child); } catch { break; } }
        };
        walk(el);
        return list;
    }

    // ── acting ───────────────────────────────────────────────────────────
    static void Click(IntPtr hwnd, AutomationElement el)
    {
        object p;
        if (el.TryGetCurrentPattern(ScrollItemPattern.Pattern, out p)) { try { ((ScrollItemPattern)p).ScrollIntoView(); Thread.Sleep(120); } catch { } }
        var r = el.Current.BoundingRectangle;
        if (r.IsEmpty || r.Width < 1) throw new Exception("That element is not on screen.");
        if (!Focus(hwnd)) throw new Exception("Could not bring the window to the front.");
        POINT before; GetCursorPos(out before);
        SetCursorPos((int)(r.Left + r.Width / 2), (int)(r.Top + r.Height / 2));
        Thread.Sleep(30);
        var inputs = new INPUT[2];
        inputs[0].type = INPUT_MOUSE; inputs[0].u.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        inputs[1].type = INPUT_MOUSE; inputs[1].u.mi.dwFlags = MOUSEEVENTF_LEFTUP;
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
        Thread.Sleep(60);
        // Put the pointer back where the owner left it.
        SetCursorPos(before.X, before.Y);
    }

    /// <summary>
    /// Types one character at a time with a pause after each. Apps that fall behind read every
    /// queued Unicode keystroke as the last one sent ("Atlas aaaa"), so the pace matters.
    /// </summary>
    static void TypeText(string text, int pauseMs)
    {
        var size = Marshal.SizeOf(typeof(INPUT));
        foreach (var ch in text)
        {
            if (ch == '\r') continue;
            var inputs = new List<INPUT>();
            if (ch == '\n') { AddVk(inputs, 0x10, false); AddVk(inputs, 0x0D, false); AddVk(inputs, 0x0D, true); AddVk(inputs, 0x10, true); } // Shift+Enter: a new line, not "send"
            else
            {
                var down = new INPUT { type = INPUT_KEYBOARD }; down.u.ki.wScan = ch; down.u.ki.dwFlags = KEYEVENTF_UNICODE;
                var up = new INPUT { type = INPUT_KEYBOARD }; up.u.ki.wScan = ch; up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
                inputs.Add(down); inputs.Add(up);
            }
            SendInput((uint)inputs.Count, inputs.ToArray(), size);
            Thread.Sleep(pauseMs);
        }
    }

    static string Flat(string s) { return System.Text.RegularExpressions.Regex.Replace(s ?? "", @"\s+", " ").Trim(); }

    static string ReadValue(AutomationElement el)
    {
        object p;
        if (!el.TryGetCurrentPattern(ValuePattern.Pattern, out p)) return null;
        try { return ((ValuePattern)p).Current.Value; } catch { return null; }
    }

    /// <summary>Types, then reads the box back; if it came out wrong, removes exactly what was inserted and types again slowly.</summary>
    static string TypeChecked(long hwnd, AutomationElement el, string text)
    {
        var before = ReadValue(el);
        TypeText(text, 12);
        Thread.Sleep(150);
        var after = ReadValue(el);
        if (before == null || after == null) return "typed " + text.Length + " characters (this box cannot be read back to check)";
        if (Flat(after).Contains(Flat(text))) return "typed and checked: the box now contains the text";
        var inserted = after.Length - before.Length;
        if (inserted > 0 && inserted <= text.Length * 2 + 4)
        {
            var wipe = new List<INPUT>();
            for (int i = 0; i < inserted; i++) { AddVk(wipe, 0x08, false); AddVk(wipe, 0x08, true); }
            foreach (var chunk in Enumerable.Range(0, (wipe.Count + 39) / 40).Select(i => wipe.Skip(i * 40).Take(40).ToArray()))
            {
                SendInput((uint)chunk.Length, chunk, Marshal.SizeOf(typeof(INPUT)));
                Thread.Sleep(30);
            }
            Thread.Sleep(150);
            TypeText(text, 35);
            Thread.Sleep(200);
            after = ReadValue(el) ?? "";
            if (Flat(after).Contains(Flat(text))) return "typed and checked (on a second, slower try): the box now contains the text";
        }
        var tail = Flat(after);
        if (tail.Length > 200) tail = "…" + tail.Substring(tail.Length - 200);
        throw new Exception("Typing came out wrong; the box now ends with: \"" + tail + "\". Tell the owner before trying again.");
    }

    static void AddVk(List<INPUT> list, ushort vk, bool up)
    {
        var i = new INPUT { type = INPUT_KEYBOARD };
        i.u.ki.wVk = vk;
        i.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        list.Add(i);
    }

    static string Act(long hwnd, string r, string action, string text)
    {
        var h = new IntPtr(hwnd);
        var el = Get(r);
        var c = el.Current;
        var role = Role(c);
        object p;
        switch (action)
        {
            case "click":
                if ((role == "button" || role == "menuitem" || role == "hyperlink" || role == "splitbutton") && el.TryGetCurrentPattern(InvokePattern.Pattern, out p))
                {
                    ((InvokePattern)p).Invoke();
                    return "clicked " + role + " \"" + Clip(c.Name, 80) + "\"";
                }
                Click(h, el);
                return "clicked " + role + " \"" + Clip(c.Name, 80) + "\"";
            case "toggle":
                if (!el.TryGetCurrentPattern(TogglePattern.Pattern, out p)) throw new Exception("That element cannot be switched on or off.");
                ((TogglePattern)p).Toggle(); return "toggled";
            case "select":
                if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return "selected"; }
                Click(h, el); return "clicked to select";
            case "expand":
                if (!el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) throw new Exception("That element does not expand.");
                ((ExpandCollapsePattern)p).Expand(); return "expanded";
            case "collapse":
                if (!el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) throw new Exception("That element does not collapse.");
                ((ExpandCollapsePattern)p).Collapse(); return "collapsed";
            case "focus":
                if (!Focus(h)) throw new Exception("Could not bring the window to the front.");
                el.SetFocus(); return "focused";
            case "type":
            case "replace":
                if (c.IsPassword) throw new Exception("Atlas never types into password fields.");
                if (action == "replace" && role == "document") throw new Exception("Atlas does not replace a whole document; type into it instead, or ask the owner.");
                if (text == null) throw new Exception("Nothing to type.");
                if (!Focus(h)) throw new Exception("Could not bring the window to the front.");
                try { el.SetFocus(); } catch { Click(h, el); }
                Thread.Sleep(80);
                if (action == "replace")
                {
                    // Native boxes take the value directly; web boxes get Ctrl+A and the new text.
                    if (c.FrameworkId != "Chrome" && el.TryGetCurrentPattern(ValuePattern.Pattern, out p) && !((ValuePattern)p).Current.IsReadOnly)
                    {
                        try { ((ValuePattern)p).SetValue(text); return "set"; } catch { }
                    }
                    Keys(hwnd, "ctrl+a");
                }
                return TypeChecked(hwnd, el, text);
            default:
                throw new Exception("Unknown action " + action);
        }
    }

    static readonly Dictionary<string, ushort> Named = new Dictionary<string, ushort>
    {
        { "enter", 0x0D }, { "return", 0x0D }, { "esc", 0x1B }, { "escape", 0x1B }, { "tab", 0x09 }, { "space", 0x20 }, { "backspace", 0x08 },
        { "delete", 0x2E }, { "del", 0x2E }, { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 }, { "home", 0x24 }, { "end", 0x23 },
        { "pageup", 0x21 }, { "pagedown", 0x22 }, { "ctrl", 0x11 }, { "control", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 }, { "win", 0x5B },
        { "f1", 0x70 }, { "f2", 0x71 }, { "f3", 0x72 }, { "f4", 0x73 }, { "f5", 0x74 }, { "f6", 0x75 }, { "f7", 0x76 }, { "f8", 0x77 }, { "f9", 0x78 }, { "f10", 0x79 }, { "f11", 0x7A }, { "f12", 0x7B },
        { ",", 0xBC }, { ".", 0xBE }, { "/", 0xBF }, { ";", 0xBA }, { "[", 0xDB }, { "]", 0xDD }, { "-", 0xBD }, { "=", 0xBB },
    };

    static string Keys(long hwnd, string keys)
    {
        if (string.IsNullOrWhiteSpace(keys)) throw new Exception("Which keys?");
        if (!Focus(new IntPtr(hwnd))) throw new Exception("Could not bring the window to the front.");
        foreach (var combo in keys.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries))
        {
            var vks = new List<ushort>();
            foreach (var part in combo.ToLowerInvariant().Split('+'))
            {
                ushort vk;
                if (Named.TryGetValue(part, out vk)) vks.Add(vk);
                else if (part.Length == 1) vks.Add((ushort)(VkKeyScan(part[0]) & 0xFF));
                else throw new Exception("Unknown key " + part);
            }
            var inputs = new List<INPUT>();
            foreach (var vk in vks) AddVk(inputs, vk, false);
            for (int i = vks.Count - 1; i >= 0; i--) AddVk(inputs, vks[i], true);
            SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
            Thread.Sleep(60);
        }
        return "pressed " + keys;
    }

    // ── "watch me": clicks and typing while the owner shows a task ─────────
    static Thread hookThread;
    static uint hookThreadId;
    static IntPtr mouseHook, keyHook;
    static HookProc mouseProc, keyProc;
    static readonly object Gate = new object();
    static List<Dictionary<string, object>> recorded;
    static readonly Queue<Action> Pending = new Queue<Action>();
    static Thread resolver;
    static volatile bool recording;
    static bool shift, ctrl, alt;
    static StringBuilder typing;
    static string typingExe;

    static string RecordStart()
    {
        if (recording) return "already recording";
        recorded = new List<Dictionary<string, object>>();
        typing = new StringBuilder();
        recording = true;
        resolver = new Thread(() =>
        {
            while (recording || Pending.Count > 0)
            {
                Action a = null;
                lock (Gate) { if (Pending.Count > 0) a = Pending.Dequeue(); }
                if (a == null) { Thread.Sleep(20); continue; }
                try { a(); } catch { }
            }
        }) { IsBackground = true };
        resolver.SetApartmentState(ApartmentState.MTA);
        resolver.Start();
        hookThread = new Thread(() =>
        {
            hookThreadId = GetCurrentThreadId();
            mouseProc = MouseHook;
            keyProc = KeyHook;
            var mod = GetModuleHandle(null);
            mouseHook = SetWindowsHookEx(14, mouseProc, mod, 0); // WH_MOUSE_LL
            keyHook = SetWindowsHookEx(13, keyProc, mod, 0);     // WH_KEYBOARD_LL
            MSG m;
            while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
            UnhookWindowsHookEx(mouseHook);
            UnhookWindowsHookEx(keyHook);
        }) { IsBackground = true };
        hookThread.Start();
        return "recording";
    }

    static string RecordStop()
    {
        if (!recording) return Json.Serialize(new List<object>());
        recording = false;
        PostThreadMessage(hookThreadId, 0x0012, IntPtr.Zero, IntPtr.Zero); // WM_QUIT
        hookThread.Join(2000);
        resolver.Join(3000);
        FlushTyping();
        return Json.Serialize(recorded);
    }

    static void Enqueue(Action a) { lock (Gate) { Pending.Enqueue(a); } }

    static void Add(Dictionary<string, object> e) { lock (Gate) { if (recorded.Count < 500) recorded.Add(e); } }

    static string ForegroundExe()
    {
        uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        return ExePath(pid);
    }

    static void FlushTyping()
    {
        string text; string exe;
        lock (Gate) { text = typing.ToString(); exe = typingExe; typing.Clear(); }
        if (text.Length > 0) Add(new Dictionary<string, object> { { "kind", "type" }, { "text", text }, { "exe", exe ?? "" }, { "at", DateTime.UtcNow.Ticks } });
    }

    static IntPtr MouseHook(int code, IntPtr w, IntPtr l)
    {
        if (code >= 0 && recording && (int)w == 0x0201) // WM_LBUTTONDOWN
        {
            var info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(MSLLHOOKSTRUCT));
            var pt = new System.Windows.Point(info.pt.X, info.pt.Y);
            Enqueue(() =>
            {
                FlushTyping();
                var el = AutomationElement.FromPoint(pt);
                var c = el.Current;
                // Climb to the nearest thing with a name a person would recognise.
                var walker = TreeWalker.ControlViewWalker;
                var named = el;
                for (int i = 0; i < 6 && named != null && string.IsNullOrWhiteSpace(named.Current.Name); i++) named = walker.GetParent(named);
                var n = named ?? el;
                var nc = n.Current;
                Add(new Dictionary<string, object> { { "kind", "click" }, { "role", Role(nc) }, { "name", Clip(nc.Name, 200) }, { "exe", ExePath((uint)c.ProcessId) }, { "at", DateTime.UtcNow.Ticks } });
            });
        }
        return CallNextHookEx(mouseHook, code, w, l);
    }

    static IntPtr KeyHook(int code, IntPtr w, IntPtr l)
    {
        if (code >= 0 && recording)
        {
            var info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(KBDLLHOOKSTRUCT));
            var down = (int)w == 0x0100 || (int)w == 0x0104;
            var vk = info.vk;
            if (vk == 0xA0 || vk == 0xA1 || vk == 0x10) shift = down;
            else if (vk == 0xA2 || vk == 0xA3 || vk == 0x11) ctrl = down;
            else if (vk == 0xA4 || vk == 0xA5 || vk == 0x12) alt = down;
            else if (down)
            {
                var s = shift; var cl = ctrl; var al = alt;
                Enqueue(() => OnKey(vk, info.scan, s, cl, al));
            }
        }
        return CallNextHookEx(keyHook, code, w, l);
    }

    static void OnKey(uint vk, uint scan, bool s, bool c, bool a)
    {
        string special = null;
        if (vk == 0x0D) special = "enter"; else if (vk == 0x09) special = "tab"; else if (vk == 0x1B) special = "esc";
        else if (vk == 0x08) { lock (Gate) { if (typing.Length > 0) { typing.Length--; return; } } special = "backspace"; }
        else if (vk >= 0x25 && vk <= 0x28) special = new[] { "left", "up", "right", "down" }[vk - 0x25];
        if (c || a || special != null)
        {
            FlushTyping();
            var combo = (c ? "ctrl+" : "") + (a ? "alt+" : "") + (s && (c || a) ? "shift+" : "");
            var key = special ?? KeyName(vk, s);
            if (key.Length == 0) return;
            Add(new Dictionary<string, object> { { "kind", "key" }, { "keys", combo + key }, { "exe", ForegroundExe() }, { "at", DateTime.UtcNow.Ticks } });
            return;
        }
        // Never record what goes into a password field.
        try
        {
            var f = AutomationElement.FocusedElement;
            if (f != null && f.Current.IsPassword) { FlushTyping(); Add(new Dictionary<string, object> { { "kind", "password" }, { "exe", ForegroundExe() }, { "at", DateTime.UtcNow.Ticks } }); return; }
        }
        catch { }
        var ch = KeyName(vk, s);
        if (ch.Length == 0) return;
        var exe = ForegroundExe();
        bool switched;
        lock (Gate) { switched = typing.Length > 0 && typingExe != exe; }
        if (switched) FlushTyping();
        lock (Gate)
        {
            typingExe = exe;
            typing.Append(ch);
        }
    }

    static string KeyName(uint vk, bool s)
    {
        var state = new byte[256];
        if (s) state[0x10] = 0x80;
        var sb = new StringBuilder(8);
        var n = ToUnicode(vk, 0, state, sb, sb.Capacity, 4);
        return n > 0 ? sb.ToString(0, n) : "";
    }
}
