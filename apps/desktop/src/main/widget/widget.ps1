# Atlas's desktop widget window (main/widget/service.ts): a frameless, always-on-top WebView2 window
# showing the widget page, with Windows 11 acrylic behind it. It moves where the gateway says, smoothly,
# and tells the gateway about displays coming and going.
# In (stdin, one per line, fields split by tabs):
#   bounds <x> <y> <w> <h> <animate 0|1>   (physical pixels) | show | hide | topmost <0|1> | look <clear|frosted>
#   shape <ellipse|round> <corner radius>   (the orb goes without Windows' own rounded corners and their shadow)
#   post <json for the page> | displays | exit
# Out (stdout): ready <acrylic 0|1> | displays <json list> | moved <x> <y> <w> <h> | page <json from the page>
#   | shown | hidden | error <text>
param([string]$Url, [string]$Data, [string]$Lib, [string]$Look = 'clear')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$core = Join-Path $Lib 'Microsoft.Web.WebView2.Core.dll'
$forms = Join-Path $Lib 'Microsoft.Web.WebView2.WinForms.dll'
Add-Type -Path $core
Add-Type -Path $forms
Add-Type -WarningAction SilentlyContinue -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Management, $core, $forms -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

public class AtlasWidget : Form {
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);
  [StructLayout(LayoutKind.Sequential)] struct MARGINS { public int l, r, t, b; }
  [DllImport("dwmapi.dll")] static extern int DwmExtendFrameIntoClientArea(IntPtr h, ref MARGINS m);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool ReleaseCapture();
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(Point p, uint flags);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr mon, int type, out uint dx, out uint dy);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string device, uint index, ref DISPLAY_DEVICE dd, uint flags);

  static readonly IntPtr TOPMOST = new IntPtr(-1), NOTOPMOST = new IntPtr(-2);
  const uint SWP_NOACTIVATE = 0x0010, SWP_NOZORDER = 0x0004, SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001;

  readonly WebView2 web = new WebView2();
  readonly ConcurrentQueue<string> inbox = new ConcurrentQueue<string>();
  readonly System.Windows.Forms.Timer anim = new System.Windows.Forms.Timer();
  readonly string url, data;
  Rectangle from, to;
  DateTime animStart;
  bool acrylic, onTop = true;
  string look;
  string shape = "round";
  int radius = 28;

  static void Say(string line) { Console.Out.WriteLine(line); Console.Out.Flush(); }

  public AtlasWidget(string url, string data, string look) {
    this.url = url;
    this.data = data;
    this.look = look;
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    TopMost = true;
    StartPosition = FormStartPosition.Manual;
    AutoScaleMode = AutoScaleMode.None;
    BackColor = Color.Black;
    Text = "Atlas widget";
    Bounds = new Rectangle(-2000, -2000, 420, 160);
    web.Dock = DockStyle.Fill;
    web.DefaultBackgroundColor = Color.Transparent;
    var props = new CoreWebView2CreationProperties();
    props.UserDataFolder = data;
    web.CreationProperties = props;
    Controls.Add(web);
    web.CoreWebView2InitializationCompleted += OnWebReady;
    anim.Interval = 15;
    anim.Tick += (s, e) => Step();
    var reader = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) inbox.Enqueue(line);
      inbox.Enqueue("exit");
    });
    reader.IsBackground = true;
    reader.Start();
    var pump = new System.Windows.Forms.Timer();
    pump.Interval = 40;
    pump.Tick += (s, e) => { string l; while (inbox.TryDequeue(out l)) OnLine(l); };
    pump.Start();
    Microsoft.Win32.SystemEvents.DisplaySettingsChanged += (s, e) => BeginInvoke(new Action(ReportDisplays));
    ResizeEnd += (s, e) => Say("moved\t" + Left + "\t" + Top + "\t" + Width + "\t" + Height);
  }

  // Windows' own rounded corners come with a soft shadow, which showed as a faint box around the round
  // orb: the orb goes without them. (Cutting the window to a shape is no way out: with a window region,
  // Windows stops clearing the see-through parts, and the turning orb leaves trails.)
  void Shape() {
    int corner = shape == "ellipse" ? 1 : 2;
    if (corner != cornerSet) { cornerSet = corner; DwmSetWindowAttribute(Handle, 33, ref corner, 4); }
  }
  int cornerSet = 2;

  // Appearing never takes the focus from what the owner is doing.
  protected override bool ShowWithoutActivation { get { return true; } }

  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    var m = new MARGINS { l = -1, r = -1, t = -1, b = -1 };
    DwmExtendFrameIntoClientArea(Handle, ref m);
    int dark = 1; DwmSetWindowAttribute(Handle, 20, ref dark, 4);
    int round = 2; DwmSetWindowAttribute(Handle, 33, ref round, 4);
    // No outline from Windows around the window: only what the page draws shows.
    int noBorder = unchecked((int)0xFFFFFFFE); DwmSetWindowAttribute(Handle, 34, ref noBorder, 4);
    ApplyLook();
  }

  /**
   * clear: nothing behind the page, so only Atlas floats over the desktop; frosted: Windows 11's acrylic
   * glass behind it (Windows 10 answers no: the page then draws its own background).
   */
  void ApplyLook() {
    int backdrop = look == "frosted" ? 3 : 1;
    acrylic = DwmSetWindowAttribute(Handle, 38, ref backdrop, 4) == 0 && look == "frosted" && Environment.OSVersion.Version.Build >= 22000;
  }

  protected override void OnShown(EventArgs e) {
    base.OnShown(e);
    web.EnsureCoreWebView2Async(null);
  }

  void OnWebReady(object sender, CoreWebView2InitializationCompletedEventArgs e) {
    if (!e.IsSuccess) { Say("error\tWebView2: " + (e.InitializationException == null ? "unknown" : e.InitializationException.Message)); return; }
    var core = web.CoreWebView2;
    core.Settings.AreDefaultContextMenusEnabled = false;
    core.Settings.IsStatusBarEnabled = false;
    core.Settings.IsZoomControlEnabled = false;
    // The microphone (talking to Atlas) and notices, for Atlas's own page only.
    core.PermissionRequested += (s, a) => {
      bool own = a.Uri.StartsWith(OriginOf(url));
      a.State = own && (a.PermissionKind == CoreWebView2PermissionKind.Microphone || a.PermissionKind == CoreWebView2PermissionKind.Notifications) ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
    };
    // It shows Atlas and nothing else: links open in the owner's browser.
    core.NavigationStarting += (s, a) => { if (!a.Uri.StartsWith(OriginOf(url))) { a.Cancel = true; } };
    core.NewWindowRequested += (s, a) => { a.Handled = true; Say("page\t{\"open\":" + Json(a.Uri) + "}"); };
    core.WebMessageReceived += (s, a) => {
      string msg = a.TryGetWebMessageAsString();
      if (msg == "drag") { ReleaseCapture(); SendMessage(Handle, 0xA1, new IntPtr(2), IntPtr.Zero); return; }
      Say("page\t" + msg);
    };
    core.Navigate(url);
    Say("ready\t" + (acrylic ? "1" : "0"));
    ReportDisplays();
  }

  static string OriginOf(string u) { var x = new Uri(u); return x.Scheme + "://" + x.Authority; }

  static string Json(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < 32) b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  void OnLine(string line) {
    var f = line.Split('\t');
    try {
      switch (f[0]) {
        case "bounds": MoveTo(new Rectangle(int.Parse(f[1]), int.Parse(f[2]), int.Parse(f[3]), int.Parse(f[4])), f.Length > 5 && f[5] == "1"); break;
        case "show": if (!Visible) Show(); SetTop(onTop); Say("shown"); break;
        case "hide": Hide(); Say("hidden"); break;
        case "topmost": onTop = f[1] == "1"; SetTop(onTop); break;
        case "look": look = f[1]; ApplyLook(); Say("look\t" + (acrylic ? "1" : "0")); break;
        case "shape": shape = f[1]; radius = f.Length > 2 ? int.Parse(f[2]) : 28; Shape(); break;
        case "post": if (web.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsJson(f[1]); break;
        case "displays": ReportDisplays(); break;
        case "exit": Application.Exit(); break;
      }
    } catch (Exception ex) { Say("error\t" + ex.Message.Replace('\t', ' ').Replace('\n', ' ')); }
  }

  void SetTop(bool on) { TopMost = on; SetWindowPos(Handle, on ? TOPMOST : NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE); }

  // ── smooth moves: an eased glide from where it is to where it should be ──
  void MoveTo(Rectangle target, bool animate) {
    if (!animate || !Visible || Left < -1000) { anim.Stop(); Place(target); return; }
    from = Bounds; to = target; animStart = DateTime.Now;
    anim.Start();
  }

  void Step() {
    double t = Math.Min(1, (DateTime.Now - animStart).TotalMilliseconds / 320.0);
    double k = 1 - Math.Pow(1 - t, 3);
    Place(new Rectangle(
      (int)Math.Round(from.X + (to.X - from.X) * k), (int)Math.Round(from.Y + (to.Y - from.Y) * k),
      (int)Math.Round(from.Width + (to.Width - from.Width) * k), (int)Math.Round(from.Height + (to.Height - from.Height) * k)));
    if (t >= 1) anim.Stop();
  }

  void Place(Rectangle r) { SetWindowPos(Handle, IntPtr.Zero, r.X, r.Y, r.Width, r.Height, SWP_NOZORDER | SWP_NOACTIVATE); }

  // ── displays: where they are, how big, their scale and their real names ──
  void ReportDisplays() {
    var names = MonitorNames();
    var b = new StringBuilder("[");
    var screens = Screen.AllScreens;
    for (int i = 0; i < screens.Length; i++) {
      var s = screens[i];
      uint dx = 96, dy = 96;
      try { GetDpiForMonitor(MonitorFromPoint(new Point(s.Bounds.X + 1, s.Bounds.Y + 1), 2), 0, out dx, out dy); } catch { }
      string name = "";
      var dd = new DISPLAY_DEVICE(); dd.cb = Marshal.SizeOf(dd);
      if (EnumDisplayDevices(s.DeviceName, 0, ref dd, 0)) {
        name = dd.DeviceString;
        // MONITOR\DEL41B8\{...}: the maker-model code, matched to the monitor's own name.
        var parts = (dd.DeviceID ?? "").Split('\\');
        if (parts.Length > 1 && names.ContainsKey(parts[1])) name = names[parts[1]];
      }
      if (i > 0) b.Append(',');
      b.Append("{\"id\":").Append(Json(s.DeviceName)).Append(",\"name\":").Append(Json(name))
        .Append(",\"primary\":").Append(s.Primary ? "true" : "false")
        .Append(",\"x\":").Append(s.Bounds.X).Append(",\"y\":").Append(s.Bounds.Y).Append(",\"w\":").Append(s.Bounds.Width).Append(",\"h\":").Append(s.Bounds.Height)
        .Append(",\"wx\":").Append(s.WorkingArea.X).Append(",\"wy\":").Append(s.WorkingArea.Y).Append(",\"ww\":").Append(s.WorkingArea.Width).Append(",\"wh\":").Append(s.WorkingArea.Height)
        .Append(",\"scale\":").Append((dx / 96.0).ToString(System.Globalization.CultureInfo.InvariantCulture)).Append('}');
    }
    Say("displays\t" + b.Append(']').ToString());
  }

  /** Each connected monitor's own name ("DELL U2723QE"), by its maker-model code. */
  static Dictionary<string, string> MonitorNames() {
    var map = new Dictionary<string, string>();
    try {
      using (var q = new ManagementObjectSearcher(@"root\wmi", "SELECT InstanceName, UserFriendlyName FROM WmiMonitorID")) {
        foreach (ManagementObject m in q.Get()) {
          var raw = m["UserFriendlyName"] as ushort[];
          var inst = (m["InstanceName"] as string) ?? "";
          if (raw == null) continue;
          var name = new StringBuilder();
          foreach (var c in raw) if (c != 0) name.Append((char)c);
          var parts = inst.Split('\\');
          if (parts.Length > 1 && name.Length > 0) map[parts[1]] = name.ToString();
        }
      }
    } catch { }
    return map;
  }

  public static void Run(string url, string data, string look) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    Application.EnableVisualStyles();
    var w = new AtlasWidget(url, data, look);
    w.Show();
    w.Hide();
    Application.Run();
  }
}
'@
[AtlasWidget]::Run($Url, $Data, $Look)
