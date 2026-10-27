# Atlas's eyes (runtime/vision.ts): a picture of the screen, or of the window in front,
# scaled to at most 1568 px on its long side, as JPEG in base64 on one line: "<width> <height> <base64>".
param([string]$What = 'full')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AtlasEyes {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
}
'@
[void][AtlasEyes]::SetProcessDPIAware()

if ($What -eq 'window') {
  $h = [AtlasEyes]::GetForegroundWindow()
  $r = New-Object AtlasEyes+RECT
  # The visible frame (without the invisible resize border), else the plain window rectangle.
  if ([AtlasEyes]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -ne 0) { [void][AtlasEyes]::GetWindowRect($h, [ref]$r) }
  $x = $r.Left; $y = $r.Top; $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
} else {
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $x = $b.X; $y = $b.Y; $w = $b.Width; $hh = $b.Height
}
if ($w -lt 8 -or $hh -lt 8) { throw 'Nothing to look at.' }

$shot = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($shot)
$g.CopyFromScreen($x, $y, 0, 0, $shot.Size)
$g.Dispose()

$scale = [Math]::Min(1.0, 1568.0 / [Math]::Max($w, $hh))
$tw = [int]([Math]::Round($w * $scale)); $th = [int]([Math]::Round($hh * $scale))
$small = New-Object System.Drawing.Bitmap $tw, $th
$g = [System.Drawing.Graphics]::FromImage($small)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($shot, 0, 0, $tw, $th)
$g.Dispose(); $shot.Dispose()

$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 82L
$ms = New-Object System.IO.MemoryStream
$small.Save($ms, $codec, $params)
$small.Dispose()
[Console]::Out.Write("$tw $th " + [Convert]::ToBase64String($ms.ToArray()))
