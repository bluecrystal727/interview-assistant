# Interview Assistant

A Windows desktop app for interviews where AI assistance is permitted. It captures system audio, transcribes speech after pauses, and streams suggested talking points and answers into an always-on-top window.

## Start on Windows

1. Install Node.js 24 LTS from https://nodejs.org.
2. Extract this entire ZIP into a folder, such as Documents/InterviewAssistant.
3. Double-click Start-Windows.cmd. The first run downloads dependencies.
4. Open **Session setup**. Choose **Local Whisper** for offline transcription or **OpenAI API** for cloud transcription. Select **OpenAI**, **Claude**, or **Gemini** as the answer provider and enter its API key. Paste your Resume and the job description into their own fields, then click **Apply settings**.
5. Use headphones. Start listening, then have another person speak in your meeting or play a sample question on your computer.
6. Select a caption or type a question, then click **Ask AI**. Leave the question box empty to use the latest speaking turn. The response streams on the right.
7. Use **Overlay opacity** in the toolbar to see the meeting behind the assistant. The slider fades backgrounds and controls from 100% down to 35%. Question, answer, and caption text stays fully opaque. Drag the app title to move the window.

## Ask AI shortcut

**Ctrl+Space** asks about the typed question or the latest captured turn. In **Session setup**, enter another combination such as **Ctrl+Alt+A** and click **Set shortcut**. Windows may reserve some shortcuts or another app may already be using them. The active shortcut appears in the footer.

## Capture on-screen questions or subtitles

1. Click **Select screen text**, then drag a box inside the window with the question or subtitles. The window under the starting point becomes the capture source. The assistant hides while you select, and **Esc** cancels.
2. The selected region follows that window when it moves or another window covers it. Scanning pauses while the pointer is near the selected region. If the source is minimized, closed, or unavailable, scanning pauses until the source returns or you select again. Reselect after resizing or moving the text within the window. Click **Stop screen text** to end capture.
3. Use screen scanning or system audio at any one time. To switch, stop the active capture first. Screen scanning updates the current caption while the text is changing. After three seconds of steady text, the next new reading starts a new caption. Add your API key and apply settings to use **Ask AI**.

Screen OCR runs locally with Windows Media OCR and the recognition languages installed on your Windows profile. Images are cropped and processed in memory. Recognized text can be included in an AI answer request when you ask for an answer.

