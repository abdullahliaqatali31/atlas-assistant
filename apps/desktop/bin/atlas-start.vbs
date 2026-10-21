' Starts Atlas without a console window (Windows runs this at login).
' Arguments pass through: --startup opens the page, --hidden stays in the tray.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
For Each a In WScript.Arguments
  args = args & " " & a
Next
shell.Run "node """ & here & "\atlas.mjs"" start" & args, 0, False
