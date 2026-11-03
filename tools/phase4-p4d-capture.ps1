param([Parameter(Mandatory=$true)][int]$ProcessId, [Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AawP4dCapture {
 public delegate bool EnumWindowsProc(IntPtr hwnd,IntPtr arg);
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb,IntPtr arg);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd,IntPtr hdc,uint flags);
 [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr context);
 [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd,int attr,out RECT rect,int size);
 public static IntPtr Find(int pid) { IntPtr found=IntPtr.Zero; EnumWindows((hwnd,arg)=>{uint owner;GetWindowThreadProcessId(hwnd,out owner);if(owner==pid && IsWindowVisible(hwnd)){found=hwnd;return false;}return true;},IntPtr.Zero);return found; }
}
'@
[void][AawP4dCapture]::SetProcessDpiAwarenessContext([IntPtr](-4))
$handle = [AawP4dCapture]::Find($ProcessId)
if ($handle -eq [IntPtr]::Zero) { throw 'Exact target window unavailable.' }
$outer = [AawP4dCapture+RECT]::new()
$frame = [AawP4dCapture+RECT]::new()
if (-not [AawP4dCapture]::GetWindowRect($handle,[ref]$outer)) { throw 'Window geometry unavailable.' }
if ([AawP4dCapture]::DwmGetWindowAttribute($handle,9,[ref]$frame,16) -ne 0) { throw 'DWM geometry unavailable.' }
$target = [IO.Path]::GetFullPath($OutputPath)
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.local/quality-evidence')) + [IO.Path]::DirectorySeparatorChar
if (-not $target.StartsWith($allowedRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Capture path escaped evidence root.' }
if ([IO.File]::Exists($target)) { throw 'Refusing to overwrite capture.' }
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
$bitmap = [Drawing.Bitmap]::new(($outer.Right-$outer.Left),($outer.Bottom-$outer.Top),[Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
 $graphics = [Drawing.Graphics]::FromImage($bitmap)
 try { $dc=$graphics.GetHdc(); try { if (-not [AawP4dCapture]::PrintWindow($handle,$dc,2)) { throw 'Exact-window PrintWindow failed.' } } finally { $graphics.ReleaseHdc($dc) } } finally { $graphics.Dispose() }
 $crop = [Drawing.Rectangle]::new(($frame.Left-$outer.Left),($frame.Top-$outer.Top),($frame.Right-$frame.Left),($frame.Bottom-$frame.Top))
 $image = $bitmap.Clone($crop,$bitmap.PixelFormat)
 try { $image.Save($target,[Drawing.Imaging.ImageFormat]::Png) } finally { $image.Dispose() }
} finally { $bitmap.Dispose() }
$sha = [Security.Cryptography.SHA256]::Create()
try { $digest = -join @($sha.ComputeHash([IO.File]::ReadAllBytes($target)) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
[pscustomobject]@{captureMethod='exact-HWND-PrintWindow-PW_RENDERFULLCONTENT';processId=$ProcessId;windowHandle=$handle.ToInt64();width=($frame.Right-$frame.Left);height=($frame.Bottom-$frame.Top);sha256="sha256:$digest";outputPath=$target} | ConvertTo-Json -Compress
