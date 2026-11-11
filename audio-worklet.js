class SegmentRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frames = [];
    this.preRoll = [];
    this.length = 0;
    this.silence = 0;
    this.active = false;
    this.meterFrames = 0;
    this.continuing = false;
    this.monitorOnly = options?.processorOptions?.monitorOnly === true;
    this.voicedLength = 0;
    this.port.onmessage = event => {
      if (event.data === 'flush') this.flush(true);
    };
  }
  flush(final) {
    if (this.length > sampleRate * 0.25 && this.voicedLength > 0) {
      const samples = new Float32Array(this.length);
      let offset = 0;
      for (const frame of this.frames) {
        samples.set(frame, offset);
        offset += frame.length;
      }
      this.port.postMessage({ samples, sampleRate, final }, [samples.buffer]);
    } else if (final && this.continuing) {
      // Signal the pause without uploading pure silence after a long segment.
      this.port.postMessage({ type: 'boundary', final: true });
    }
    this.continuing = !final;
    this.frames = [];
    this.length = 0;
    this.silence = 0;
    this.active = false;
    this.voicedLength = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const mono = new Float32Array(channels[0].length);
    let energy = 0;
    for (let i = 0; i < mono.length; i++) {
      for (const channel of channels) mono[i] += channel[i] / channels.length;
      energy += mono[i] * mono[i];
    }
    const rms = Math.sqrt(energy / mono.length);
    const voiced = rms > 0.008;
    this.meterFrames += mono.length;
    if (this.meterFrames >= sampleRate * 0.1) {
      this.port.postMessage({ type: 'level', rms, speaking: voiced || this.active });
      this.meterFrames = 0;
    }
    if (this.monitorOnly) return true;
    if (!this.active && (voiced || this.continuing)) {
      this.active = true;
      this.frames = this.preRoll;
      this.length = this.frames.reduce((sum, frame) => sum + frame.length, 0);
      this.preRoll = [];
    }
    if (this.active) {
      this.frames.push(mono);
      this.length += mono.length;
      if (voiced) this.voicedLength += mono.length;
      this.silence = voiced ? 0 : this.silence + mono.length;
      if (this.silence >= sampleRate * 1.2) this.flush(true);
      else if (this.length >= sampleRate * 20) this.flush(false);
    } else {
      this.preRoll.push(mono);
      if (this.preRoll.length > Math.ceil(sampleRate * 0.2 / mono.length)) this.preRoll.shift();
    }
    return true;
  }
}
registerProcessor('segment-recorder', SegmentRecorder);
