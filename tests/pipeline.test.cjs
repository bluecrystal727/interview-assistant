const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { consumeAnswerStream } = require('../answer-stream.cjs');

async function* events(parts) { yield* parts; }
test('streams text and requires a completed response', async () => {
  let text = '';
  const result = await consumeAnswerStream(events([
    { type: 'response.output_text.delta', delta: 'Hello' },
    { type: 'response.completed' },
  ]), new AbortController().signal, delta => { text += delta; });
  assert.equal(text, 'Hello');
  assert.equal(result.cancelled, false);
});
test('incomplete, failed, empty and disconnected streams cannot report success', async () => {
  for (const ending of ['response.incomplete', 'response.failed', 'error', null]) {
    const parts = [{ type: 'response.output_text.delta', delta: 'Partial' }];
    if (ending) parts.push({ type: ending, message: 'secret should not propagate' });
    await assert.rejects(consumeAnswerStream(events(parts), new AbortController().signal, () => {}),
      error => !error.message.includes('secret'));
  }
  await assert.rejects(consumeAnswerStream(events([{ type: 'response.completed' }]),
    new AbortController().signal, () => {}));
});
test('cancelled streams stop emitting text', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await consumeAnswerStream(events([{ type: 'response.output_text.delta', delta: 'stale' }]),
    controller.signal, () => assert.fail('stale delta'));
  assert.equal(result.cancelled, true);
});

function recorder(options) {
  let Processor;
  const messages = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../audio-worklet.js'), 'utf8'), {
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: value => messages.push(value) }; } },
    sampleRate: 16000,
    registerProcessor: (_, value) => { Processor = value; },
  });
  const processor = new Processor(options);
  return { messages, feed(value, seconds) {
    for (let i = 0; i < Math.ceil(seconds * 16000 / 128); i++) {
      processor.process([[new Float32Array(128).fill(value)]]);
    }
  } };
}
test('silence does not transcribe; speech has preroll and ends after a pause', () => {
  const r = recorder();
  r.feed(0, 2);
  assert.equal(r.messages.filter(x => x.samples).length, 0);
  r.feed(0.1, 1);
  r.feed(0, 1.3);
  const segments = r.messages.filter(x => x.samples);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].final, true);
  assert.ok(segments[0].samples.length > 16000);
  assert.ok(r.messages.some(x => x.type === 'level' && x.rms > 0.008));
});
test('speech ending at the 20-second split emits a final boundary without transcribing silence', () => {
  const r = recorder();
  r.feed(0.1, 20);
  r.feed(0, 1.4);
  const segments = r.messages.filter(x => x.samples);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].final, false);
  assert.ok(r.messages.some(x => x.type === 'boundary' && x.final));
});

test('audio diagnostic emits meter readings without uploading audio segments', () => {
  const r = recorder({ processorOptions: { monitorOnly: true } });
  r.feed(0.1, 22);
  r.feed(0, 2);
  assert.ok(r.messages.some(x => x.type === 'level' && x.rms > 0));
  assert.equal(r.messages.filter(x => x.type !== 'level').length, 0);
});
