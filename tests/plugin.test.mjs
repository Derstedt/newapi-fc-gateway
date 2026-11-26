import test from 'node:test';
import assert from 'node:assert/strict';
import { meta, convertRequest, convertResponse, convertStreamEvent } from '../src/plugin.js';

const name = '__tfa_final_answer';
const realTool = { type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } };
const catalog = ids => ({ object: 'list', data: ids.map(id => ({ id, object: 'model', owned_by: 'upstream' })) });
const response = (body, status = 200) => ({ status, headers: {}, body: JSON.stringify(body) });
const call = text => ({ id: 'hidden', type: 'function', function: { name, arguments: JSON.stringify({ content: text }) } });
const reply = text => ({ model: 'alpha', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call(text)] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
const frame = (delta, finish_reason = null) => ({ model: 'alpha', choices: [{ index: 0, delta, finish_reason }] });

function begin(extra = {}, config = {}) {
  const request = { model: 'alpha-fc', stream: true, body: { model: 'alpha-fc', messages: [{ role: 'user', content: 'hi' }], stream: true, ...extra } };
  const ctx = { baseUrl: 'http://127.0.0.1:3000', path: '/v1/chat/completions', config };
  const converted = convertRequest(ctx, request);
  return { request, converted, ctx: { ...ctx, state: JSON.parse(JSON.stringify(converted.state)) } };
}

function event(ctx, body) {
  const result = convertStreamEvent(ctx, { data: JSON.stringify(body) });
  if (result.state) ctx.state = JSON.parse(JSON.stringify(result.state));
  return result;
}

test('provider manifest declares only the two converted routes and native channel settings', () => {
  assert.equal(meta.apiVersion, 1);
  assert.equal(meta.key, 'newapi_fc_gateway');
  assert.equal(meta.version, '2.1.0');
  assert.equal(meta.baseUrl, 'http://127.0.0.1:3000');
  assert.deepEqual(meta.relay.map(route => [route.incoming_path, route.upstream_path, route.converter]), [
    ['/v1/chat/completions', '/v1/chat/completions', 'plugin'],
    ['/v1/models', '/v1/models', 'plugin'],
  ]);
  assert.deepEqual(meta.channelConfig.properties.models.default, ['*']);
  assert.equal(meta.channelConfig.properties.models.items.type, 'string');
  assert.ok(meta.channelConfig.properties.models.items.title);
  for (const key of ['routes', 'channelTypes', 'upstreams', 'auth', 'protocols']) assert.equal(key in meta, false);
});

test('model discovery works without a request hook or state and publishes aliases only', () => {
  const result = convertResponse({ path: '/v1/models', config: {}, state: null }, response(catalog(['alpha', 'beta'])));
  assert.deepEqual(result.body.data.map(item => item.id), ['alpha-fc', 'beta-fc']);
  assert.equal(result.body.object, 'list');
  assert.equal(result.body.data[0].owned_by, 'upstream');
});

test('model discovery applies channel rules, excludes and custom affixes', () => {
  const config = { models: ['family-*'], exclude: ['*-embed'], prefix: 'fc/', suffix: '' };
  const result = convertResponse({ path: '/v1/models', config, state: null }, response(catalog(['family-a', 'family-embed', 'other'])));
  assert.deepEqual(result.body.data.map(item => item.id), ['fc/family-a']);
  const empty = convertResponse({ path: '/v1/models', config: { models: [] }, state: null }, response(catalog(['alpha'])));
  assert.deepEqual(empty.body.data, []);
});

test('discovery never publishes an alias that collides with a real upstream name', () => {
  const result = convertResponse({ path: '/v1/models', config: { models: ['alpha'] }, state: null }, response(catalog(['alpha', 'alpha-fc'])));
  assert.deepEqual(result.body.data, []);
});

test('chat resolves an alias once and preserves original business tools and request options', () => {
  const { request, converted } = begin({ tools: [realTool], temperature: 0.4, parallel_tool_calls: true });
  assert.equal(request.body.model, 'alpha-fc');
  assert.equal(converted.body.model, 'alpha');
  assert.equal(converted.body.temperature, 0.4);
  assert.equal(converted.body.parallel_tool_calls, true);
  assert.deepEqual(converted.body.tools[0], realTool);
  assert.equal(converted.body.tools.at(-1).function.name, name);
  assert.equal(converted.body.tool_choice, 'required');
  assert.equal(converted.stream, true);
  assert.equal(converted.state.model, 'alpha-fc');
  assert.equal(converted.state.active, true);
  assert.deepEqual(JSON.parse(JSON.stringify(converted.state)), converted.state);
});

test('chat uses configured prefixes and does not accept ordinary or excluded model names', () => {
  const ctx = { config: { models: ['alpha'], prefix: 'fc/', suffix: '' } };
  const body = { model: 'fc/alpha', messages: [] };
  assert.equal(convertRequest(ctx, { body, model: body.model, stream: false }).body.model, 'alpha');
  assert.throws(() => convertRequest(ctx, { body, model: 'alpha', stream: false }), /alias|别名/i);
  assert.throws(() => convertRequest({ config: { exclude: ['alpha'] } }, { body, model: 'alpha-fc' }), /alias|别名/i);
});

test('JSON response restores content and requested alias while preserving usage and real tools', () => {
  const { ctx } = begin({ tools: [realTool] });
  const body = reply('正文😀');
  const real = { id: 'lookup-1', type: 'function', function: { name: 'lookup', arguments: '{}' } };
  body.choices[0].message.tool_calls.push(real);
  const result = convertResponse(ctx, response(body)).body;
  assert.equal(result.model, 'alpha-fc');
  assert.equal(result.choices[0].message.content, '正文😀');
  assert.deepEqual(result.choices[0].message.tool_calls, [real]);
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(result.usage, body.usage);
});

for (const [label, extra] of [
  ['none', { tool_choice: 'none' }],
  ['named tool', { tools: [realTool], tool_choice: { type: 'function', function: { name: 'lookup' } } }],
  ['structured output', { response_format: { type: 'json_object' } }],
]) {
  test(`bypassed ${label} still uses response hooks to restore the alias`, () => {
    const { ctx, converted } = begin(extra);
    assert.equal(converted.state.active, false);
    assert.notEqual(converted.nativeResponse, true);
    assert.equal(converted.body.model, 'alpha');
    assert.deepEqual(converted.body.tool_choice, extra.tool_choice);
    const body = { model: 'alpha', choices: [{ message: { content: 'native' }, finish_reason: 'stop' }] };
    const result = convertResponse(ctx, response(body)).body;
    assert.deepEqual(result, { ...body, model: 'alpha-fc' });
    const streamed = event(ctx, frame({ content: 'native', reasoning_content: 'reason' }, 'stop'));
    assert.deepEqual(streamed.events[0].data, { ...frame({ content: 'native', reasoning_content: 'reason' }, 'stop'), model: 'alpha-fc' });
  });
}

test('stream emits partial text across serialized state, preserves usage and only forwards actual DONE', () => {
  const { ctx } = begin();
  const first = event(ctx, frame({ tool_calls: [{ index: 0, id: 'hidden', type: 'function', function: { name, arguments: '{"content":"中文\\n\\uD83D' } }] }));
  assert.equal(first.events[0].data.choices[0].delta.content, '中文\n');
  assert.equal(first.events[0].data.model, 'alpha-fc');
  assert.equal(JSON.stringify(first.events).includes(name), false);
  const last = event(ctx, frame({ tool_calls: [{ index: 0, function: { arguments: '\\uDE00"}' } }] }, 'tool_calls'));
  assert.equal(last.events[0].data.choices[0].delta.content, '😀');
  assert.equal(last.events[0].data.choices[0].finish_reason, 'stop');
  const usage = { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } };
  assert.deepEqual(event(ctx, usage).events[0].data, usage);
  assert.deepEqual(convertStreamEvent(ctx, { data: '[DONE]' }).events, [{ data: '[DONE]' }]);
  assert.deepEqual(convertStreamEvent(ctx, { done: true }), {});
});

