' Hidden launcher for non-interactive Windows commands.
'
' A scheduled task that starts `node` or `pwsh` directly runs a console program with no console to inherit, so Windows
' creates a visible console window for it and every child that shares it. `wscript.exe` has no console and starts the
' command in a hidden window instead, so the task, the node entry point and its child processes stay off the desktop.
'
' Usage: wscript.exe launch-hidden.vbs <program> [arguments...]
'
' The launcher waits for the child, so the task result and its stop-if-running limit still describe the run, and exits
' with the child's exit code (2 when the command cannot be started). A start failure is appended to
' %TEMP%\dsh-superagent-launch.log; a successful command writes nothing. Interactive use should keep running the original
' command directly, because there is no window to hide.
Option Explicit

Dim shell, fileSystem, command, index, exitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count = 0 Then
  Log "No program to start."
  WScript.Quit 2
End If

command = Quote(WScript.Arguments(0))
For index = 1 To WScript.Arguments.Count - 1
  command = command & " " & Quote(WScript.Arguments(index))
Next

On Error Resume Next
' 0 hides the window; True waits so the task reports the child's exit code.
exitCode = shell.Run(command, 0, True)
If Err.Number <> 0 Then
  Log "Could not start " & WScript.Arguments(0) & ": " & Err.Description
  WScript.Quit 2
End If
WScript.Quit exitCode

Sub Log(message)
  On Error Resume Next
  Dim stream
  Set stream = fileSystem.OpenTextFile(fileSystem.BuildPath(shell.ExpandEnvironmentStrings("%TEMP%"), "dsh-superagent-launch.log"), 8, True)
  stream.WriteLine Now & " " & message
  stream.Close
End Sub

Function Quote(value)
  Quote = """" & Replace(value, """", """""") & """"
End Function