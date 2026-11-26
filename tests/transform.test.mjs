import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareBody, restoreResponse, createStreamState, restoreChunk, finishStream } from '../src/transform.js';

const finalName = '__tfa_final_answer';
const request = () => ({ model: 'test-model', messages: [{ role: 'user', content: '你好' }], stream: true });
const realTool = { type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } };
const finalCall = (text, id = 'final') => ({ id, type: 'function', function: { name: finalName, arguments: JSON.stringify({ content: text }) } });
const realCall = { id: 'real', type: 'function', function: { name: 'lookup', arguments: '{"query":"x"}' } };
const frame = (delta, finish_reason = null, index = 0) => ({ id: 'chat-1', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index, delta, finish_reason }] });
const part = (index, name, args, id = `call-${index}`) => ({ index, ...(name === undefined ? {} : { id, type: 'function' }), function: { ...(name === undefined ? {} : { name }), arguments: args } });
function session() {
  const state = createStreamState();
  return {
    send(chunk) {
      const result = restoreChunk(structuredClone(chunk), state);
      return result;
    },
    end() { finishStream(state); },
    state() { return state; },
  };
}

test('pure chat uses the final tool and preserves request parameters and history', () => {
  const original = { ...request(), temperature: 0.3, max_completion_tokens: 8192, stream_options: { include_usage: true } };
  const snapshot = structuredClone(original);
  const { body, active } = prepareBody(original);
  assert.equal(active, true);
  assert.deepEqual(original, snapshot);
  assert.equal(body.tool_choice.function.name, finalName);
  assert.equal(body.tools[0].function.parameters.properties.content.type, 'string');
  assert.equal(body.temperature, 0.3);
  assert.equal(body.max_completion_tokens, 8192);
  assert.deepEqual(body.stream_options, original.stream_options);
  assert.deepEqual(body.messages.slice(1), original.messages);
  assert.match(body.messages[0].content, /__tfa_final_answer/);
});

test('existing tools and parallel setting survive injection; auto is configurable', () => {
  const original = { ...request(), tools: [realTool], parallel_tool_calls: true };
  const result = prepareBody(original);
  assert.equal(result.body.tool_choice, 'required');
  assert.deepEqual(result.body.tools[0], realTool);
  assert.equal(result.body.tools.length, 2);
  assert.equal(result.body.parallel_tool_calls, true);
  assert.equal(prepareBody(original, { with_tools: 'auto' }).body.tool_choice, 'auto');
});

test('an explicit required tool choice is preserved when the configured default is auto', () => {
  const original = { ...request(), tools: [realTool], tool_choice: 'required' };
  assert.equal(prepareBody(original, { with_tools: 'auto' }).body.tool_choice, 'required');
});

for (const [name, extra] of [
  ['none', { tool_choice: 'none' }],
  ['named tool', { tool_choice: { type: 'function', function: { name: 'lookup' } } }],
  ['JSON object', { response_format: { type: 'json_object' } }],
  ['JSON schema', { response_format: { type: 'json_schema', json_schema: {} } }],
  ['legacy functions', { functions: [realTool.function] }],
  ['legacy function selection', { function_call: 'auto' }],
  ['audio output', { modalities: ['text', 'audio'] }],
  ['reserved name collision', { tools: [{ type: 'function', function: { name: finalName } }] }],
]) {
  test(`bypasses ${name} without mutating the request`, () => {
    const body = { ...request(), ...extra };
    const out = prepareBody(body);
    assert.equal(out.active, false);
    assert.deepEqual(out.body, body);
  });
}

test('plain text response format still opts into final-tool output', () => {
  assert.equal(prepareBody({ ...request(), response_format: { type: 'text' } }).active, true);
});

