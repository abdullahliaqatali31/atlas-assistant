# Atlas's tray icon, global shortcuts and session watch (host/tray.ts), instead of a browser engine.
# In (stdin, one per line, fields split by tabs):
#   menu <tooltip> | item <id> <label> <flags: c checked, d disabled, s separator> | endmenu
#   balloon <title> <text> | hotkey <id> <modifiers> <virtual key> | exit
# Out (stdout): ready | click <id> | hotkey <id> | hotkey-ok <id> | hotkey-fail <id> | balloon-click
#   | session lock | session unlock | session resume | session idle <seconds>
# Locked = Windows' sign-in screen (LogonUI) is up; a resume is a jump in time (the PC slept).
param([string]$Icon)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -WarningAction SilentlyContinue -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public class AtlasTray : NativeWindow {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  const int WM_HOTKEY = 0x0312;

  readonly NotifyIcon icon = new NotifyIcon();
  readonly ConcurrentQueue<string> inbox = new ConcurrentQueue<string>();
  readonly System.Collections.Generic.Dictionary<int, string> hotkeys = new System.Collections.Generic.Dictionary<int, string>();
  ContextMenuStrip pending;
  int nextHotkey = 1;
  bool locked = false;
  DateTime lastLook = DateTime.Now;
  int looks = 0;

  static void Say(string line) { Console.Out.WriteLine(line); Console.Out.Flush(); }

  public AtlasTray(string iconPath) {
    CreateHandle(new CreateParams());
    try { icon.Icon = Icon.FromHandle(new Bitmap(iconPath).GetHicon()); } catch { icon.Icon = SystemIcons.Application; }
    icon.Text = "Atlas";
    icon.Visible = true;
    icon.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) Say("click\topen"); };
    icon.BalloonTipClicked += (s, e) => Say("balloon-click");
    icon.ContextMenuStrip = new ContextMenuStrip();
    var reader = new Thread(() => {
      string line;
      while ((line = Console.In.ReadLine()) != null) inbox.Enqueue(line);
      inbox.Enqueue("exit");
    });
    reader.IsBackground = true;
    reader.Start();
    var timer = new System.Windows.Forms.Timer();
    timer.Interval = 80;
    timer.Tick += (s, e) => { string l; while (inbox.TryDequeue(out l)) OnLine(l); };
    timer.Start();
    var watch = new System.Windows.Forms.Timer();
    watch.Interval = 2000;
    watch.Tick += (s, e) => Watch();
    watch.Start();
    Say("ready");
  }

  /** Every 2 s: the lock screen, sleep (a jump in time), and every 4 s the idle time. */
  void Watch() {
    var now = DateTime.Now;
    if ((now - lastLook).TotalSeconds > 30) Say("session	resume");
    lastLook = now;
    bool isLocked = System.Diagnostics.Process.GetProcessesByName("LogonUI").Length > 0;
    if (isLocked != locked) { locked = isLocked; Say(locked ? "session	lock" : "session	unlock"); }
    if (++looks % 2 == 0) {
      var i = new LASTINPUTINFO();
      i.cbSize = (uint)Marshal.SizeOf(i);
      uint idle = GetLastInputInfo(ref i) ? (uint)((Environment.TickCount - (int)i.dwTime) & 0x7fffffff) / 1000 : 0;
      Say("session	idle	" + idle);
    }
  }

  void OnLine(string line) {
    var f = line.Split('\t');
    switch (f[0]) {
      case "menu":
        pending = new ContextMenuStrip();
        icon.Text = f.Length > 1 ? (f[1].Length > 63 ? f[1].Substring(0, 63) : f[1]) : "Atlas";
        break;
      case "item":
        if (pending == null || f.Length < 4) break;
        if (f[3].Contains("s")) { pending.Items.Add(new ToolStripSeparator()); break; }
        var id = f[1];
        var item = new ToolStripMenuItem(f[2]);
        item.Checked = f[3].Contains("c");
        item.Enabled = !f[3].Contains("d");
        item.Click += (s, e) => Say("click\t" + id);
        pending.Items.Add(item);
        break;
      case "endmenu":
        if (pending != null) { var old = icon.ContextMenuStrip; icon.ContextMenuStrip = pending; pending = null; if (old != null) old.Dispose(); }
        break;
      case "balloon":
        if (f.Length >= 3) icon.ShowBalloonTip(6000, f[1], f[2], ToolTipIcon.None);
        break;
      case "hotkey":
        if (f.Length < 4) break;
        int n = nextHotkey++;
        if (RegisterHotKey(Handle, n, uint.Parse(f[2]) | 0x4000, uint.Parse(f[3]))) { hotkeys[n] = f[1]; Say("hotkey-ok\t" + f[1]); }
        else Say("hotkey-fail\t" + f[1]);
        break;
      case "exit":
        foreach (var k in hotkeys.Keys) UnregisterHotKey(Handle, k);
        icon.Visible = false;
        icon.Dispose();
        Application.Exit();
        break;
    }
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_HOTKEY) { string id; if (hotkeys.TryGetValue(m.WParam.ToInt32(), out id)) Say("hotkey\t" + id); }
    base.WndProc(ref m);
  }
}
'@
$tray = New-Object AtlasTray $Icon
[System.Windows.Forms.Application]::Run()
