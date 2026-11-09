' Hidden launcher for the scheduled Watchdog agent.
'
' wscript.exe has no console window, so a timer-driven check cannot flash a PowerShell window on the operator's desktop.
' This file starts the stable launch-agent.ps1 beside it with the task's arguments (normally -Config <agent.json>) in a
' hidden window and waits for it, so the task result and its stop-if-running limit still describe the agent run. The
' PowerShell launcher reads current.txt and starts that version's agent, so switching versions still does not rewrite the
' task action.
Option Explicit

Dim shell, fileSystem, home, launcher, host, command, index, exitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
home = fileSystem.GetParentFolderName(WScript.ScriptFullName)
launcher = fileSystem.BuildPath(home, "launch-agent.ps1")
If Not fileSystem.FileExists(launcher) Then
  Log "The Watchdog PowerShell launcher is missing: " & launcher
  WScript.Quit 2
End If

' Prefer PowerShell 7; the built-in Windows PowerShell is the fallback.
host = shell.ExpandEnvironmentStrings("%ProgramFiles%\PowerShell\7\pwsh.exe")
If Not fileSystem.FileExists(host) Then host = "powershell.exe"
command = Quote(host) & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & Quote(launcher)
For index = 0 To WScript.Arguments.Count - 1
  command = command & " " & Quote(WScript.Arguments(index))
Next

On Error Resume Next
' 0 hides the window; True waits so the task reports the agent's exit code.
exitCode = shell.Run(command, 0, True)
If Err.Number <> 0 Then
  Log "Could not start the Watchdog launcher: " & Err.Description
  WScript.Quit 2
End If
WScript.Quit exitCode

Sub Log(message)
  On Error Resume Next
  Dim stream
  Set stream = fileSystem.OpenTextFile(fileSystem.BuildPath(home, "launch.log"), 8, True)
  stream.WriteLine Now & " " & message
  stream.Close
End Sub

Function Quote(value)
  Quote = """" & Replace(value, """", """""") & """"
End Function
