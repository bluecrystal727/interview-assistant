const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function renderer({ display, moduleLoad, close, selectScreen, stopScreen, screenText, screenTime = Date.now,
  configure = async () => ({ localTranscription: true, answersAvailable: true }) } = {}) {
  const ids = [...fs.readFileSync(require.resolve('../index.html'), 'utf8').matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  const elements = Object.fromEntries(ids.map(id => [id, {
    id, value: '', textContent: '', disabled: false, checked: false,
  }]));
  const captions = [];
  const answers = [];
  const rootStyles = new Map();
  elements.transcript.append = caption => captions.push(caption);
  elements.transcript.replaceChildren = () => { captions.length = 0; };
  elements.question.focus = () => {};
  let transcriptions = 0;
  let selections = 0;
  let audioRequests = 0;
  let node;
  const tracks = [{ stop() { this.stopped = true; } }];
  const stream = { getAudioTracks: () => tracks, getTracks: () => tracks };
  const context = vm.createContext({
    document: {
      querySelectorAll: () => Object.values(elements), createElement: () => ({}),
      documentElement: { style: { setProperty: (name, value) => rootStyles.set(name, value) } },
    },
    window: { assistant: {
      configure,
      cancel: async () => {}, cancelAnswer: async () => {},
      answer: async input => { answers.push(input); return { cancelled: false }; },
      selectScreenRegion: async () => { selections++; return selectScreen?.promise ?? true; },
      setSystemPrompt: async prompt => prompt.trim() || 'Default interview prompt.',
      readScreenRegion: async () => {
        const text = screenText?.();
        return text && { text, capturedAt: screenTime() };
      },
      stopScreenRegion: async () => stopScreen?.promise,
      transcribe: async () => { transcriptions++; return 'Question'; },
      info: async () => ({ platform: 'win32', protection: true, systemPrompt: 'Default interview prompt.' }),
      onDelta() {}, onShortcut() {},
    } },
    navigator: { mediaDevices: { getDisplayMedia: () => {
      audioRequests++;
      return display?.promise || Promise.resolve(stream);
    } } },
    MediaStream: class {},
    AudioContext: class {
      constructor() {
        this.state = 'running';
        this.audioWorklet = { addModule: () => moduleLoad?.promise || Promise.resolve() };
      }
      createMediaStreamSource() { return { connect(n) { return n; }, disconnect() {} }; }
      createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
      async resume() {}
      close() { return close?.promise || Promise.resolve(); }
    },
    AudioWorkletNode: class {
      constructor(_, __, options) { node = this; this.options = options; this.port = {}; }
      connect(n) { return n; }
      disconnect() {}
    },
    setTimeout, clearTimeout,
  });
  for (const file of ['../caption-match.js', '../renderer.js']) {
    vm.runInContext(fs.readFileSync(require.resolve(file), 'utf8'), context);
  }
  return { elements, stream, tracks, context, captions, answers, rootStyles, get node() { return node; },
    get transcriptions() { return transcriptions; }, get selections() { return selections; },
    get audioRequests() { return audioRequests; } };
}

test('Stop during the system audio picker disposes late tracks without opening processing', async () => {
  const display = deferred();
  const r = renderer({ display });
  const starting = r.elements.testAudio.onclick();
  assert.equal(r.elements.stop.disabled, false);
  await r.elements.stop.onclick();
  await r.elements.selectScreen.onclick();
  assert.equal(r.selections, 0);
  display.resolve(r.stream);
  await starting;
  assert.equal(r.elements.selectScreen.disabled, false);
  assert.equal(r.tracks[0].stopped, true);
  assert.equal(r.node, undefined);
  assert.equal(r.transcriptions, 0);
});

test('the opacity slider updates the overlay styling variable', () => {
  const r = renderer();
  r.elements.opacity.value = '35';
  r.elements.opacity.oninput();
  assert.deepEqual([...r.rootStyles], [['--background-opacity', '35%']]);
  assert.equal(r.elements.opacityValue.textContent, '35%');
  r.elements.opacity.value = '100';
  r.elements.opacity.oninput();
  assert.equal(r.rootStyles.get('--background-opacity'), '100%');
});

test('Stop during worklet loading cannot restart a closed audio context', async () => {
  const moduleLoad = deferred();
  const r = renderer({ moduleLoad });
  const starting = r.elements.testAudio.onclick();
  await Promise.resolve();
  await r.elements.stop.onclick();
  moduleLoad.resolve();
  await starting;
  assert.equal(r.node, undefined);
  assert.equal(r.tracks[0].stopped, true);
});

test('diagnostic runs without a key and does not transcribe meter messages', async () => {
  const r = renderer();
  await r.elements.testAudio.onclick();
  assert.equal(r.node.options.processorOptions.monitorOnly, true);
  r.node.port.onmessage({ data: { type: 'level', rms: 0.1, speaking: false } });
  r.node.port.onmessage({ data: { samples: new Float32Array(16000), sampleRate: 16000, final: true } });
  await vm.runInContext('queue', r.context);
  assert.ok(r.elements.level.value > 0);
  assert.equal(r.transcriptions, 0);
  await r.elements.stop.onclick();
});

test('pure silence boundary finishes a pending question without an API upload', async () => {
  const r = renderer();
  await r.elements.testAudio.onclick();
  vm.runInContext("pendingTurn = [{ text: 'Existing question' }]; enqueue({ type: 'boundary', final: true }, epoch)", r.context);
  await vm.runInContext('queue', r.context);
  assert.equal(r.transcriptions, 0);
  await r.elements.stop.onclick();
});

test('screen text suppresses repeated OCR readings and updates overlapping captions', async () => {
  let text;
  let at = 0;
  const r = renderer({ screenText: () => text, screenTime: () => at });
  await r.elements.apply.onclick();
  await r.elements.selectScreen.onclick();
  for (const frame of ['How would you test an API', 'How would you tesl an API', '', 'HOW WOULD YOU TEST\nAN API',
    'How would you test an API? What would you automate?', 'Why do you want this role?',
    'How would you test an API?', 'How would you test an API? What would you autornate?']) {
    text = frame;
    at += frame.startsWith('Why') ? 3000 : 400;
    await vm.runInContext('clearTimeout(screenTimer); scanScreen(screenEpoch)', r.context);
  }
  assert.equal(r.elements.screenState.textContent, 'Screen text detected');
  await r.elements.stopScreen.onclick();
  assert.equal(r.elements.screenState.textContent, 'Screen text off');
  await r.elements.answer.onclick();
  assert.equal(r.answers[0].question, 'Why do you want this role?');
  assert.deepEqual(r.captions.map(caption => caption.textContent), [
    'How would you test an API? What would you automate?', 'Why do you want this role?',
  ]);
});

test('growing OCR text stays in one caption and uses spaces between phrases', async () => {
  let text;
  let at = 0;
  const r = renderer({ screenText: () => text, screenTime: () => at });
  await r.elements.selectScreen.onclick();
  try {
    for (const frame of ['My name i', 'My name is', 'My name is + My name is abc', 'My name is abc def',
      'aaa + Showing translation for aaa + Translate instead aaa', 'I use C++']) {
      text = frame;
      at += frame.startsWith('My name') ? 500 : 3000;
      await vm.runInContext('clearTimeout(screenTimer); scanScreen(screenEpoch)', r.context);
    }
    assert.deepEqual(r.captions.map(caption => caption.textContent), [
      'My name is abc def', 'aaa Showing translation for aaa Translate instead aaa', 'I use C++',
    ]);
  } finally {
    await r.elements.stopScreen.onclick();
  }
});

test('OCR updates the current caption until the text has been steady for three seconds', () => {
  const r = renderer();
  const record = (text, at) => {
    r.context.screenSample = { text, at };
    vm.runInContext('recordScreenCaption(screenSample.text, captionKey(screenSample.text), screenSample.at)', r.context);
  };
  record('Misread partial caption', 1000);
  const first = r.captions[0];
  record('Tell me about your role', 2000);
  record('Tell me about your role', 4000);
  record('Tell me about your role', 5000);
  assert.equal(r.captions.length, 1);
  assert.equal(first.textContent, 'Tell me about your role');

  record('Tell me about your role in the launch', 5100);
  record('Tell me about your role in the launch last year', 6000);
  assert.deepEqual(r.captions.map(caption => caption.textContent), [
    'Tell me about your role', 'Tell me about your role in the launch last year',
  ]);
});

test('session setup shows the full prompt and restores it when an empty prompt is applied', async () => {
  const r = renderer();
  await Promise.resolve();
  assert.equal(r.elements.systemPrompt.value, 'Default interview prompt.');
  r.elements.systemPrompt.value = ' Speak as the candidate. ';
  await r.elements.applyPrompt.onclick();
  assert.equal(r.elements.systemPrompt.value, 'Speak as the candidate.');
  r.elements.systemPrompt.value = '';
  await r.elements.applyPrompt.onclick();
  assert.equal(r.elements.systemPrompt.value, 'Default interview prompt.');
});

test('answer provider selection keeps model drafts and only sends keys for the selected services', async () => {
  let settings;
  const { elements } = renderer({ configure: async input => {
    settings = input;
    return { answersAvailable: true, configuredKeys: ['openai', 'claude'] };
  } });
  elements.answerProvider.value = 'claude';
  elements.answerProvider.onchange();
  elements.answerModel.value = 'custom-claude-model';
  elements.answerModel.oninput();
  elements.answerProvider.value = 'gemini';
  elements.answerProvider.onchange();
  assert.equal(elements.answerModel.value, '');
  elements.answerProvider.value = 'claude';
  elements.answerProvider.onchange();
  elements.transcriptionProvider.value = 'cloud';
  elements.transcriptionProvider.onchange();
  assert.equal(elements.openaiKeyField.hidden, false);
  assert.equal(elements.geminiKeyField.hidden, true);
  elements.key.value = 'openai-fixture';
  elements.claudeKey.value = 'claude-fixture';
  elements.geminiKey.value = 'unused-gemini-fixture';
  await elements.apply.onclick();
  assert.equal(settings.answerProvider, 'claude');
  assert.equal(settings.answerModel, 'custom-claude-model');
  assert.equal(settings.key, 'openai-fixture');
  assert.equal(settings.claudeKey, 'claude-fixture');
  assert.equal(settings.geminiKey, '');
  assert.equal(elements.key.value, '');
  assert.equal(elements.claudeKey.value, '');
});

test('screen capture and audio exclude each other during selection, capture, and cleanup', async () => {
  const selectScreen = deferred();
  const stopScreen = deferred();
  const r = renderer({ selectScreen, stopScreen });
  await r.elements.apply.onclick();
  const selecting = r.elements.selectScreen.onclick();
  assert.equal(r.elements.listen.disabled, true);
  await r.elements.listen.onclick();
  selectScreen.resolve(true);
  await selecting;
  await r.elements.testAudio.onclick();
  const stopping = r.elements.stopScreen.onclick();
  await r.elements.listen.onclick();
  assert.equal(r.audioRequests, 0);
  stopScreen.resolve();
  await stopping;
  await r.elements.listen.onclick();
  assert.equal(r.audioRequests, 1);
  assert.equal(r.elements.selectScreen.disabled, true);
  await r.elements.selectScreen.onclick();
  assert.equal(r.selections, 1);
  await r.elements.stop.onclick();
  assert.equal(r.elements.selectScreen.disabled, false);
});

test('restart remains disabled until audio cleanup has completed', async () => {
  const close = deferred();
  const r = renderer({ close });
  await r.elements.testAudio.onclick();
  const stopping = r.elements.stop.onclick();
  assert.equal(r.elements.testAudio.disabled, true);
  close.resolve();
  await stopping;
  assert.equal(r.elements.testAudio.disabled, false);
});

test('captions leave typed questions intact and Ask AI can use the latest turn', async () => {
  const r = renderer();
  await r.elements.apply.onclick();
  await r.elements.listen.onclick();
  r.elements.question.value = 'Typed question';
  for (const final of [false, true]) {
    r.node.port.onmessage({ data: { samples: new Float32Array(16000), sampleRate: 16000, final } });
  }
  await vm.runInContext('queue', r.context);
  assert.equal(r.elements.question.value, 'Typed question');
  assert.equal(r.captions.length, 2);
  assert.equal(r.answers.length, 0);
  await r.elements.short.onclick();
  assert.equal(r.answers[0].question, 'Typed question');
  assert.equal(r.answers[0].command, 'short');
  r.captions[0].onclick({});
  assert.equal(r.elements.question.value, 'Question');
  r.elements.question.value = '';
  await r.elements.answer.onclick();
  assert.equal(r.answers[1].question, 'Question Question');
  r.elements.clearCaptions.onclick();
  assert.equal(r.captions.length, 0);
  assert.equal(r.elements.useLatest.disabled, true);
  await r.elements.stop.onclick();
});
