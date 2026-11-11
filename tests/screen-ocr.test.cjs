const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { cropBounds, displayRegion, windowRegion, findWindowSource, createScreenReader } = require('../screen-ocr.cjs');
const { captionKey, extendScreenCaption } = require('../caption-match.js');

test('region fractions map to the captured image size, including its lower right edge', () => {
  assert.deepEqual(cropBounds({ x: 0.5, y: 0.75, width: 0.50000001, height: 0.25 }, { width: 1920, height: 1080 }),
    { x: 960, y: 810, width: 960, height: 270 });
});

test('caption keys ignore casing, punctuation and line wrapping', () => {
  assert.equal(captionKey('How do you deploy\nKubernetes?'), captionKey('HOW DO YOU DEPLOY KUBERNETES'));
});

test('a selected region uses the physical origin of its display', () => {
  assert.deepEqual(displayRegion({ x: 0.5, y: 0.75, width: 0.5, height: 0.25 },
    { x: -1920, y: 240, width: 1920, height: 1080 }),
  { x: -960, y: 1050, width: 960, height: 270 });
});

test('rolling screen captions require overlap and tolerate small OCR errors', () => {
  assert.equal(extendScreenCaption('How would you test', 'you test a payment API?'),
    'How would you test a payment API?');
  assert.equal(extendScreenCaption('How would you test a payment API?', 'a payment API?'),
    'How would you test a payment API?');
  assert.equal(extendScreenCaption('What is your', 'biggest strength?'), null);
  assert.equal(extendScreenCaption('What is your biggest strength?', 'Why do you want this role?'), null);
  assert.equal(extendScreenCaption('Describe the test. What failed?', 'What failed? How did you fix it?'),
    'Describe the test. What failed? How did you fix it?');
  assert.equal(extendScreenCaption('How would you test a payment API', 'would you tesl a payment API? What would you automate?'),
    'How would you test a payment API? What would you automate?');
  assert.equal(extendScreenCaption('Can you test API version 1?', 'Can you test API version 2?'), null);
  assert.equal(extendScreenCaption('You can deploy this now', 'You can’t deploy this now'), null);
});

test('dragging pins the initial window and OCR keeps using it when other windows cover it', async () => {
  const handlers = new Map();
  const samples = [];
  let picker;
  let frame = { png: 'example', capturedAt: 10 };
  let cursorNear = false;
  let enumerations = 0;
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 } };
  class Picker extends EventEmitter {
    constructor() {
      super();
      picker = this;
      this.webContents = { mainFrame: {}, on() {}, setWindowOpenHandler() {},
        executeJavaScript: async () => frame };
    }
    loadFile(file) {
      this.webContents.mainFrame.url = pathToFileURL(file).href;
      this.webContents.getURL = () => this.webContents.mainFrame.url;
      return Promise.resolve();
    }
    setAlwaysOnTop() {}
    setContentProtection(value) { this.protected = value; }
    isDestroyed() { return false; }
    show() { this.shown = true; }
    hide() { this.hidden = true; }
    close() { this.emit('closed'); }
  }
  const reader = createScreenReader({
    BrowserWindow: Picker,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    screen: { getCursorScreenPoint() {}, getDisplayNearestPoint: () => display,
      dipToScreenRect: () => ({ x: 0, y: 0, width: 1920, height: 1080 }) },
    desktopCapturer: { getSources: async () => {
      enumerations++;
      return [{ id: 'window:200:0' }, { id: 'window:100:0' }];
    } },
    ocr: { read: async request => {
      samples.push(request);
      if (request.action === 'cursor') return { cursorNear };
      return request.action === 'pick'
        ? { target: { hwnd: '100', x: 192, y: 108, width: 960, height: 540 } }
        : { text: 'What is an API?' };
    }, stop() {} },
  });
  let assistantHidden = false;
  const selection = reader.select(() => { assistantHidden = picker.shown; });
  await Promise.resolve();
  assert.equal(assistantHidden, true);
  assert.equal(picker.protected, true);
  const event = { sender: picker.webContents, senderFrame: picker.webContents.mainFrame };
  await handlers.get('screen-window-anchor')(event, { x: 0.125, y: 0.125 });
  assert.deepEqual(samples[0], { action: 'pick', pid: process.pid, x: 240, y: 135 });
  assert.equal(reader.allowsCapture(picker.webContents), false);
  const source = await handlers.get('screen-region-source')(event, { x: 0.125, y: 0.125, width: 0.25, height: 0.25 });
  assert.deepEqual(source, { id: 'window:100:0', crop: { x: 0.05, y: 0.05, width: 0.5, height: 0.5 } });
  assert.equal(reader.allowsCapture(picker.webContents), true);
  handlers.get('screen-region-picked')(event, true);
  assert.equal(await selection, true);
  assert.equal(picker.hidden, true);
  assert.equal(reader.allowsCapture(picker.webContents), false);
  cursorNear = true;
  assert.deepEqual(await reader.read(), { cursorNear: true });
  cursorNear = false;
  assert.deepEqual(await reader.read(), { cursorNear: true });
  assert.equal(samples.some(request => request.action === 'ocr'), false);
  assert.deepEqual(await reader.read(), { text: 'What is an API?', capturedAt: 10 });
  assert.deepEqual(await reader.read(), { text: 'What is an API?', capturedAt: 10 });
  frame = null;
  assert.deepEqual(await reader.read(), { unavailable: true });
  assert.equal(enumerations, 1);
  assert.deepEqual(samples.filter(request => request.action === 'ocr'), [{ action: 'ocr', png: 'example' }]);
  assert.deepEqual(samples[1], { action: 'cursor', hwnd: '100', ...source.crop });
  reader.stop();
});

test('window selection excludes app-owned sources and rejects crops that cross window borders', () => {
  assert.equal(findWindowSource([{ id: 'window:100:1' }, { id: 'window:200:0' }], '100'), undefined);
  assert.throws(() => windowRegion({ x: 90, y: 100, width: 100, height: 50 },
    { x: 100, y: 100, width: 200, height: 100 }), /fully inside/);
});
