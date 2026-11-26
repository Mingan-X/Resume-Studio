param([int]$ChildProcessId, [ValidateSet('suspend','resume')][string]$Action)
$ErrorActionPreference = 'Stop'
$p = Get-Process -Id $ChildProcessId
if ($p.ProcessName -ne 'node') { throw 'Expected own Node fixture process' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TestProcessControl {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);
}
'@
$handle = [TestProcessControl]::OpenProcess(0x0800, $false, $ChildProcessId)
if ($handle -eq [IntPtr]::Zero) { throw 'Cannot open owned child process' }
try {
  if ($Action -eq 'suspend') { $result = [TestProcessControl]::NtSuspendProcess($handle) }
  else { $result = [TestProcessControl]::NtResumeProcess($handle) }
  if ($result -ne 0) { throw 'Process control failed' }
} finally { [void][TestProcessControl]::CloseHandle($handle) }
