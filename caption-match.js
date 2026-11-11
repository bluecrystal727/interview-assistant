function captionWords(text) {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)].map(match => ({
    word: match[0].toLowerCase().replaceAll('’', "'"), index: match.index,
    end: match.index + match[0].length,
  }));
}

function captionKey(text) {
  return captionWords(text).map(token => token.word).join(' ');
}

function sameScreenText(firstKey, secondKey) {
  if (firstKey === secondKey) return true;
  const first = firstKey.replaceAll(' ', '');
  const second = secondKey.replaceAll(' ', '');
  if (first === second) return true;

  // Allow a few OCR errors while keeping changes to numbers or negation.
  const limit = Math.min(3, Math.floor(Math.max(first.length, second.length) / 16));
  const meaning = /\d+|\b(?:no|not|never|\w+n't)\b/g;
  if (!limit || Math.abs(first.length - second.length) > limit ||
      (firstKey.match(meaning) || []).join(' ') !== (secondKey.match(meaning) || []).join(' ')) return false;

  const outside = limit + 1;
  let previous = new Uint8Array(second.length + 1).fill(outside);
  let current = previous.slice();
  for (let j = 0; j <= limit; j++) previous[j] = j;
  for (let i = 1; i <= first.length; i++) {
    const start = Math.max(1, i - limit);
    const end = Math.min(second.length, i + limit);
    current[start - 1] = start === 1 ? Math.min(i, outside) : outside;
    let best = current[start - 1];
    for (let j = start; j <= end; j++) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1,
        previous[j - 1] + Number(first[i - 1] !== second[j - 1]));
      best = Math.min(best, current[j]);
    }
    if (best > limit) return false;
    if (end < second.length) current[end + 1] = outside;
    [previous, current] = [current, previous];
  }
  return previous[second.length] <= limit;
}

function extendScreenCaption(previous, next) {
  const oldWords = captionWords(previous);
  const newWords = captionWords(next);
  if (!oldWords.length || !newWords.length) return null;
  const oldKey = oldWords.map(token => token.word).join(' ');
  const newKey = newWords.map(token => token.word).join(' ');
  if (newKey.startsWith(oldKey + ' ')) {
    // A wrapped subtitle can show the previous text and its expanded version together.
    let offset = 0;
    if (oldWords.length >= 3) {
      while (newWords.length >= offset + oldWords.length * 2 &&
             newWords.slice(offset + oldWords.length, offset + oldWords.length * 2)
               .every((token, index) => token.word === oldWords[index].word)) {
        offset += oldWords.length;
      }
    }
    return offset ? next.slice(newWords[offset].index) : next;
  }
  if (newWords.length >= oldWords.length && oldWords.length >= 3 &&
      oldWords.at(-1).end === previous.length &&
      oldWords.slice(0, -1).every((token, index) => token.word === newWords[index].word) &&
      newWords[oldWords.length - 1].word.startsWith(oldWords.at(-1).word) &&
      newWords[oldWords.length - 1].word !== oldWords.at(-1).word) return next;
  if (sameScreenText(oldKey, newKey) || (' ' + oldKey + ' ').includes(' ' + newKey + ' ')) return previous;

  for (let count = Math.min(oldWords.length, newWords.length); count >= 1; count--) {
    const shared = oldWords.slice(-count).map(token => token.word).join(' ');
    const beginning = newWords.slice(0, count).map(token => token.word).join(' ');
    const exact = (count >= 2 || shared.length >= 6) && shared === beginning;
    const close = count >= 3 && sameScreenText(shared, beginning);
    if (!exact && !close) continue;
    if (count === newWords.length) return previous;

    // Keep previously accepted words and carry over punctuation at the join.
    const tail = next.slice(newWords[count].index);
    const gap = next.slice(newWords[count - 1].end, newWords[count].index).trim();
    const punctuation = oldWords.at(-1).end === previous.length ? gap : '';
    return previous + punctuation + ' ' + tail;
  }
  return null;
}

if (typeof module === 'object') module.exports = { captionKey, sameScreenText, extendScreenCaption };

