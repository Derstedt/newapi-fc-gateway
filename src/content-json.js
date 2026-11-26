const HEADER = ['{', '"content"', ':', '"'];
const SPACE = /^[ \t\r\n]$/;
const ESCAPES = { '"': 34, '\\': 92, '/': 47, b: 8, f: 12, n: 10, r: 13, t: 9 };

function invalid(reason) {
  throw new Error('Invalid final-answer JSON: ' + reason);
}

// Only the fixed key "content" is accepted; its value supports every JSON escape.
// Keep a high surrogate pending until its matching low surrogate arrives.
export function createContentParser() {
  return {
    phase: 'header', token: 0, offset: 0,
    escaped: false, hexDigits: 0, hexValue: 0, high: null,
  };
}

function decodeUnit(state, code) {
  const low = code >= 0xdc00 && code <= 0xdfff;
  if (state.high !== null) {
    if (!low) invalid('unpaired high surrogate');
    const text = String.fromCharCode(state.high, code);
    state.high = null;
    return text;
  }
  if (low) invalid('unpaired low surrogate');
  if (code >= 0xd800 && code <= 0xdbff) {
    state.high = code;
    return '';
  }
  return String.fromCharCode(code);
}

export function readContent(state, fragment) {
  let text = '';
  for (let i = 0; i < fragment.length; i++) {
    const character = fragment[i];
    if (state.phase === 'header') {
      if (state.offset === 0 && SPACE.test(character)) continue;
      const token = HEADER[state.token];
      if (character !== token[state.offset]) invalid('expected {"content":"..."}');
      state.offset++;
      if (state.offset === token.length) {
        state.offset = 0;
        state.token++;
        if (state.token === HEADER.length) state.phase = 'content';
      }
      continue;
    }
    if (state.phase === 'end' || state.phase === 'done') {
      if (SPACE.test(character)) continue;
      if (state.phase === 'done' || character !== '}') invalid('unexpected data after content');
      state.phase = 'done';
      continue;
    }
    if (state.hexDigits) {
      if (!/^[0-9a-fA-F]$/.test(character)) invalid('invalid Unicode escape');
      state.hexValue = state.hexValue * 16 + parseInt(character, 16);
      state.hexDigits--;
      if (!state.hexDigits) text += decodeUnit(state, state.hexValue);
    } else if (state.escaped) {
      state.escaped = false;
      if (character === 'u') {
        state.hexDigits = 4;
        state.hexValue = 0;
      } else {
        const code = ESCAPES[character];
        if (code === undefined) invalid('invalid escape');
        text += decodeUnit(state, code);
      }
    } else if (character === '\\') {
      state.escaped = true;
    } else if (character === '"') {
      if (state.high !== null) invalid('unpaired high surrogate');
      state.phase = 'end';
    } else {
      const code = character.charCodeAt(0);
      if (code < 32) invalid('unescaped control character');
      text += decodeUnit(state, code);
    }
  }
  return text;
}

export function finishContent(state) {
  if (state.phase !== 'done') invalid('incomplete arguments');
}
