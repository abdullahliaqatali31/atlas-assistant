# Atlas's system probe: reads (never changes) Wi-Fi, Bluetooth, network,
# battery and installed apps. One JSON request per line on stdin, one JSON
# answer per line on stdout: {"id":1,"cmd":"status"} -> {"id":1,"ok":true,"result":{...}}
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(6000)) { throw 'Windows did not answer in time.' }
  $task.Result
}
$null = [Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime]
$null = [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
$null = [Windows.Devices.Bluetooth.BluetoothDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
$null = [Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]

function Get-Radios {
  $list = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
  @($list | ForEach-Object { @{ kind = "$($_.Kind)"; on = ("$($_.State)" -eq 'On') } })
}

function Get-Bluetooth {
  $out = @()
  $classic = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync([Windows.Devices.Bluetooth.BluetoothDevice]::GetDeviceSelectorFromPairingState($true))) ([Windows.Devices.Enumeration.DeviceInformationCollection])
  foreach ($i in $classic) {
    try {
      $d = Await ([Windows.Devices.Bluetooth.BluetoothDevice]::FromIdAsync($i.Id)) ([Windows.Devices.Bluetooth.BluetoothDevice])
      if ($d) { $out += @{ name = $d.Name; connected = ("$($d.ConnectionStatus)" -eq 'Connected'); kind = "$($d.ClassOfDevice.MajorClass)"; minor = "$($d.ClassOfDevice.MinorClass)"; le = $false } }
    } catch {}
  }
  $le = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync([Windows.Devices.Bluetooth.BluetoothLEDevice]::GetDeviceSelectorFromPairingState($true))) ([Windows.Devices.Enumeration.DeviceInformationCollection])
  foreach ($i in $le) {
    try {
      $d = Await ([Windows.Devices.Bluetooth.BluetoothLEDevice]::FromIdAsync($i.Id)) ([Windows.Devices.Bluetooth.BluetoothLEDevice])
      if ($d) { $out += @{ name = $d.Name; connected = ("$($d.ConnectionStatus)" -eq 'Connected'); kind = "$($d.Appearance.Category)"; minor = ''; le = $true } }
    } catch {}
  }
  $out
}

function Get-Network {
  $profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object {
      @{ name = $_.Name; alias = $_.InterfaceAlias; ipv4 = "$($_.IPv4Connectivity)"; ipv6 = "$($_.IPv6Connectivity)" }
    })
  $adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up' | ForEach-Object {
      @{ name = $_.Name; description = $_.InterfaceDescription; media = "$($_.PhysicalMediaType)"; speed = "$($_.LinkSpeed)"; physical = [bool]$_.HardwareInterface }
    })
  # netsh needs Windows location services (Windows 11 24H2+); its answer is passed on raw and parsed in Node.
  $wlan = (& netsh.exe wlan show interfaces 2>&1 | Out-String)
  @{ profiles = $profiles; adapters = $adapters; wlan = $wlan; wlanOk = ($LASTEXITCODE -eq 0) }
}

function Get-Battery {
  $b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $b) { return $null }
  @{ percent = [int]$b.EstimatedChargeRemaining; status = [int]$b.BatteryStatus }
}

Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class AtlasFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
}
'@

function Get-Foreground {
  $h = [AtlasFg]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][AtlasFg]::GetWindowText($h, $sb, 512)
  $procId = 0
  [void][AtlasFg]::GetWindowThreadProcessId($h, [ref]$procId)
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  @{ title = $sb.ToString(); process = if ($p) { $p.ProcessName } else { '' } }
}

function Get-Apps {
  @(Get-StartApps | ForEach-Object { @{ name = $_.Name; id = $_.AppID } })
}

# The Windows Search index: every word must match the file name or the text inside. Words are
# letters, digits and a few marks only (checked again in Node), so nothing reaches the SQL unescaped.
function Search-Index($arg) {
  $words = @($arg.words | Where-Object { $_ -match '^[\p{L}\p{N}._-]{1,40}$' })
  if ($words.Count -eq 0) { return @() }
  $where = ($words | ForEach-Object { "(System.FileName LIKE '%$_%' OR CONTAINS(*, '`"$_*`"'))" }) -join ' AND '
  if ($arg.kind -and $arg.kind -match '^[a-z]+$') { $where += " AND System.Kind = '$($arg.kind)'" }
  if ($arg.since -and $arg.since -match '^\d{4}-\d{2}-\d{2}$') { $where += " AND System.DateModified >= '$($arg.since)'" }
  $conn = New-Object -ComObject ADODB.Connection
  $rs = New-Object -ComObject ADODB.Recordset
  $conn.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
  try {
    $rs.Open("SELECT TOP 80 System.ItemPathDisplay, System.ItemName, System.DateModified, System.Size, System.Kind FROM SystemIndex WHERE $where ORDER BY System.DateModified DESC", $conn)
    $out = @()
    while (-not $rs.EOF) {
      $modified = $rs.Fields.Item('System.DateModified').Value
      $out += @{
        path = [string]$rs.Fields.Item('System.ItemPathDisplay').Value
        name = [string]$rs.Fields.Item('System.ItemName').Value
        modified = if ($modified) { ([DateTime]$modified).ToUniversalTime().ToString('o') } else { '' }
        size = [double]($rs.Fields.Item('System.Size').Value -as [double])
        kind = (@($rs.Fields.Item('System.Kind').Value) -join '/')
      }
      $rs.MoveNext()
    }
    $out
  } finally {
    if ($rs.State -ne 0) { $rs.Close() }
    $conn.Close()
  }
}

function Run($cmd, $arg) {
  switch ($cmd) {
    'status' {
      $r = @{}
      foreach ($part in @('radios', 'bluetooth', 'network', 'battery')) {
        try {
          $r[$part] = switch ($part) { 'radios' { Get-Radios } 'bluetooth' { Get-Bluetooth } 'network' { Get-Network } 'battery' { Get-Battery } }
        } catch { $r["$($part)Error"] = $_.Exception.Message }
      }
      $r
    }
    'apps' { Get-Apps }
    'foreground' { Get-Foreground }
    'search' { Search-Index $arg }
    default { throw "Unknown command $cmd" }
  }
}

[Console]::Out.WriteLine('{"ready":true}')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $result = Run $req.cmd $req.arg
    [Console]::Out.WriteLine((@{ id = $id; ok = $true; result = $result } | ConvertTo-Json -Depth 6 -Compress))
  } catch {
    [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress))
  }
}
