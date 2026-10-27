# Windows Hello for Atlas's owner check: is it available, and verify the
# person at the PC (face, fingerprint or PIN) with Windows' own dialog,
# shown over Atlas's window. Prints one JSON line: {"result": "..."}.
param([string]$Mode = 'check', [long]$Hwnd = 0, [string]$Message = 'Confirm it is you')

$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime] | Out-Null
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($op, [Type]$type, [int]$ms) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    if (-not $task.Wait($ms)) { throw 'timeout' }
    $task.Result
  }

  if ($Mode -eq 'check') {
    $r = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]) 15000
    Write-Output (@{ result = "$r" } | ConvertTo-Json -Compress)
    exit 0
  }

  # A desktop app asks through the interop interface, naming its window, so the dialog sits over it.
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AtlasHello {
  [ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
  public interface IUserConsentVerifierInterop {
    [PreserveSig] int RequestVerificationForWindowAsync(IntPtr appWindow, IntPtr message, ref Guid riid, out IntPtr asyncOperation);
  }
  [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr classId, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object factory);
  [DllImport("combase.dll", CharSet = CharSet.Unicode)] static extern int WindowsCreateString(string s, int length, out IntPtr hstring);
  [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr hstring);
  public static object Request(IntPtr hwnd, string message, Guid riid) {
    const string cls = "Windows.Security.Credentials.UI.UserConsentVerifier";
    IntPtr clsId, msg, op;
    Marshal.ThrowExceptionForHR(WindowsCreateString(cls, cls.Length, out clsId));
    Marshal.ThrowExceptionForHR(WindowsCreateString(message, message.Length, out msg));
    try {
      Guid iid = typeof(IUserConsentVerifierInterop).GUID;
      object factory;
      Marshal.ThrowExceptionForHR(RoGetActivationFactory(clsId, ref iid, out factory));
      Marshal.ThrowExceptionForHR(((IUserConsentVerifierInterop)factory).RequestVerificationForWindowAsync(hwnd, msg, ref riid, out op));
      return Marshal.GetObjectForIUnknown(op);
    } finally {
      WindowsDeleteString(msg);
      WindowsDeleteString(clsId);
    }
  }
}
'@
  $resultType = [Windows.Security.Credentials.UI.UserConsentVerificationResult]
  $opType = [Windows.Foundation.IAsyncOperation`1].MakeGenericType($resultType)
  $op = $null
  if ($Hwnd -ne 0) {
    try { $op = [AtlasHello]::Request([IntPtr]$Hwnd, $Message, $opType.GUID) } catch { $op = $null }
  }
  # No window, or the interop path failed: Windows' plain dialog still works.
  if ($null -eq $op) { $op = [Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($Message) }
  $r = Await $op $resultType 120000
  Write-Output (@{ result = "$r" } | ConvertTo-Json -Compress)
} catch {
  Write-Output (@{ result = 'Error'; error = "$($_.Exception.Message)" } | ConvertTo-Json -Compress)
}
