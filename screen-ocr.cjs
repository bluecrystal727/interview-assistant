const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { pathToFileURL } = require('node:url');

const script = Buffer.from(readFileSync(path.join(__dirname, 'screen-ocr.ps1'), 'utf8'), 'utf16le').toString('base64');

function cropBounds(region, size) {
  const x = Math.floor(region.x * size.width);
  const y = Math.floor(region.y * size.height);
  return {
    x, y,
    width: Math.min(size.width, Math.ceil((region.x + region.width) * size.width)) - x,
    height: Math.min(size.height, Math.ceil((region.y + region.height) * size.height)) - y,
  };
}

function displayRegion(region, bounds) {
  const box = cropBounds(region, bounds);
  return { ...box, x: box.x + bounds.x, y: box.y + bounds.y };
}

function windowRegion(box, target) {
  const x = box.x - target.x;
  const y = box.y - target.y;
  if (x < 0 || y < 0 || x + box.width > target.width || y + box.height > target.height) {
    throw new Error('Drag a region fully inside the window where you started.');
  }
  return { x: x / target.width, y: y / target.height,
    width: box.width / target.width, height: box.height / target.height };
}

function findWindowSource(sources, hwnd) {
  return sources.find(source => {
    const match = /^window:(-?\d+):0$/.exec(source.id);
    return match && BigInt(match[1]) === BigInt(hwnd);
  });
}

function createOcrWorker() {
  let processHandle;
  let pending;

  function stop(message = 'Screen OCR stopped.') {
    const child = processHandle;
    processHandle = undefined;
    pending?.(new Error(message));
    child?.kill();
  }

  function start() {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    processHandle = child;
    const onFailure = () => {
      if (processHandle === child) stop('Windows OCR could not start.');
    };
    child.on('error', onFailure);
    child.on('close', onFailure);
    child.stdin.on('error', onFailure);
    createInterface({ input: child.stdout }).on('line', line => {
      if (processHandle !== child || !pending) return;
      try {
        const result = JSON.parse(line);
        if (result.error === 'language') {
          pending(new Error('Install a Windows OCR language to read screen text.'));
        } else if (result.error) {
          pending(new Error('Windows could not process this selection.'));
        } else {
          pending(null, result);
        }
      } catch {
        stop('Windows OCR returned an invalid result.');
      }
    });
  }

  return {
    read(request) {
      if (pending) return Promise.reject(new Error('Windows OCR is already processing a request.'));
      if (!processHandle) start();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => stop('Windows OCR timed out.'), 12000);
        pending = (error, result) => {
          clearTimeout(timeout);
          pending = undefined;
          if (error) reject(error);
          else resolve(result);
        };
        processHandle.stdin.write(JSON.stringify(request) + '\n');
      });
    },
    stop,
  };
}