test('unfinished or empty streams become host errors instead of successful terminators', () => {
  const { ctx } = begin();
  assert.equal(convertStreamEvent(ctx, { done: true }).error.status, 502);
  event(ctx, frame({ tool_calls: [{ index: 0, function: { name, arguments: '{"content":"partial' } }] }));
  assert.equal(convertStreamEvent(ctx, { data: '[DONE]' }).error.code, 'tfa_invalid_response');
  assert.equal(convertStreamEvent(ctx, { done: true }).events, undefined);
});

test('truncated responses keep their finish reason and decoded text', () => {
  const { ctx } = begin();
  const result = event(ctx, frame({ tool_calls: [{ index: 0, function: { name, arguments: '{"content":"partial' } }] }, 'length'));
  assert.equal(result.events[0].data.choices[0].delta.content, 'partial');
  assert.equal(result.events[0].data.choices[0].finish_reason, 'length');
  assert.deepEqual(convertStreamEvent(ctx, { done: true }), {});
});

test('HTTP errors keep host handling and successful error envelopes use the documented error result', () => {
  const { ctx } = begin();
  const error = response({ error: { message: 'quota exceeded' } }, 429);
  assert.deepEqual(convertResponse(ctx, error), { body: error.body });
  assert.deepEqual(convertResponse({ path: '/v1/models', state: null }, error), { body: error.body });
  assert.equal(convertResponse(ctx, response({ error: { message: 'upstream busy' } })).error.message, 'upstream busy');
  assert.equal(convertStreamEvent(ctx, { data: 'not-json' }).error.status, 502);
  assert.deepEqual(convertStreamEvent(ctx, { event: 'ping', data: '' }), {});
});
