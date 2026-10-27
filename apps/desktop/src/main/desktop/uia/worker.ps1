# Atlas desktop worker host. Compiles Uia.cs once (cached as a DLL next to
# it), then answers one JSON request per line on stdin with one JSON line on
# stdout. Started and stopped by Atlas; it never acts on its own.
param([Parameter(Mandatory = $true)][string]$Cs, [Parameter(Mandatory = $true)][string]$Dll)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Web.Extensions
try {
  if (-not (Test-Path -LiteralPath $Dll)) {
    Add-Type -LiteralPath $Cs -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase, System.Web.Extensions -OutputAssembly $Dll -OutputType Library
  }
  Add-Type -LiteralPath $Dll
} catch {
  [Console]::Out.WriteLine((@{ ready = $false; error = "$_" } | ConvertTo-Json -Compress))
  exit 1
}
[Console]::Out.WriteLine('{"ready":true}')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line.Length -eq 0) { continue }
  try {
    if ($line.Contains('"cmd":"apps"')) {
      # Start menu apps (desktop and Store), with the id Windows uses to launch them.
      $id = ($line | ConvertFrom-Json).id
      $apps = @(Get-StartApps | Where-Object { $_.AppID -notmatch 'unins|uninstall' } | ForEach-Object { @{ name = $_.Name; appId = $_.AppID } })
      [Console]::Out.WriteLine((@{ id = $id; ok = $true; result = $apps } | ConvertTo-Json -Compress -Depth 4))
    } else {
      [Console]::Out.WriteLine([AtlasUia]::Handle($line))
    }
  } catch {
    [Console]::Out.WriteLine((@{ id = $null; ok = $false; error = "$_" } | ConvertTo-Json -Compress))
  }
}