Each answer provider uses its own API key. Get keys from the [OpenAI API platform](https://platform.openai.com/api-keys), [Claude Console](https://console.anthropic.com/settings/keys), or [Google AI Studio](https://aistudio.google.com/app/apikey). For Claude, use a workspace-scoped API key. Leave **Answer model** blank to use the displayed default, or enter a supported model ID. OpenAI cloud transcription still needs an OpenAI key even if you choose Claude or Gemini for answers.

## Free offline transcription on Windows

1. Download the Windows CPU build for your architecture from the [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases). Extract the entire ZIP so the DLLs stay with `whisper-cli.exe`.
2. Download [ggml-base.en.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin) for English audio. For a faster, smaller English model, use [ggml-tiny.en.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin).
3. Restart the assistant, choose **Local Whisper (free, offline)**, and enter the full paths to the executable and model. Leave the OpenAI API key blank for transcription only.
4. Click **Apply settings**, then **Start listening**. Play a spoken question through your headphones or speakers. The transcript appears after a pause.

## Behavior

**System prompt** in **Session setup** shows the full prompt used to generate answers. Edit it and click **Apply prompt** to use your version on the next answer without restarting listening. Clear the field and apply it to restore the default. The default puts a spoken answer in SAY, with KEYS, NOTE, and CODE as needed. Greetings use a single SAY line. Add optional interview context in Notes and click Apply settings.

- All system output audio is captured, including notifications and music. Close other audio sources. Your microphone is not directly captured, but mic monitoring or meeting echo can put your voice into the system audio.
- A simple energy threshold detects speech and ends a segment after 1.2 seconds of quiet. Long speech is split at 20 seconds. Transcription is sequential. This is pause-based transcription, not word-by-word realtime transcription.
- Auto-answer is off by default. Turn it on to request an answer after a speaking turn ends. A pause can occur in the middle of a question, so use **Ask AI** when you want to choose which questions to send.
- Click a caption to fill the question box. Ctrl-click or Shift-click to append a caption. **Use latest turn** fills the box with the latest captured turn. Use **Short**, **Explain**, **Negotiate**, **Ask them**, **Strategy**, or **Summarize** to choose a response format.
- A new answer cancels an older answer. Cancel answer leaves audio listening active. Stop discards unfinished audio and cancels pending requests while retaining the displayed transcript.
- Up to four audio segments can queue. If processing falls behind or transcription fails, listening stops with an error so you can reconnect.
- Model names are editable. Defaults are gpt-4.1-mini for answers and gpt-4o-mini-transcribe for transcription. Account access may vary. Choose a model available to your account that supports the corresponding API.
- Context, key, transcript, and answers are kept in memory for the session. The app has no conversation export or settings save feature.

## Verify screen sharing on your Windows PC

The app requests Windows capture exclusion for both windows before they first appear. The badge reports that the request was made. Verify screenshots or sharing with your specific capture tool, since the result depends on the capture method. Minimize the assistant before taking a screenshot if your tool shows it or leaves a black rectangle.

1. Open the app and type a recognizable test question.
2. Join a test meeting from a second device.
3. In Chrome, share your entire screen. Inspect the received video on the second device.
4. Move, resize, minimize, and restore the assistant while sharing.
5. Repeat with Chrome window sharing and with the actual interview meeting service.

Exclusion depends on the Windows version, graphics/capture path, and app versions. It is not guaranteed for every recorder or remote desktop tool. An external camera can still see your monitor. Windows 11 is the intended platform. macOS and Linux support is not provided.

## Data handling

Clicking Start listening starts capture. With OpenAI transcription selected, captured audio goes to OpenAI. With Local Whisper selected, the app processes audio on your PC and removes its temporary WAV and transcript files after each segment. The visible question, recent interviewer transcript, Resume, job description, and Notes go to the selected answer provider. Screen video is requested to obtain system audio, but frames are never rendered, uploaded, or saved by this app. OpenAI Responses requests use store=false. Provider-side data handling follows your API account's policies.

Applied keys stay in the Electron main process for the session, and the corresponding password fields are cleared. Leave a key field blank to reuse the key for that provider while changing context or models. Provider errors are converted to fixed messages so credentials and request data are not forwarded to the interface or Electron IPC error logs. Node integration is disabled in the renderer, context isolation and sandboxing are enabled, and remote navigation is blocked.

## Developer commands

Run these commands from the extracted folder.

```sh
npm ci
npm run check
npm test
npm start
```

To build a portable Windows executable on a Windows machine, run `npm run dist`. The output is in dist/. The build is unsigned.

The UI uses plain HTML/CSS/JavaScript to avoid a frontend build step. The Electron main process handles API calls and capture settings. The audio worklet performs speech segmentation.

## Validation and limits

Syntax checks and 37 regression tests pass. Tests cover stream completion, incomplete and disconnected streams, cancellation, speech segmentation, audio diagnostics, Stop during capture startup, cleanup before restart, IPC frame validation, separate Resume and job description context, background opacity, window controls, shortcut registration, mutually exclusive capture modes, window selection, screen-region coordinates, and OCR deduplication. The tests simulate audio, API calls, and the native window.

During the latest development run, `npm ci` failed first on default-cache permissions and then on network access after selecting a workspace cache. Consequently `npm start` and `npm run dist` could not find Electron and electron-builder. No new portable executable was built. Files already in dist/ are from an earlier build attempt and do not validate this source revision.

To finish on a Windows session with npm network access, run the commands above, enter the key directly in the app, and play a spoken question through your normal meeting output device. The audio meter should move, the transcript should appear after a pause, and the answer should stream. Check manual Ask AI, cancellation, Stop/restart, and model/key error messages. Verify capture exclusion separately using the received feed on a second device, then run `npm run dist` and repeat the checks in the portable executable.

The audio meter distinguishes a quiet source from a transcription failure. A source ending stops capture; a suspended audio context produces a startup error. Incomplete or empty answer streams display an error and retain any partial text rather than reporting success.

Use **Test system audio (no API key)** before entering credentials to check the Windows output route and meter. This mode captures locally for the meter and never queues transcription or answer requests. Press Stop before starting normal listening. Stop also works while capture is opening; any tracks returned after cancellation are immediately released.

If npm reports cache permissions, use a writable cache in PowerShell before installing:

```powershell
$env:npm_config_cache = Join-Path $PWD '.npm-cache'
$env:ELECTRON_CACHE = Join-Path $PWD '.electron-cache'
$env:ELECTRON_BUILDER_CACHE = Join-Path $PWD '.builder-cache'
npm ci
```

These settings address cache permissions only; npm, Electron downloads, and electron-builder downloads still need network access. The desktop automation helper was also unavailable in this development session, so no visual verification of the current app was completed.

Official references

- https://www.electronjs.org/docs/latest/api/base-window#winsetcontentprotectionenable
- https://www.electronjs.org/docs/latest/api/desktop-capturer
- https://developers.openai.com/api/docs/guides/transcription
- https://developers.openai.com/api/docs/guides/streaming-responses
