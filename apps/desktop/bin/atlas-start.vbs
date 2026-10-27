' Starts Atlas without a console window (Windows runs this at login).
' Arguments pass through: --startup opens the page, --hidden stays in the tray.
' With connect first, it starts Atlas's hands instead (this PC working for a brain elsewhere).
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "start"
args = ""
For Each a In WScript.Arguments
  If a = "connect" Then
    cmd = "connect"
  Else
    args = args & " " & a
  End If
Next
shell.Run "node """ & here & "\atlas.mjs"" " & cmd & args, 0, False