test('sync response restores final content and keeps usage, reasoning and refusal', () => {
  const input = { id: 'x', usage: { prompt_tokens: 5, completion_tokens: 8 }, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '前言：', reasoning_content: 'reason', refusal: null, tool_calls: [finalCall('正文')] } }] };
  const out = restoreResponse(input);
  assert.equal(out.choices[0].message.content, '前言：正文');
  assert.equal(out.choices[0].finish_reason, 'stop');
  assert.equal('tool_calls' in out.choices[0].message, false);
  assert.equal(out.choices[0].message.reasoning_content, 'reason');
  assert.equal(out.choices[0].message.refusal, null);
  assert.deepEqual(out.usage, { prompt_tokens: 5, completion_tokens: 8 });
});

test('sync response retains real tool calls and appends multiple final bodies', () => {
  const out = restoreResponse({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { content: null, tool_calls: [finalCall('A'), realCall, finalCall('B', 'second')] } }] });
  assert.equal(out.choices[0].message.content, 'AB');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(out.choices[0].message.tool_calls, [realCall]);
});

test('sync truncated final content is recovered with its original length reason', () => {
  const call = finalCall('');
  call.function.arguments = '{"content":"未写完';
  const out = restoreResponse({ choices: [{ finish_reason: 'length', message: { tool_calls: [call] } }] });
  assert.equal(out.choices[0].message.content, '未写完');
  assert.equal(out.choices[0].finish_reason, 'length');
});

test('sync invalid completed parameters are reported instead of replaced by empty text', () => {
  const call = finalCall(''); call.function.arguments = '{"content":12}';
  assert.throws(() => restoreResponse({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [call] } }] }));
});

test('stream starts emitting content before the complete JSON object arrives', () => {
  const s = session();
  const first = s.send(frame({ role: 'assistant', tool_calls: [part(0, finalName, '{"content":"你')] }));
  assert.equal(first.choices[0].delta.content, '你');
  assert.equal('tool_calls' in first.choices[0].delta, false);
  const second = s.send(frame({ tool_calls: [part(0, undefined, '好"}')] }));
  assert.equal(second.choices[0].delta.content, '好');
  const end = s.send(frame({}, 'tool_calls'));
  assert.equal(end.choices[0].finish_reason, 'stop');
  s.end();
});

test('stream preserves actual calls with compact indexes when a hidden call comes first', () => {
  const s = session();
  const first = s.send(frame({ tool_calls: [part(0, finalName, '{"content":"A"}'), part(1, 'lookup', '{"q":')] }));
  assert.deepEqual(first.choices[0].delta.tool_calls, [part(0, 'lookup', '{"q":', 'call-1')]);
  const next = s.send(frame({ tool_calls: [part(1, undefined, '"x"}')] }));
  assert.deepEqual(next.choices[0].delta.tool_calls, [part(0, undefined, '"x"}')]);
  assert.equal(s.send(frame({}, 'tool_calls')).choices[0].finish_reason, 'tool_calls');
  s.end();
});

test('multiple choices have independent tool maps and text', () => {
  const s = session();
  const input = frame({ tool_calls: [part(0, finalName, '{"content":"A')] });
  input.choices.push({ index: 1, delta: { tool_calls: [part(0, 'lookup', '{}')] }, finish_reason: null });
  const out = s.send(input);
  assert.equal(out.choices[0].delta.content, 'A');
  assert.equal(out.choices[1].delta.tool_calls[0].function.name, 'lookup');
  assert.equal(s.send(frame({ tool_calls: [part(0, undefined, 'B"}')] }, 'tool_calls')).choices[0].finish_reason, 'stop');
  assert.equal(s.send(frame({}, 'tool_calls', 1)).choices[0].finish_reason, 'tool_calls');
  s.end();
});

test('parallel final bodies are released in call order, never interleaved', () => {
  const s = session();
  const frames = [
    frame({ tool_calls: [part(0, finalName, '{"content":"A'), part(1, finalName, '{"content":"B')] }),
    frame({ tool_calls: [part(1, undefined, '2"}')] }),
    frame({ tool_calls: [part(0, undefined, '1"}')] }),
    frame({}, 'tool_calls'),
  ];
  const text = frames.map(x => s.send(x).choices[0].delta.content || '').join('');
  assert.equal(text, 'A1B2');
  s.end();
});

