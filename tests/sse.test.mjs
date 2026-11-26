import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { rewriteSSE } from '../src/sse.js';

const options = { active: true, model: 'test-model-fc' };
const data = value => `data: ${JSON.stringify(value)}\n\n`;
const frame = (args, reason = null) => ({
  id: 'chat-1', model: 'test-model', choices: [{ index: 0, finish_reason: reason,
    delta: args === null ? {} : { tool_calls: [{ index: 0,
      function: { name: '__tfa_final_answer', arguments: args } }] } }],
});
const ended = data(frame(null, 'tool_calls')) + 'data: [DONE]\n\n';
const packets = value => String(value).split(/\r\n\r\n|\n\n|\r\r/).filter(Boolean).map(block => {
  const joined = block.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
  return joined === '[DONE]' ? '[DONE]' : joined ? JSON.parse(joined) : null;
}).filter(Boolean);
async function collect(chunks, settings = options) {
  let output = '';
  for await (const chunk of rewriteSSE(Readable.from(chunks), settings)) output += chunk;
  return output;
}
const bytes = text => Buffer.from(text);

test('ignores a UTF-8 BOM only at stream start when every byte is split', async () => {
  const content = '正文\uFEFF保留';
  const input = bytes('\uFEFF' + data(frame(JSON.stringify({ content }))) + ended);
  const output = await collect([...input].map(value => Buffer.from([value])));
  assert.equal(output.includes('__tfa_final_answer'), false);
  const result = packets(output);
  assert.equal(result[0].choices[0].delta.content, content);
  assert.equal(result[0].model, options.model);
  assert.equal(result[1].choices[0].finish_reason, 'stop');
  assert.equal(result[2], '[DONE]');
});

test('restores Chinese and emoji across every UTF-8 byte split and keeps usage', async () => {
  const text = '中文 😀\nMarkdown **bold**';
  const usage = { prompt_tokens: 10, completion_tokens: 20 };
  const input = bytes(data(frame(JSON.stringify({ content: text }))) + data(frame(null, 'tool_calls')) + data({ choices: [], usage }) + 'data: [DONE]\n\n');
  for (let i = 0; i <= input.length; i++) {
    const output = packets(await collect([input.subarray(0, i), input.subarray(i)]));
    assert.equal(output[0].choices[0].delta.content, text, `byte split ${i}`);
    assert.equal(output[0].model, options.model);
    assert.equal(output[1].choices[0].finish_reason, 'stop');
    assert.deepEqual(output[2].usage, usage);
    assert.equal('model' in output[2], false);
    assert.equal(output[3], '[DONE]');
  }
});

test('emits partial body before the full tool argument or stream finishes', async () => {
  const source = new Readable({ read() {} });
  const iterator = rewriteSSE(source, options);
  source.push(bytes(data(frame('{"content":"现在'))));
  const first = await iterator.next();
  assert.equal(packets(first.value)[0].choices[0].delta.content, '现在');
  assert.equal(source.readableEnded, false);
  await iterator.return();
  assert.equal(source.destroyed, true);
});

test('handles CRLF and lone CR boundaries one byte at a time', async () => {
  for (const newline of ['\r\n', '\r']) {
    const input = bytes((data(frame('{"content":"ok"}')) + ended).replaceAll('\n', newline));
    const output = packets(await collect([...input].map(value => Buffer.from([value]))));
    assert.equal(output[0].choices[0].delta.content, 'ok');
    assert.equal(output.at(-1), '[DONE]');
  }
});

test('joins multiline data and preserves event metadata and heartbeat comments', async () => {
  const json = JSON.stringify(frame('{"content":"ok"}')).replace('"choices":', '"choices":\ndata: ');
  const heartbeat = ': keepalive\r\n\r\n';
  const input = heartbeat + 'event: message\nid: 7\nretry: 1000\ndata: ' + json + '\n\n' + ended;
  const output = await collect([bytes(input)]);
  assert.ok(output.startsWith(heartbeat));
  assert.match(output, /event: message\nid: 7\nretry: 1000/);
  assert.equal(packets(output)[0].choices[0].delta.content, 'ok');
});

