import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createContentParser,
  readContent,
  finishContent,
} from '../src/content-json.js';

function decode(parts, roundTripState = false) {
  let state = createContentParser();
  let text = '';
  for (const part of parts) {
    text += readContent(state, part);
    if (roundTripState) state = JSON.parse(JSON.stringify(state));
  }
  finishContent(state);
  return text;
}

test('emits text before the argument object has finished', () => {
  const state = createContentParser();
  assert.equal(readContent(state, '{"content":"你好'), '你好');
  assert.throws(() => finishContent(state), /incomplete/i);
  assert.equal(readContent(state, '，世界"}'), '，世界');
  assert.equal(finishContent(state), undefined);
});

test('accepts empty content and JSON whitespace around structural tokens', () => {
  assert.equal(decode([' \r\n\t{ \n"content"\t : \r"" \n}\t']), '');
});

test('preserves Chinese, Markdown, source code and emoji at every split', () => {
  const text = '## 证明\n中文与 emoji 😀🧪\n```js\nconst x = "a\\nb";\n```\n\\frac{a}{b}\t末尾';
  const json = JSON.stringify({ content: text });
  for (let at = 0; at <= json.length; at++) {
    assert.equal(decode([json.slice(0, at), json.slice(at)]), text, 'split ' + at);
  }
  assert.equal(decode(json.split('')), text);
});

test('decodes every JSON escape across every split', () => {
  const json = '{"content":"\\\"\\\\\\/\\b\\f\\n\\r\\t\\u4e2d\\u6587\\uD83D\\uDE00"}';
  const expected = JSON.parse(json).content;
  for (let at = 0; at <= json.length; at++) {
    assert.equal(decode([json.slice(0, at), json.slice(at)]), expected, 'split ' + at);
  }
  assert.equal(decode(json.split('')), expected);
});

test('holds an escaped high surrogate until its low surrogate arrives', () => {
  const state = createContentParser();
  assert.equal(readContent(state, '{"content":"A\\uD83D'), 'A');
  assert.equal(readContent(state, '\\uDE00B"}'), '😀B');
  finishContent(state);
});

test('holds a literal high surrogate across JSON-serialized parser state', () => {
  let state = createContentParser();
  assert.equal(readContent(state, '{"content":"\uD83D'), '');
  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, /\\ud83d/i);
  state = JSON.parse(serialized);
  assert.equal(readContent(state, '\uDE00"}'), '😀');
  finishContent(state);
});

test('all parser states survive JSON serialization between characters', () => {
  const json = ' \n { "content" : "中文\\n\\t\\u0041\\uD83D\\uDE00😀" } \t';
  assert.equal(decode(json.split(''), true), JSON.parse(json).content);
});

test('keeps independent parser instances separate', () => {
  const first = createContentParser();
  const second = createContentParser();
  assert.equal(readContent(first, '{"content":"甲'), '甲');
  assert.equal(readContent(second, '{"content":"乙"}'), '乙');
  assert.equal(readContent(first, '丙"}'), '丙');
  finishContent(first);
  finishContent(second);
});

const invalidArguments = [
  '{}',
  '[]',
  '{"other":"text"}',
  '{"content":null}',
  '{"content":42}',
  '{"content":[]}',
  '{"content":{}}',
  '{"content":"a","other":"b"}',
  '{"content":"a","content":"b"}',
  '{"content":"a",}',
  '{"content":"a"} trailing',
  '{"content":"a"}{}',
  '{"content":"\\x41"}',
  '{"content":"\\uQQQQ"}',
  '{"content":"literal\nnewline"}',
  '{"content":"\u0000"}',
  '{"content":"\\uD83D"}',
  '{"content":"\\uDE00"}',
  '{"content":"\\uD83DX"}',
  '{"content":"\\uD83D\\uD83D"}',
  '{"con tent":"text"}',
  '{"cont\\u0065nt":"text"}',
  '\u00a0{"content":"text"}',
];

test('rejects non-schema objects and invalid string encodings', () => {
  for (const json of invalidArguments) {
    assert.throws(() => decode([json]), /final.answer JSON/i, json);
    assert.throws(() => decode(json.split('')), /final.answer JSON/i, json);
  }
});

test('reports incomplete arguments at every truncated position', () => {
  const json = '{"content":"text \\uD83D\\uDE00\\nend"}';
  for (let at = 0; at < json.length; at++) {
    const state = createContentParser();
    readContent(state, json.slice(0, at));
    assert.throws(() => finishContent(state), /incomplete/i, 'truncated ' + at);
  }
});

test('retains already decoded text when generation stops inside an escape', () => {
  const state = createContentParser();
  assert.equal(readContent(state, '{"content":"partial\\uD8'), 'partial');
  assert.throws(() => finishContent(state), /incomplete/i);
});
