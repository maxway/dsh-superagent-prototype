if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT -and -not ('Superagent.RuntimeDirectoryHandle' -as [type])) {
  Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Superagent {
  public static class RuntimeDirectoryHandle {
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation {
      public uint Attributes;
      public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
      public uint VolumeSerialNumber;
      public uint FileSizeHigh;
      public uint FileSizeLow;
      public uint NumberOfLinks;
      public uint FileIndexHigh;
      public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetFileType(SafeFileHandle handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetDriveTypeW(string root);

    public static void RejectReparseDirectory(string path) {
      using (SafeFileHandle handle = CreateFileW(path, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open directory: " + path);
        if (GetFileType(handle) != 1) throw new InvalidOperationException("Only disk directories are supported: " + path);
        FileInformation information;
        if (!GetFileInformationByHandle(handle, out information)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect directory: " + path);
        if ((information.Attributes & 0x400) != 0) throw new InvalidOperationException("Reparse points are not supported: " + path);
        if ((information.Attributes & 0x10) == 0) throw new InvalidOperationException("Path is not a directory: " + path);
      }
    }

    public static string Resolve(string path) {
      using (SafeFileHandle handle = CreateFileW(path, 0x80, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open directory: " + path);
        if (GetFileType(handle) != 1) throw new InvalidOperationException("Only disk directories are supported: " + path);
        FileInformation information;
        if (!GetFileInformationByHandle(handle, out information)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect directory: " + path);
        if ((information.Attributes & 0x10) == 0) throw new InvalidOperationException("Path is not a directory: " + path);
        uint capacity = 512;
        while (true) {
          var result = new StringBuilder((int)capacity);
          uint length = GetFinalPathNameByHandleW(handle, result, capacity, 1);
          if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot resolve directory: " + path);
          if (length < capacity) {
            string resolved = result.ToString();
            int end = resolved.IndexOf('}');
            if (!resolved.StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase) || end < 0 || end + 1 >= resolved.Length || resolved[end + 1] != '\\') throw new InvalidOperationException("Unsupported volume path: " + resolved);
            uint type = GetDriveTypeW(resolved.Substring(0, end + 2));
            if (type != 2 && type != 3 && type != 6) throw new InvalidOperationException("Only local volumes are supported: " + resolved);
            return resolved;
          }
          if (length >= 32767) throw new InvalidOperationException("Resolved directory path is too long: " + path);
          capacity = length + 1;
        }
      }
    }
  }
}
'@
}

function Get-RuntimePhysicalDirectoryPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { throw 'Physical directory resolution requires Windows.' }
  if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.Contains([char]0)) { throw 'Only absolute local DOS paths are supported.' }
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $resolved = [Superagent.RuntimeDirectoryHandle]::Resolve($fullPath)
  if ($resolved -notmatch '^\\\\\?\\Volume\{[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\}\\') { throw "Unsupported resolved directory path: $resolved" }
  $root = $resolved.Substring(0, $resolved.IndexOf('}') + 2)
  if ($resolved.Length -eq $root.Length) { return $root }
  return $resolved.TrimEnd('\')
}

function Test-RuntimeDirectoryAncestor {
  param(
    [Parameter(Mandatory = $true)][string]$Ancestor,
    [Parameter(Mandatory = $true)][string]$Path
  )
  foreach ($candidate in @($Ancestor, $Path)) {
    if ($candidate -notmatch '^\\\\\?\\Volume\{[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\}\\' -or $candidate.Contains('/') -or $candidate.Contains([char]0)) { throw 'Expected normalized local volume GUID paths.' }
    $suffix = $candidate.Substring($candidate.IndexOf('}') + 2)
    if ($suffix -and @($suffix.Split('\') | Where-Object { $_ -in @('', '.', '..') }).Count) { throw 'Expected normalized local volume GUID paths.' }
  }
  $parentRootEnd = $Ancestor.IndexOf('}') + 1
  $childRootEnd = $Path.IndexOf('}') + 1
  if (-not $Ancestor.Substring(0, $parentRootEnd).Equals($Path.Substring(0, $childRootEnd), [StringComparison]::OrdinalIgnoreCase)) { throw 'Cross-volume paths require manual inspection.' }
  $parent = $Ancestor.Substring($parentRootEnd).TrimEnd('\')
  $child = $Path.Substring($childRootEnd).TrimEnd('\')
  return $child.Equals($parent, [StringComparison]::OrdinalIgnoreCase) -or $child.StartsWith($parent + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Get-RuntimeValidatedDirectoryPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) { throw 'Directory chain validation requires Windows.' }
  if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.Contains([char]0)) { throw 'Only absolute local DOS paths are supported.' }
  if (@($Path.Substring(3).Split([char[]]'\/') | Where-Object { $_ -in @('.', '..') }).Count) { throw 'Dot segments are not supported.' }
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($fullPath)
  $directories = [System.Collections.Generic.List[string]]::new()
  $current = $fullPath.TrimEnd('\')
  if ($current.Length -lt $root.Length) { $current = $root }
  while ($true) {
    $directories.Add($current)
    if ($current.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { break }
    $current = [System.IO.Path]::GetDirectoryName($current)
    if (-not $current) { throw 'Cannot determine directory ancestry.' }
  }
  $directories.Reverse()
  $physicalRoot = $null
  $resolved = $null
  foreach ($directory in $directories) {
    [Superagent.RuntimeDirectoryHandle]::RejectReparseDirectory($directory)
    $resolved = Get-RuntimePhysicalDirectoryPath $directory
    if ($null -eq $physicalRoot) { $physicalRoot = $resolved }
    elseif (-not (Test-RuntimeDirectoryAncestor $physicalRoot $resolved)) { throw 'Directory chain escapes its root.' }
  }
  return $resolved
}