test('inactive conversion only restores the requested alias in JSON events', async () => {
  const original = frame('{"content":"leave this tool untouched"}');
  const output = packets(await collect([bytes(data(original) + 'data: [DONE]\n\n')], { ...options, active: false }));
  assert.deepEqual(output[0], { ...original, model: options.model });
  assert.equal(output[1], '[DONE]');
});

test('preserves actual tools, reasoning, refusal, ordinary content and length', async () => {
  const original = { model: 'test-model', choices: [{ index: 0, delta: { reasoning_content: 'r', refusal: null, content: 'native',
    tool_calls: [{ index: 0, id: 'real', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] }, finish_reason: null }] };
  const finish = { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] };
  const result = packets(await collect([bytes(data(original) + data(finish) + 'data: [DONE]\n\n')]));
  assert.deepEqual(result[0], { ...original, model: options.model });
  assert.equal(result[1].choices[0].finish_reason, 'length');
});

test('keeps a truncated final body and the explicit length reason', async () => {
  const output = packets(await collect([bytes(data(frame('{"content":"partial')) + data(frame(null, 'length')) + 'data: [DONE]\n\n')]));
  assert.equal(output[0].choices[0].delta.content, 'partial');
  assert.equal(output[1].choices[0].finish_reason, 'length');
  assert.equal(output[2], '[DONE]');
});

test('missing finish reason yields a stream error without inventing DONE or stop', async () => {
  const output = packets(await collect([bytes(data(frame('{"content":"partial')))]));
  assert.equal(output[0].choices[0].delta.content, 'partial');
  assert.equal(output[1].error.code, 'tfa_stream_error');
  assert.match(output[1].error.message, /finish_reason/);
  assert.equal(output.includes('[DONE]'), false);
});

test('an empty active stream and an early DONE become stream errors', async () => {
  for (const content of ['', 'data: [DONE]\n\n']) {
    const output = packets(await collect([bytes(content)]));
    assert.equal(output.length, 1);
    assert.equal(output[0].error.code, 'tfa_stream_error');
  }
});

test('EOF after an explicit finish preserves it without adding DONE', async () => {
  const output = packets(await collect([bytes(data(frame('{"content":"ok"}')) + data(frame(null, 'tool_calls')))]));
  assert.equal(output.length, 2);
  assert.equal(output[1].choices[0].finish_reason, 'stop');
});

test('a readable transport failure becomes an SSE error without rejecting iteration', async () => {
  const source = Readable.from((async function* () {
    yield bytes(data(frame('{"content":"partial')));
    throw new Error('connection reset');
  })());
  let output = '';
  for await (const chunk of rewriteSSE(source, options)) output += chunk;
  const result = packets(output);
  assert.equal(result[0].choices[0].delta.content, 'partial');
  assert.equal(result[1].error.message, 'connection reset');
  assert.equal(result[1].error.code, 'tfa_stream_error');
  assert.equal(result.length, 2);
  assert.equal(source.destroyed, true);
});

test('upstream named or JSON error events remain unchanged and terminal', async () => {
  for (const error of ['event: error\ndata: upstream failure\n\n', data({ error: { message: 'busy', code: 'upstream_busy' } })]) {
    const output = await collect([bytes(error + 'data: [DONE]\n\n')]);
    assert.equal(output, error);
  }
});

test('malformed JSON or unfinished SSE frames produce one error and no fabricated end', async () => {
  for (const content of ['data: not json\n\n', 'data: {"unfinished":true}']) {
    const output = packets(await collect([bytes(content)]));
    assert.equal(output.length, 1);
    assert.equal(output[0].error.code, 'tfa_stream_error');
  }
});

test('actual DONE ends consumption and closes the upstream readable', async () => {
  const source = Readable.from([bytes(data(frame('{"content":"ok"}')) + ended + 'data: ignored invalid bytes\n\n')]);
  let output = '';
  for await (const chunk of rewriteSSE(source, options)) output += chunk;
  assert.equal(packets(output).at(-1), '[DONE]');
  assert.equal(output.includes('ignored'), false);
  assert.equal(source.destroyed, true);
});
