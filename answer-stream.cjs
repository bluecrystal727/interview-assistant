async function consumeAnswerStream(stream, signal, onText) {
  let completed = false;
  let hasText = false;
  for await (const part of stream) {
    if (signal.aborted) return { cancelled: true };
    if (part.type === 'response.output_text.delta' || part.type === 'response.refusal.delta') {
      if (part.delta) { hasText = true; onText(part.delta); }
    }
    if (part.type === 'response.completed') completed = true;
    if (['error', 'response.failed', 'response.incomplete'].includes(part.type)) {
      throw new Error('The answer was interrupted or incomplete. Partial text is retained; try again.');
    }
  }
  if (signal.aborted) return { cancelled: true };
  if (!completed || !hasText) throw new Error('No complete answer received. Check the model and connection, then retry.');
  return { cancelled: false };
}
async function* normalizeChatStream(stream) {
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta?.content || choice.delta?.refusal;
    if (delta) yield { type: 'response.output_text.delta', delta };
    if (choice.finish_reason) {
      yield { type: choice.finish_reason === 'stop' ? 'response.completed' : 'response.incomplete' };
    }
  }
}

module.exports = { consumeAnswerStream, normalizeChatStream };