function createScreenReader({ BrowserWindow, screen, ipcMain, desktopCapturer, ocr = createOcrWorker() }) {
  const pickerFile = path.join(__dirname, 'screen-picker.html');
  const pickerURL = pathToFileURL(pickerFile).href;
  let selection;
  let active;
  let reading;
  let lastFrame;

  function trustedPicker(event) {
    if (!selection || event.sender !== selection.window.webContents ||
        event.senderFrame !== selection.window.webContents.mainFrame || event.senderFrame?.url !== pickerURL) {
      throw new Error('Untrusted region selection.');
    }
    return selection;
  }

  ipcMain.handle('screen-window-anchor', (event, point) => {
    const picker = trustedPicker(event);
    const { x, y } = point || {};
    if (![x, y].every(value => Number.isFinite(value) && value >= 0 && value < 1)) {
      throw new Error('Invalid selection point.');
    }
    picker.source = undefined;
    if (picker.pinned) ocr.stop();
    picker.pinned = ocr.read({
      action: 'pick', pid: process.pid,
      x: picker.bounds.x + Math.floor(x * picker.bounds.width),
      y: picker.bounds.y + Math.floor(y * picker.bounds.height),
    });
    return picker.pinned.then(() => {});
  });

  ipcMain.handle('screen-region-source', async (event, box) => {
    const picker = trustedPicker(event);
    const { x, y, width, height } = box || {};
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 ||
        width <= 0 || height <= 0 || x + width > 1.000001 || y + height > 1.000001) {
      throw new Error('Invalid screen region.');
    }
    const result = await picker.pinned;
    if (selection !== picker || !result?.target) throw new Error('Start the drag on a visible app window.');
    const crop = windowRegion(displayRegion(box, picker.bounds), result.target);
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    const source = findWindowSource(sources, result.target.hwnd);
    if (selection !== picker || !source) throw new Error('Windows could not capture the selected window. Restore it and try again.');
    picker.source = source;
    picker.cursorRegion = { action: 'cursor', hwnd: result.target.hwnd, ...crop };
    return { id: source.id, crop };
  });

  ipcMain.handle('screen-region-picked', (event, accepted) => {
    const picker = trustedPicker(event);
    if (!accepted) { picker.window.close(); return; }
    if (!picker.source) throw new Error('No window has been selected.');
    const previous = active;
    active = picker;
    picker.cursorWasNear = true;
    selection = undefined;
    lastFrame = undefined;
    picker.window.hide();
    previous?.window.close();
    picker.resolve(true);
  });

  return {
    isSelecting: () => Boolean(selection),
    allowsCapture: contents => Boolean(selection?.source && contents === selection.window.webContents &&
      contents.getURL() === pickerURL),
    select(onShown) {
      if (selection) return selection.result;
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const bounds = screen.dipToScreenRect(null, display.bounds);
      const picker = new BrowserWindow({
        ...display.bounds, show: false, frame: false, transparent: true, resizable: false,
        movable: false, skipTaskbar: true, alwaysOnTop: true,
        webPreferences: {
          preload: path.join(__dirname, 'screen-picker-preload.cjs'),
          contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
        },
      });
      ocr.stop();
      picker.setContentProtection(true);
      picker.setAlwaysOnTop(true, 'screen-saver');
      picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      picker.webContents.on('will-navigate', event => event.preventDefault());
      picker.webContents.on('render-process-gone', () => { if (!picker.isDestroyed()) picker.close(); });
      let resolveSelection;
      const result = new Promise((resolve, reject) => {
        resolveSelection = resolve;
        picker.once('closed', () => {
          if (selection?.window === picker) selection = undefined;
          if (active?.window === picker) active = undefined;
          resolve(false);
        });
        picker.loadFile(pickerFile).then(() => {
          if (picker.isDestroyed()) return;
          picker.show();
          onShown();
        }).catch(() => {
          reject(new Error('Could not open the screen region picker.'));
          if (!picker.isDestroyed()) picker.close();
        });
      });
      selection = { window: picker, bounds, result, resolve: resolveSelection };
      return result;
    },
    async read() {
      if (selection || reading) return null;
      if (!active) return { unavailable: true };
      const target = active;
      reading = target;
      try {
        const before = await ocr.read(target.cursorRegion);
        if (target !== active || selection) return null;
        if (before.cursorNear === null) return { unavailable: true };
        if (before.cursorNear || target.cursorWasNear) {
          // Let the capture stream replace any buffered frame containing the pointer.
          target.cursorWasNear = before.cursorNear;
          return { cursorNear: true };
        }
        const frame = await target.window.webContents.executeJavaScript('window.captureRegionFrame()');
        if (target !== active || selection) return null;
        if (frame?.resized) return { resized: true };
        if (!frame?.png) return { unavailable: true };
        const after = await ocr.read(target.cursorRegion);
        if (target !== active || selection) return null;
        if (after.cursorNear === null) return { unavailable: true };
        if (after.cursorNear) {
          target.cursorWasNear = true;
          return { cursorNear: true };
        }
        const text = lastFrame?.png === frame.png ? lastFrame.text
          : (await ocr.read({ action: 'ocr', png: frame.png })).text.trim().slice(0, 4000);
        if (target !== active || selection) return null;
        lastFrame = { png: frame.png, text };
        return { text, capturedAt: frame.capturedAt };
      } catch (error) {
        if (target !== active || selection) return null;
        throw error;
      } finally {
        if (reading === target) reading = undefined;
      }
    },
    stop() {
      const previous = active;
      active = undefined;
      lastFrame = undefined;
      ocr.stop();
      selection?.window.close();
      previous?.window.close();
    },
  };
}

module.exports = { cropBounds, displayRegion, windowRegion, findWindowSource, createOcrWorker, createScreenReader };
