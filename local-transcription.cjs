const { execFile } = require('node:child_process');
const { mkdtemp, writeFile, readFile, unlink, rmdir, stat } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);

async function checkWhisperFiles(executable, model) {
  if (!path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'whisper-cli.exe') {
    throw new Error('Enter the full path to whisper-cli.exe.');
  }
  if (!path.isAbsolute(model) || path.extname(model).toLowerCase() !== '.bin') {
    throw new Error('Enter the full path to the Whisper .bin model.');
  }
  const files = await Promise.all([stat(executable).catch(() => null), stat(model).catch(() => null)]);
  if (!files[0]?.isFile()) throw new Error('Cannot find whisper-cli.exe at that path.');
  if (!files[1]?.isFile()) throw new Error('Cannot find the Whisper model at that path.');
}

async function transcribeLocally(wav, { executable, model }, signal) {
  let folder;
  try {
    signal.throwIfAborted();
    folder = await mkdtemp(path.join(tmpdir(), 'interview-whisper-'));
    const input = path.join(folder, 'speech.wav');
    const output = path.join(folder, 'transcript');
    await writeFile(input, wav, { signal });
    const execution = run(executable, ['-m', model, '-f', input, '-l', 'en', '-ng', '-np', '-otxt', '-of', output], {
      cwd: path.dirname(executable), windowsHide: true, timeout: 120000, signal,
    });
    const closed = new Promise(resolve => execution.child.once('close', resolve));
    try { await execution; }
    finally { await closed; }
    return (await readFile(output + '.txt', { encoding: 'utf8', signal })).trim();
  } catch (error) {
    if (signal.aborted) return '';
    if (error.killed) throw new Error('Local Whisper timed out. Try a smaller model.');
    throw new Error('Local Whisper failed. Check the model and keep the executable with its DLLs.');
  } finally {
    if (folder) {
      try {
        for (const file of ['speech.wav', 'transcript.txt']) {
          await unlink(path.join(folder, file)).catch(error => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
        await rmdir(folder);
      } catch {
        throw new Error('Could not remove temporary Whisper files from the Windows temp folder.');
      }
    }
  }
}

module.exports = { checkWhisperFiles, transcribeLocally };
