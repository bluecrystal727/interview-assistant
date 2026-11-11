const ui = Object.fromEntries(
  [...document.querySelectorAll('[id]')].map(element => [element.id, element])
);
const answerCommands = ['short', 'explain', 'negotiate', 'askThem', 'strategy', 'summarize'];
const answerKeyInputs = { openai: ui.key, claude: ui.claudeKey, gemini: ui.geminiKey };
const answerModelDrafts = new Map();
let answerModels = {};
const screenCaptionPauseMs = 3000;
let configured = false;
let audioAvailable = true;
let audioActive = false;
let audioOpening = false;
let screenActive = false;
let selectingScreen = false;
let answersAvailable = false;
let localTranscription = false;
let capture;
let audioContext;
let recorder;
let source;
let silentGain;
let epoch = 0;
let answerId = 0;
let history = [];
let pendingTurn = [];
let latestQuestion = '';
let latestCaptionAt = 0;
let screenEpoch = 0;
let screenTimer;
let lastScreenKey = '';
let lastScreenCaption;
let queue = Promise.resolve();
let queued = 0;
let autoTimer;
let speaking = false;
let stopping;

function status(message) { ui.status.textContent = message; }
function report(error) {
  const message = error.message || String(error);
  status(message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
}

function updateCaptureControls() {
  const audioBusy = audioActive || audioOpening;
  ui.listen.disabled = !configured || !audioAvailable || audioBusy || screenActive;
  ui.testAudio.disabled = audioBusy || screenActive;
  ui.selectScreen.disabled = audioBusy || selectingScreen;
}

function showLatestQuestion() {
  ui.latestText.textContent = latestQuestion || 'Listen to system audio or select a screen area.';
  ui.useLatest.disabled = !latestQuestion;
  ui.copyCaptions.disabled = ui.clearCaptions.disabled = !history.length;
}

function addCaption(text, at) {
  const caption = document.createElement('button');
  const entry = { text, caption, at };
  history.push(entry);
  caption.type = 'button';
  caption.className = 'caption';
  caption.textContent = text;
  caption.onclick = event => {
    ui.question.value = (event.ctrlKey || event.shiftKey)
      ? [ui.question.value.trim(), entry.text].filter(Boolean).join(' ') : entry.text;
    ui.question.focus();
  };
  ui.transcript.append(caption);
  if (history.length > 60) {
    history.shift();
    ui.transcript.firstElementChild.remove();
  }
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
  return entry;
}

function recordScreenCaption(text, key, at) {
  const last = lastScreenCaption;
  if (key === lastScreenKey) return;
  lastScreenKey = key;
  if (history.some(entry => entry.screenKey === key)) return;
  const extended = last && extendScreenCaption(last.text, text);
  if (last && extended === last.text) return;
  const fragment = ' ' + key + ' ';
  if (!extended && history.some(entry => entry.screenKey &&
      ((key.includes(' ') && (' ' + entry.screenKey + ' ').includes(fragment)) ||
      sameScreenText(entry.screenKey, key)))) return;
  if (last && at - last.at < screenCaptionPauseMs) {
    const updated = extended || text;
    last.screenKey = captionKey(updated);
    last.text = last.caption.textContent = updated;
    last.at = at;
    updateLatest([last], at);
    return;
  }
  lastScreenCaption = addCaption(text, at);
  lastScreenCaption.screenKey = key;
  updateLatest([lastScreenCaption], at);
}

function updateLatest(entries, at) {
  if (at < latestCaptionAt) return;
  latestCaptionAt = at;
  latestQuestion = entries.map(entry => entry.text).join(' ');
  showLatestQuestion();
}

async function scanScreen(generation) {
  const startedAt = Date.now();
  try {
    const result = await window.assistant.readScreenRegion();
    if (generation !== screenEpoch) return;
    const text = result?.text?.replace(/\s+\+\s+/g, ' ').trim().replace(/\s+/g, ' ');
    const key = text && captionKey(text);
    if (result?.cursorNear) screenStatus('Move the pointer away from the scan area to resume.');
    else if (result?.resized) screenStatus('The selected window changed size. Select the region again.');
    else if (result?.unavailable) screenStatus('Selected window unavailable. Restore it or select again.');
    else if (result) screenStatus(key ? 'Screen text detected' : 'No text found. Select visible text or make it larger.');
    if (key) recordScreenCaption(text, key, result.capturedAt);
    screenTimer = setTimeout(() => scanScreen(generation), Math.max(0, 1000 - (Date.now() - startedAt)));
  } catch (error) {
    if (generation !== screenEpoch) return;
    stopScreen().catch(() => {});
    screenStatus(error.message || String(error));
  }
}

function screenStatus(message) {
  if (ui.screenState.textContent !== message) ui.screenState.textContent = message;
}

async function stopScreen() {
  screenEpoch++;
  clearTimeout(screenTimer);
  ui.stopScreen.disabled = true;
  selectingScreen = true;
  updateCaptureControls();
  screenStatus('Screen text off');
  try { await window.assistant.stopScreenRegion(); }
  finally {
    screenActive = selectingScreen = false;
    updateCaptureControls();
  }
}

async function copyText(text, message) {
  try {
    await window.assistant.copyText(text);
    status(message);
  } catch {
    status('Could not copy to the clipboard.');
  }
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return buffer;
}

async function answer(command, question = ui.question.value.trim() || latestQuestion) {
  clearTimeout(autoTimer);
  if (!answersAvailable) return status('Add an API key for your answer provider in Session setup.');
  if (!question) return status('Enter or capture a question first.');
  const id = ++answerId;
  ui.output.textContent = '';
  ui.output.scrollTop = 0;
  ui.copyAnswer.disabled = true;
  ui.cancel.disabled = false;
  status('Generating answer…');
  try {
    const result = await window.assistant.answer({ id, question, command, history: history.slice(-10).map(entry => entry.text).join('\n') });
    if (id === answerId) status(result.cancelled ? 'Answer cancelled.' : 'Answer ready.');
  } catch (error) {
    if (id === answerId) report(error);
  } finally {
    if (id === answerId) ui.cancel.disabled = true;
  }
}

function enqueue(segment, sessionEpoch) {
  if (sessionEpoch !== epoch) return;
  clearTimeout(autoTimer);
  if (queued >= 4) {
    stopListening().catch(report);
    status(localTranscription
      ? 'Local transcription cannot keep up. Try a smaller Whisper model and restart.'
      : 'Transcription cannot keep up. Check your connection and restart.');
    return;
  }
  queued++;
  const capturedAt = Date.now();
  queue = queue.then(async () => {
    if (sessionEpoch !== epoch) return;
    status('Transcribing interviewer audio…');
    try {
      const text = segment.type === 'boundary' ? '' :
        (await window.assistant.transcribe(encodeWav(segment.samples, segment.sampleRate))).trim();
      if (sessionEpoch !== epoch) return;
      if (text) {
        const caption = addCaption(text, capturedAt);
        pendingTurn.push(caption);
        updateLatest(pendingTurn, caption.at);
      }
      showLatestQuestion();
      status('Listening · transcript updated.');
      if (segment.final) {
        const completedTurn = pendingTurn;
        pendingTurn = [];
        if (completedTurn.length && answersAvailable && ui.auto.checked) {
          autoTimer = setTimeout(() => {
            if (sessionEpoch === epoch && queued === 0 && !speaking) {
              answer(undefined, completedTurn.map(entry => entry.text).join(' '));
            }
          }, 700);
        }
      }
    } catch (error) {
      if (sessionEpoch === epoch) {
        stopListening().catch(report);
        report(error);
      }
    } finally {
      if (sessionEpoch === epoch) queued--;
    }
  });
}

function stopListening() {
  if (stopping) return stopping;
  stopping = releaseAudio().finally(() => {
    stopping = undefined;
    audioActive = false;
    updateCaptureControls();
    ui.apply.disabled = false;
  });
  return stopping;
}

async function releaseAudio() {
  epoch++;
  clearTimeout(autoTimer);
  queued = 0;
  speaking = false;
  ui.level.value = 0;
  ui.audioState.textContent = 'Audio stopped';
  queue = Promise.resolve();
  recorder?.disconnect();
  source?.disconnect();
  silentGain?.disconnect();
  capture?.getTracks().forEach(track => track.stop());
  capture = undefined;
  recorder = undefined;
  source = undefined;
  silentGain = undefined;
  const previousContext = audioContext;
  audioContext = undefined;
  ui.listen.disabled = true;
  ui.testAudio.disabled = true;
  ui.stop.disabled = true;
  ui.apply.disabled = true;
  ++answerId;
  ui.cancel.disabled = true;
  try { await window.assistant.cancel(); }
  finally { await previousContext?.close(); }
}

function updateProviderFields() {
  const provider = ui.answerProvider.value;
  const cloud = ui.transcriptionProvider.value === 'cloud';
  ui.whisperFields.hidden = ui.transcriptionProvider.value !== 'local';
  ui.cloudModel.hidden = !cloud;
  ui.openaiKeyField.hidden = provider !== 'openai' && !cloud;
  ui.claudeKeyField.hidden = provider !== 'claude';
  ui.geminiKeyField.hidden = provider !== 'gemini';
  ui.answerModel.placeholder = answerModels[provider] || '';
}

ui.transcriptionProvider.onchange = updateProviderFields;
ui.answerModel.oninput = () => answerModelDrafts.set(ui.answerProvider.value, ui.answerModel.value);
ui.answerProvider.onchange = () => {
  ui.answerModel.value = answerModelDrafts.get(ui.answerProvider.value) || '';
  updateProviderFields();
};

function activateSession(result, submittedKeys = {}) {
  configured = true;
  audioAvailable = result.audioAvailable !== false;
  answersAvailable = result.answersAvailable;
  localTranscription = result.localTranscription;
  for (const provider of result.configuredKeys || []) {
    const field = answerKeyInputs[provider];
    if (field.value === submittedKeys[provider]) field.value = '';
    field.placeholder = result.saved === false ? 'Key configured for this session' : 'Saved key configured';
  }
  ++answerId;
  updateCaptureControls();
  ui.answer.disabled = !answersAvailable;
  ui.cancel.disabled = true;
  for (const command of answerCommands) ui[command].disabled = !answersAvailable;
  ui.auto.disabled = !answersAvailable;
  if (!answersAvailable) ui.auto.checked = false;
  status(answersAvailable ? 'Ready. Capture audio or screen text, or type a question.'
    : 'Captions are ready. Add an API key for your answer provider to enable Ask AI.');
  if (result.saved === false) status('Settings applied for this session. Could not save them for restart.');
}

ui.apply.onclick = async () => {
  ui.apply.disabled = true;
  const prompt = ui.systemPrompt.value;
  const answerProvider = ui.answerProvider.value || 'openai';
  const transcriptionProvider = ui.transcriptionProvider.value;
  const key = answerProvider === 'openai' || transcriptionProvider === 'cloud' ? ui.key.value : '';
  const claudeKey = answerProvider === 'claude' ? ui.claudeKey.value : '';
  const geminiKey = answerProvider === 'gemini' ? ui.geminiKey.value : '';
  try {
    const result = await window.assistant.configure({
      key, claudeKey, geminiKey, answerProvider, answerModel: ui.answerModel.value,
      transcriptionProvider,
      transcriptionModel: ui.transcriptionModel.value,
      resume: ui.resume.value, jobDescription: ui.jobDescription.value, notes: ui.notes.value,
      systemPrompt: prompt,
      whisperExecutable: ui.whisperExecutable.value, whisperModel: ui.whisperModel.value,
    });
    if (ui.systemPrompt.value === prompt && result.systemPrompt !== undefined) {
      ui.systemPrompt.value = result.systemPrompt;
    }
    activateSession(result, { openai: key, claude: claudeKey, gemini: geminiKey });
    ui.settings.open = false;
  } catch (error) { report(error); }
  finally { ui.apply.disabled = audioActive; }
};

async function startListening(testOnly = false) {
  if (audioActive || audioOpening || screenActive) return;
  audioActive = true;
  audioOpening = true;
  updateCaptureControls();
  ui.apply.disabled = true;
  ui.stop.disabled = false;
  const sessionEpoch = ++epoch;
  pendingTurn = [];
  status('Opening system audio…');
  try {
    let openedCapture;
    try {
      openedCapture = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 1, height: 1, frameRate: 1 },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } finally {
      audioOpening = false;
      updateCaptureControls();
    }
    if (sessionEpoch !== epoch) {
      openedCapture.getTracks().forEach(track => track.stop());
      return;
    }
    capture = openedCapture;
    if (!capture.getAudioTracks().length) throw new Error('No system audio track. Check the Windows output device.');
    // Video is requested by the capture API but never rendered, saved, or sent.
    audioContext = localTranscription && !testOnly
      ? new AudioContext({ sampleRate: 16000 }) : new AudioContext();
    const openedContext = audioContext;
    await openedContext.audioWorklet.addModule('audio-worklet.js');
    if (sessionEpoch !== epoch) return;
    source = audioContext.createMediaStreamSource(new MediaStream(capture.getAudioTracks()));
    recorder = new AudioWorkletNode(audioContext, 'segment-recorder', {
      processorOptions: { monitorOnly: testOnly },
    });
    recorder.onprocessorerror = () => {
      if (sessionEpoch === epoch) {
        stopListening().catch(report);
        status('Audio processing failed. Restart listening.');
      }
    };
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(recorder).connect(silentGain).connect(audioContext.destination);
    recorder.port.onmessage = event => {
      if (sessionEpoch !== epoch) return;
      if (event.data.type === 'level') {
        speaking = event.data.speaking;
        ui.level.value = Math.min(1, event.data.rms * 12);
        ui.audioState.textContent = event.data.rms > 0.008
          ? 'System audio detected' : 'Quiet — play meeting audio; check the output device if this stays quiet';
        if (speaking) clearTimeout(autoTimer);
      } else if (!testOnly) enqueue(event.data, sessionEpoch);
    };
    for (const track of capture.getTracks()) track.onended = () => {
      if (sessionEpoch === epoch) {
        stopListening().catch(report);
        status('Audio source ended. Restart listening to reconnect.');
      }
    };
    await audioContext.resume();
    if (sessionEpoch !== epoch) return;
    if (audioContext.state !== 'running') throw new Error('Audio processing did not start. Stop and try listening again.');
    ui.stop.disabled = false;
    if (testOnly) {
      status('Testing system audio. Play a spoken question and check the meter. Nothing is uploaded.');
      return;
    }
    status('Listening to system audio · waiting for speech.');
  } catch (error) {
    if (sessionEpoch !== epoch) return;
    await stopListening();
    report(error.name === 'NotReadableError'
      ? new Error('Windows could not open system audio. Check the output device, close other capture apps, and retry.')
      : error);
  }
};
ui.listen.onclick = () => startListening();
ui.testAudio.onclick = () => startListening(true);
ui.applyPrompt.onclick = async () => {
  const prompt = ui.systemPrompt.value;
  try {
    const applied = await window.assistant.setSystemPrompt(prompt);
    if (ui.systemPrompt.value === prompt) ui.systemPrompt.value = applied;
    status(prompt.trim() ? 'System prompt applied to the next answer.' : 'Default system prompt restored.');
  } catch (error) { report(error); }
};
ui.selectScreen.onclick = async () => {
  if (audioActive || audioOpening || selectingScreen) return;
  screenActive = selectingScreen = true;
  updateCaptureControls();
  const generation = ++screenEpoch;
  clearTimeout(screenTimer);
  const wasReading = !ui.stopScreen.disabled;
  try {
    const selected = await window.assistant.selectScreenRegion();
    if (generation !== screenEpoch) return;
    if (selected) {
      lastScreenKey = '';
      lastScreenCaption = undefined;
      screenStatus('Scanning selected region…');
    }
    if (selected || wasReading) {
      ui.stopScreen.disabled = false;
      screenTimer = setTimeout(() => scanScreen(generation), 250);
    } else screenActive = false;
  } catch (error) {
    await stopScreen().catch(() => {});
    report(error);
  } finally {
    if (generation === screenEpoch) {
      selectingScreen = false;
      updateCaptureControls();
    }
  }
};
ui.stopScreen.onclick = () => stopScreen().catch(report);
ui.stop.onclick = async () => {
  await stopListening();
  status('Stopped. Unfinished audio and requests discarded. Transcript remains available.');
};
ui.answer.onclick = () => answer();
for (const command of answerCommands) ui[command].onclick = () => answer(command);
ui.question.onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    answer();
  }
};
ui.useLatest.onclick = () => {
  ui.question.value = latestQuestion;
  ui.question.focus();
};
ui.clearCaptions.onclick = () => {
  clearTimeout(autoTimer);
  history = [];
  pendingTurn = [];
  latestQuestion = '';
  latestCaptionAt = 0;
  lastScreenKey = '';
  lastScreenCaption = undefined;
  ui.transcript.replaceChildren();
  showLatestQuestion();
};
ui.copyCaptions.onclick = () => copyText(history.map(entry => entry.text).join('\n\n'), 'Captions copied.');
ui.copyAnswer.onclick = () => copyText(ui.output.textContent, 'Answer copied.');
ui.opacity.oninput = () => {
  const opacity = ui.opacity.value + '%';
  document.documentElement.style.setProperty('--background-opacity', opacity);
  ui.opacityValue.textContent = opacity;
};
ui.minimizeWindow.onclick = () => window.assistant.controlWindow('minimize').catch(report);
ui.maximizeWindow.onclick = () => window.assistant.controlWindow('maximize').catch(report);
ui.closeWindow.onclick = () => window.assistant.controlWindow('close').catch(report);
ui.theme.onclick = () => {
  const root = document.documentElement;
  const light = root.dataset.theme !== 'light';
  root.dataset.theme = light ? 'light' : 'dark';
  ui.theme.textContent = light ? 'Dark mode' : 'Light mode';
};
ui.auto.onchange = () => { if (!ui.auto.checked) clearTimeout(autoTimer); };
ui.cancel.onclick = async () => {
  clearTimeout(autoTimer);
  ++answerId;
  ui.cancel.disabled = true;
  await window.assistant.cancelAnswer();
  status('Answer cancelled.');
};
window.assistant.onDelta(({ id, text }) => {
  if (id === answerId) {
    ui.output.textContent += text;
    ui.copyAnswer.disabled = !ui.output.textContent;
  }
});
window.assistant.onShortcut(() => answer());
ui.saveShortcut.onclick = async () => {
  ui.saveShortcut.disabled = true;
  try {
    const { shortcut, saved } = await window.assistant.setAnswerShortcut(ui.answerShortcut.value);
    ui.answerShortcut.value = ui.activeShortcut.textContent = shortcut;
    status(saved ? 'Ask AI shortcut saved.' : 'Ask AI shortcut is active for this session.');
  } catch (error) { report(error); }
  finally { ui.saveShortcut.disabled = false; }
};
window.assistant.info().then(info => {
  answerModels = info.answerModels || {};
  if (info.savedConfiguration) {
    const saved = info.savedConfiguration;
    for (const field of ['answerProvider', 'answerModel', 'transcriptionProvider', 'transcriptionModel',
      'whisperExecutable', 'whisperModel', 'resume', 'jobDescription', 'notes']) {
      ui[field].value = saved[field] ?? '';
    }
    answerModelDrafts.set(saved.answerProvider, saved.answerModel);
  }
  if (info.restoredSession) activateSession(info.restoredSession);
  if (info.sessionWarning) status(info.sessionWarning);
  updateProviderFields();
  if (!ui.systemPrompt.value && info.systemPrompt !== undefined) ui.systemPrompt.value = info.systemPrompt;
  ui.activeShortcut.textContent = info.shortcut || 'Unavailable';
  if (info.shortcut) ui.answerShortcut.value = info.shortcut;
  ui.protection.textContent = info.platform === 'win32' && info.protection
    ? 'Capture exclusion requested · may remain visible in screen sharing'
    : 'Capture exclusion unavailable or unverified';
}).catch(report);
