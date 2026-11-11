$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CaptureWindow {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X, Y; }
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out Point position);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern IntPtr GetTopWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowTextLength(IntPtr hwnd);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] private static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect value, int size);
    [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")]
    private static extern int DwmGetWindowIntAttribute(IntPtr hwnd, int attribute, out int value, int size);

    public static bool? CursorNearRegion(long handle, double x, double y, double width, double height) {
        IntPtr hwnd = new IntPtr(handle);
        Rect rect;
        Point cursor;
        if (IsIconic(hwnd) || DwmGetWindowAttribute(hwnd, 9, out rect, 16) != 0) return null;
        if (!GetCursorPos(out cursor)) return true;
        double w = rect.Right - rect.Left;
        double h = rect.Bottom - rect.Top;
        // Include the visible pointer around its hotspot, accounting for display scaling.
        double margin = 32 * Math.Max(96u, GetDpiForWindow(hwnd)) / 96.0;
        return cursor.X >= rect.Left + x * w - margin && cursor.X <= rect.Left + (x + width) * w + margin &&
               cursor.Y >= rect.Top + y * h - margin && cursor.Y <= rect.Top + (y + height) * h + margin;
    }

    public static object Find(int x, int y, uint assistantPid) {
        // Walk the visible top-level windows in z-order. Skip overlays and drag ghosts.
        for (IntPtr hwnd = GetTopWindow(IntPtr.Zero); hwnd != IntPtr.Zero; hwnd = GetWindow(hwnd, 2)) {
            if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) continue;
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner == assistantPid || GetWindowTextLength(hwnd) == 0) continue;
            int style = GetWindowLong(hwnd, -20);
            if ((style & (0x20 | 0x80 | 0x08000000)) != 0) continue;
            int cloaked;
            if (DwmGetWindowIntAttribute(hwnd, 14, out cloaked, 4) == 0 && cloaked != 0) continue;
            Rect rect;
            if (DwmGetWindowAttribute(hwnd, 9, out rect, 16) != 0) continue;
            if (x >= rect.Left && x < rect.Right && y >= rect.Top && y < rect.Bottom)
                return new { hwnd = hwnd.ToInt64().ToString(), x = rect.Left, y = rect.Top,
                    width = rect.Right - rect.Left, height = rect.Bottom - rect.Top };
        }
        return null;
    }
}
'@
$null = [CaptureWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Wait-Result($operation, [Type] $resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $task.GetAwaiter().GetResult()
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
function Read-ImageText([byte[]] $image) {
    $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
    $writer = [Windows.Storage.Streams.DataWriter]::new($stream)
    try {
        $writer.WriteBytes($image)
        $null = Wait-Result ($writer.StoreAsync()) ([uint32])
        $null = $writer.DetachStream()
        $stream.Seek(0)
        $decoder = Wait-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Wait-Result ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        try {
            $result = Wait-Result ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            return [string] $result.Text
        } finally { $bitmap.Dispose() }
    } finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}

while ($null -ne ($line = [Console]::ReadLine())) {
    try {
        $request = $line | ConvertFrom-Json
        if ($request.action -eq 'pick') {
            $response = @{ target = [CaptureWindow]::Find($request.x, $request.y, $request.pid) }
        } elseif ($request.action -eq 'cursor') {
            $response = @{ cursorNear = [CaptureWindow]::CursorNearRegion([long]$request.hwnd,
                $request.x, $request.y, $request.width, $request.height) }
        } elseif ($null -eq $engine) {
            $response = @{ error = 'language' }
        } else {
            $response = @{ text = Read-ImageText ([Convert]::FromBase64String($request.png)) }
        }
    }
    catch { $response = @{ error = 'capture' } }
    [Console]::WriteLine(($response | ConvertTo-Json -Compress))
}