test('split final tool name stays hidden before arguments arrive', () => {
  const s = session();
  const a = s.send(frame({ tool_calls: [part(0, '__tfa_', '')] }));
  assert.equal('tool_calls' in a.choices[0].delta, false);
  const b = s.send(frame({ tool_calls: [part(0, 'final_answer', '{"content":"ok"}')] }, 'tool_calls'));
  assert.equal(b.choices[0].delta.content, 'ok');
  assert.equal('tool_calls' in b.choices[0].delta, false);
  s.end();
});

test('a real tool sharing a name prefix is released with all original fragments', () => {
  const s = session();
  s.send(frame({ tool_calls: [part(0, '__tfa_', '')] }));
  const out = s.send(frame({ tool_calls: [part(0, 'lookup', '{}')] }, 'tool_calls'));
  assert.equal(out.choices[0].delta.tool_calls.map(x => x.function.name || '').join(''), '__tfa_lookup');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
});

test('the reserved name can be only the first fragment of a real tool name', () => {
  const s = session();
  s.send(frame({ tool_calls: [part(0, finalName, '')] }));
  const out = s.send(frame({ tool_calls: [part(0, '_lookup', '{"query":"x"}')] }, 'tool_calls'));
  assert.equal(out.choices[0].delta.tool_calls.map(x => x.function.name || '').join(''), finalName + '_lookup');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
});

test('a completed final tool with empty arguments stays hidden and fails conversion', () => {
  const s = session();
  const first = s.send(frame({ tool_calls: [part(0, finalName, '')] }));
  assert.equal('tool_calls' in first.choices[0].delta, false);
  assert.throws(() => s.send(frame({}, 'tool_calls')), /incomplete/);
});

test('parallel finals follow first appearance even when the first name arrives later', () => {
  const s = session();
  const a = s.send(frame({ tool_calls: [part(0, '__tfa_', ''), part(1, finalName, '{"content":"B"}')] }));
  const b = s.send(frame({ tool_calls: [part(0, 'final_answer', '{"content":"A"}')] }, 'tool_calls'));
  assert.equal((a.choices[0].delta.content || '') + (b.choices[0].delta.content || ''), 'AB');
});

for (const reason of ['length', 'content_filter']) {
  test(`stream retains partial text and ${reason} instead of inventing success`, () => {
    const s = session();
    assert.equal(s.send(frame({ tool_calls: [part(0, finalName, '{"content":"partial')] })).choices[0].delta.content, 'partial');
    assert.equal(s.send(frame({}, reason)).choices[0].finish_reason, reason);
    s.end();
  });
}

test('normal termination requires complete final JSON, abrupt EOF has no successful end', () => {
  const s = session();
  s.send(frame({ tool_calls: [part(0, finalName, '{"content":"partial')] }));
  assert.throws(() => s.send(frame({}, 'tool_calls')));
  const s2 = session();
  s2.send(frame({ tool_calls: [part(0, finalName, '{"content":"ok"}')] }));
  assert.throws(() => s2.end(), /finish_reason/);
});

test('usage-only frames and ordinary reasoning, refusal and text survive', () => {
  const s = session();
  const input = frame({ content: 'native', reasoning_content: 'r', refusal: null }, 'stop');
  assert.deepEqual(s.send(input), input);
  const usage = { id: 'x', choices: [], usage: { prompt_tokens: 100, completion_tokens: 35, completion_tokens_details: { reasoning_tokens: 12 } } };
  assert.deepEqual(s.send(usage), usage);
  s.end();
});

test('truncated parallel final calls still release all decoded text in call order', () => {
  const s = session();
  const a = s.send(frame({ tool_calls: [part(0, finalName, '{"content":"A'), part(1, finalName, '{"content":"B')] }));
  const b = s.send(frame({}, 'length'));
  assert.equal((a.choices[0].delta.content || '') + (b.choices[0].delta.content || ''), 'AB');
  assert.equal(b.choices[0].finish_reason, 'length');
});
