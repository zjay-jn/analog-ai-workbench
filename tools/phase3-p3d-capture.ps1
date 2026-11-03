[CmdletBinding(DefaultParameterSetName = 'Capture')]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$ProcessId,

  [Parameter(ParameterSetName = 'Capture', Mandatory = $true)]
  [string]$OutputPath,

  [Parameter(ParameterSetName = 'Probe', Mandatory = $true)]
  [switch]$ProbeOnly,

  [Parameter(ParameterSetName = 'Close', Mandatory = $true)]
  [switch]$CloseWindow,

  [Parameter(ParameterSetName = 'Resize', Mandatory = $true)]
  [ValidateRange(1, 32767)]
  [int]$ResizeWidth,

  [Parameter(ParameterSetName = 'Resize', Mandatory = $true)]
  [ValidateRange(1, 32767)]
  [int]$ResizeHeight,

  [Parameter(ParameterSetName = 'Tree', Mandatory = $true)]
  [switch]$ProcessTree,

  [Parameter(ParameterSetName = 'Accessibility', Mandatory = $true)]
  [switch]$AccessibilitySnapshot,

  [Parameter(ParameterSetName = 'Absent', Mandatory = $true)]
  [switch]$AssertWindowAbsent
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class AawP3dWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(
    IntPtr hWnd,
    int attribute,
    out RECT value,
    int size
  );

  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(
    IntPtr hWnd,
    IntPtr insertAfter,
    int x,
    int y,
    int width,
    int height,
    uint flags
  );

  [DllImport("user32.dll")]
  public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);

  public static IntPtr FindVisibleWindow(int expectedProcessId) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hWnd, lParam) => {
      uint owner;
      GetWindowThreadProcessId(hWnd, out owner);
      if (owner == (uint)expectedProcessId && IsWindowVisible(hWnd)) {
        RECT rect;
        if (GetWindowRect(hWnd, out rect) && rect.Right > rect.Left && rect.Bottom > rect.Top) {
          found = hWnd;
          return false;
        }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static RECT PhysicalBounds(IntPtr hWnd) {
    RECT rect;
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    if (DwmGetWindowAttribute(
      hWnd,
      DWMWA_EXTENDED_FRAME_BOUNDS,
      out rect,
      Marshal.SizeOf(typeof(RECT))
    ) != 0) {
      if (!GetWindowRect(hWnd, out rect)) {
        throw new InvalidOperationException("The window bounds are unavailable.");
      }
    }
    return rect;
  }
}
'@

[void][AawP3dWin32]::SetProcessDpiAwarenessContext([IntPtr](-4))
$currentSessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$visibleLockAppInSession = @(
  Get-Process -Name LockApp -ErrorAction SilentlyContinue |
    Where-Object {
      $_.SessionId -eq $currentSessionId -and
      [AawP3dWin32]::FindVisibleWindow($_.Id) -ne [IntPtr]::Zero
    }
).Count -gt 0
$interactiveDesktop = -not $visibleLockAppInSession

if ($ProcessTree) {
  $all = @(Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId, ParentProcessId, Name)
  $known = [System.Collections.Generic.HashSet[int]]::new()
  [void]$known.Add($ProcessId)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($candidate in $all) {
      if (
        $known.Contains([int]$candidate.ParentProcessId) -and
        -not $known.Contains([int]$candidate.ProcessId)
      ) {
        [void]$known.Add([int]$candidate.ProcessId)
        $changed = $true
      }
    }
  }
  $rows = @($all | Where-Object { $known.Contains([int]$_.ProcessId) })
  $tcp = @(
    Get-NetTCPConnection -ErrorAction SilentlyContinue |
      Where-Object { $known.Contains([int]$_.OwningProcess) } |
      Select-Object OwningProcess, State, LocalAddress, LocalPort, RemoteAddress, RemotePort
  )
  [pscustomobject]@{
    schemaVersion = 'aaw.phase3-p3d.process-tree/v1'
    rootProcessId = $ProcessId
    processes = $rows
    tcpConnections = $tcp
  } | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

$windowHandle = [AawP3dWin32]::FindVisibleWindow($ProcessId)
if ($AssertWindowAbsent) {
  [pscustomobject]@{
    schemaVersion = 'aaw.phase3-p3d.window-absence/v1'
    processId = $ProcessId
    observationAvailable = $interactiveDesktop
    windowAbsent = $windowHandle -eq [IntPtr]::Zero
  } | ConvertTo-Json -Compress
  exit 0
}
if ($windowHandle -eq [IntPtr]::Zero) {
  throw "No visible top-level window belongs to process $ProcessId."
}
$bounds = [AawP3dWin32]::PhysicalBounds($windowHandle)
$width = $bounds.Right - $bounds.Left
$height = $bounds.Bottom - $bounds.Top

if ($AccessibilitySnapshot) {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($windowHandle)
  if ($root -eq $null) {
    throw 'The exact P3-D accessibility root is unavailable.'
  }
  $elements = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $text = [System.Collections.Generic.List[string]]::new()
  $seenText = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  $typeCounts = [ordered]@{}
  $focusableCount = 0
  $visibleHorizontalBoundsWithinWindow = $true
  $horizontalOverflowCount = 0
  $documentCount = 0
  $documentHorizontalBoundsWithinWindow = $true
  $limit = [Math]::Min($elements.Count, 4096)
  for ($index = 0; $index -lt $limit; $index += 1) {
    try {
      $element = $elements.Item($index)
      $name = [string]$element.Current.Name
      if (
        -not [string]::IsNullOrWhiteSpace($name) -and
        $name.Length -le 512 -and
        $seenText.Add($name)
      ) {
        $text.Add($name)
      }
      $typeName = [string]$element.Current.ControlType.ProgrammaticName
      if (-not $typeCounts.Contains($typeName)) { $typeCounts[$typeName] = 0 }
      $typeCounts[$typeName] = [int]$typeCounts[$typeName] + 1
      if ($element.Current.IsKeyboardFocusable) { $focusableCount += 1 }
      if (-not $element.Current.IsOffscreen) {
        $rect = $element.Current.BoundingRectangle
        if ($typeName -eq 'ControlType.Document') {
          $documentCount += 1
          if (
            -not [double]::IsNaN($rect.X) -and
            $rect.Width -gt 0 -and
            (
              $rect.Left -lt ($bounds.Left - 2) -or
              $rect.Right -gt ($bounds.Right + 2)
            )
          ) {
            $documentHorizontalBoundsWithinWindow = $false
          }
        }
        if (
          -not [double]::IsNaN($rect.X) -and
          $rect.Width -gt 0 -and
          $rect.Height -gt 0 -and
          (
            $rect.Left -lt ($bounds.Left - 2) -or
            $rect.Right -gt ($bounds.Right + 2)
          )
        ) {
          $visibleHorizontalBoundsWithinWindow = $false
          $horizontalOverflowCount += 1
        }
      }
    } catch {
      throw 'The exact P3-D accessibility tree could not be read safely.'
    }
  }
  [pscustomobject]@{
    schemaVersion = 'aaw.phase3-p3d.accessibility-snapshot/v1'
    processId = $ProcessId
    windowHandle = $windowHandle.ToInt64()
    interactiveDesktop = $interactiveDesktop
    elementCount = $elements.Count
    truncated = $elements.Count -gt $limit
    focusableElementCount = $focusableCount
    visibleHorizontalBoundsWithinWindow = $visibleHorizontalBoundsWithinWindow
    horizontalOverflowCount = $horizontalOverflowCount
    documentCount = $documentCount
    documentHorizontalBoundsWithinWindow = $documentHorizontalBoundsWithinWindow
    controlTypeCounts = $typeCounts
    textFragments = $text
  } | ConvertTo-Json -Depth 8 -Compress
  exit 0
}

if ($ProbeOnly) {
  [pscustomobject]@{
    schemaVersion = 'aaw.phase3-p3d.window-probe/v1'
    processId = $ProcessId
    windowHandle = $windowHandle.ToInt64()
    left = $bounds.Left
    top = $bounds.Top
    width = $width
    height = $height
    interactiveDesktop = $interactiveDesktop
  } | ConvertTo-Json -Compress
  exit 0
}

if ($CloseWindow) {
  if (-not [AawP3dWin32]::PostMessage($windowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) {
    throw "The exact P3-D window could not receive WM_CLOSE."
  }
  [pscustomobject]@{
    schemaVersion = 'aaw.phase3-p3d.window-close/v1'
    processId = $ProcessId
    requested = $true
  } | ConvertTo-Json -Compress
  exit 0
}

if ($PSCmdlet.ParameterSetName -eq 'Resize') {
  $SWP_NOMOVE = 0x0002
  $SWP_NOZORDER = 0x0004
  $SWP_NOACTIVATE = 0x0010
  $targetOuterWidth = $ResizeWidth
  $targetOuterHeight = $ResizeHeight
  $resized = $null
  for ($attempt = 0; $attempt -lt 4; $attempt += 1) {
    if (-not [AawP3dWin32]::SetWindowPos(
      $windowHandle,
      [IntPtr]::Zero,
      0,
      0,
      $targetOuterWidth,
      $targetOuterHeight,
      $SWP_NOMOVE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE
    )) {
      throw 'The exact P3-D window could not be resized externally.'
    }
    Start-Sleep -Milliseconds 250
    $resized = [AawP3dWin32]::PhysicalBounds($windowHandle)
    $physicalWidth = $resized.Right - $resized.Left
    $physicalHeight = $resized.Bottom - $resized.Top
    if ($physicalWidth -eq $ResizeWidth -and $physicalHeight -eq $ResizeHeight) {
      break
    }
    $outer = [AawP3dWin32+RECT]::new()
    if (-not [AawP3dWin32]::GetWindowRect($windowHandle, [ref]$outer)) {
      throw 'The exact P3-D window outer bounds are unavailable.'
    }
    $targetOuterWidth = ($outer.Right - $outer.Left) + ($ResizeWidth - $physicalWidth)
    $targetOuterHeight = ($outer.Bottom - $outer.Top) + ($ResizeHeight - $physicalHeight)
  }
  if ($resized -eq $null) {
    throw 'The exact P3-D window resize result is unavailable.'
  }
  [pscustomobject]@{
    schemaVersion = 'aaw.phase3-p3d.window-resize/v1'
    processId = $ProcessId
    width = $resized.Right - $resized.Left
    height = $resized.Bottom - $resized.Top
  } | ConvertTo-Json -Compress
  exit 0
}

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$parent = [System.IO.Path]::GetDirectoryName($resolvedOutput)
if ([string]::IsNullOrWhiteSpace($parent)) {
  throw 'The screenshot output parent is unavailable.'
}
[System.IO.Directory]::CreateDirectory($parent) | Out-Null
if ([System.IO.File]::Exists($resolvedOutput)) {
  throw "Refusing to overwrite existing screenshot: $resolvedOutput"
}

$bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
try {
  [AawP3dWin32]::SetForegroundWindow($windowHandle) | Out-Null
  Start-Sleep -Milliseconds 250
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen(
      $bounds.Left,
      $bounds.Top,
      0,
      0,
      [System.Drawing.Size]::new($width, $height),
      [System.Drawing.CopyPixelOperation]::SourceCopy
    )
  } finally {
    $graphics.Dispose()
  }
  $bitmap.Save($resolvedOutput, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $bitmap.Dispose()
}

$stream = [System.IO.File]::OpenRead($resolvedOutput)
try {
  $hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    $sha256 = -join @($hasher.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
  } finally {
    $hasher.Dispose()
  }
} finally {
  $stream.Dispose()
}
[pscustomobject]@{
  schemaVersion = 'aaw.phase3-p3d.external-screenshot/v1'
  processId = $ProcessId
  windowHandle = $windowHandle.ToInt64()
  captureMethod = 'external-CopyFromScreen'
  interactiveDesktop = $interactiveDesktop
  width = $width
  height = $height
  sha256 = "sha256:$sha256"
  outputPath = $resolvedOutput
} | ConvertTo-Json -Compress
