# Windows' own file and folder pickers for Atlas (host/index.ts).
# Input: $env:ATLAS_DIALOG = {"kind":"open"|"folder"|"save","title":"","multi":false,"filter":"Name|*.x|All files|*.*","initial":""}
# Output: a JSON array of the chosen paths (empty when cancelled).
$ErrorActionPreference = 'Stop'
$req = $env:ATLAS_DIALOG | ConvertFrom-Json

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class AtlasFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW {}

  [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint c, IntPtr specs);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint i);
    void Advise(IntPtr sink, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void GetResult(out IShellItem item);
    void AddPlace(IShellItem item, int place);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string ext);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
    void GetResults(out IShellItemArray items);
    void GetSelectedItems(out IShellItemArray items);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetAttributes(uint mask, out uint attrs);
    void Compare(IShellItem item, uint hint, out int order);
  }

  [ComImport, Guid("b63ea76d-1f85-456f-a19c-48159efa858b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemArray {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetPropertyStore(int flags, ref Guid riid, out IntPtr ppv);
    void GetPropertyDescriptionList(IntPtr keyType, ref Guid riid, out IntPtr ppv);
    void GetAttributes(int flags, uint mask, out uint attrs);
    void GetCount(out uint count);
    void GetItemAt(uint index, out IShellItem item);
    void EnumItems(out IntPtr penum);
  }

  const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_ALLOWMULTISELECT = 0x200, FOS_PATHMUSTEXIST = 0x800;
  const uint SIGDN_FILESYSPATH = 0x80058000;

  public static string[] Pick(IntPtr owner, string title, bool multi) {
    var dlg = (IFileOpenDialog)new FileOpenDialogRCW();
    uint opts;
    dlg.GetOptions(out opts);
    opts |= FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST;
    if (multi) opts |= FOS_ALLOWMULTISELECT;
    dlg.SetOptions(opts);
    if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);
    if (dlg.Show(owner) != 0) return new string[0];
    IShellItemArray items;
    dlg.GetResults(out items);
    uint n;
    items.GetCount(out n);
    var paths = new List<string>();
    for (uint i = 0; i < n; i++) {
      IShellItem item;
      items.GetItemAt(i, out item);
      string path;
      item.GetDisplayName(SIGDN_FILESYSPATH, out path);
      paths.Add(path);
    }
    return paths.ToArray();
  }
}
'@

# An invisible owner on top of everything, so the picker opens in front of the browser.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Show()
$owner.Activate()

$paths = @()
try {
  switch ($req.kind) {
    'folder' {
      $paths = [AtlasFolderPicker]::Pick($owner.Handle, [string]$req.title, [bool]$req.multi)
    }
    'save' {
      $d = New-Object System.Windows.Forms.SaveFileDialog
      $d.Title = [string]$req.title
      $d.Filter = [string]$req.filter
      if ($req.initial) {
        $d.InitialDirectory = [System.IO.Path]::GetDirectoryName([string]$req.initial)
        $d.FileName = [System.IO.Path]::GetFileName([string]$req.initial)
      }
      if ($d.ShowDialog($owner) -eq 'OK') { $paths = @($d.FileName) }
    }
    default {
      $d = New-Object System.Windows.Forms.OpenFileDialog
      $d.Title = [string]$req.title
      $d.Filter = [string]$req.filter
      $d.Multiselect = [bool]$req.multi
      if ($req.initial) { $d.InitialDirectory = [string]$req.initial }
      if ($d.ShowDialog($owner) -eq 'OK') { $paths = $d.FileNames }
    }
  }
} finally {
  $owner.Close()
}
ConvertTo-Json -InputObject @($paths) -Compress
