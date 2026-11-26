import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
let source;
function loadPlugin() {
  if (!source) {
    execFileSync(process.execPath, [fileURLToPath(new URL('scripts/build-plugin.mjs', root))], {
      cwd: fileURLToPath(new URL('docs/', root)),
    });
    source = readFileSync(new URL('dist/newapi-fc.plugin.js', root), 'utf8');
  }
  assert.doesNotMatch(source, /^import\s/m);
  return vm.runInNewContext(source.replace(/^export /gm, '')
    + '\n({ meta, convertRequest, convertResponse, convertStreamEvent });');
}
const plain = value => JSON.parse(JSON.stringify(value));
const context = () => ({ path: '/v1/chat/completions', baseUrl: 'http://127.0.0.1:3000', config: { models: ['alpha'] } });
const request = extra => ({ model: 'alpha-fc', stream: false,
  body: { model: 'alpha-fc', messages: [{ role: 'user', content: 'Hi' }], ...extra } });
const toolCall = args => ({ id: 'final', type: 'function', function: { name: '__tfa_final_answer', arguments: args } });

test('standalone plugin builds without imports and converts models with null state', () => {
  const plugin = loadPlugin();
  assert.equal(plugin.meta.key, 'newapi_fc_gateway');
  assert.equal(plugin.meta.version, '2.1.0');
  const result = plugin.convertResponse({ ...context(), path: '/v1/models', state: null }, {
    status: 200, headers: {}, body: JSON.stringify({ object: 'list', data: [{ id: 'alpha' }, { id: 'beta' }] }),
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(plain(result.body.data).map(model => model.id), ['alpha-fc']);
});

test('standalone plugin completes a chat request and response without Node globals', () => {
  const plugin = loadPlugin();
  const ctx = context();
  const converted = plugin.convertRequest(ctx, request());
  assert.equal(converted.body.model, 'alpha');
  assert.equal(converted.body.tools.at(-1).function.name, '__tfa_final_answer');
  const result = plugin.convertResponse({ ...ctx, state: plain(converted.state) }, {
    status: 200, headers: {}, body: JSON.stringify({ model: 'alpha', choices: [{ index: 0,
      message: { role: 'assistant', content: null, tool_calls: [toolCall('{"content":"正文"}')] },
      finish_reason: 'tool_calls' }], usage: { completion_tokens: 8 } }),
  });
  assert.equal(result.body.model, 'alpha-fc');
  assert.equal(result.body.choices[0].message.content, '正文');
  assert.equal(result.body.choices[0].finish_reason, 'stop');
  assert.deepEqual(plain(result.body.usage), { completion_tokens: 8 });
});

test('standalone streaming plugin preserves JSON state and emits text before completion', () => {
  const plugin = loadPlugin();
  const ctx = context();
  const converted = plugin.convertRequest(ctx, { ...request({ stream: true }), stream: true });
  ctx.state = plain(converted.state);
  const first = plugin.convertStreamEvent(ctx, { data: JSON.stringify({ model: 'alpha', choices: [{ index: 0,
    delta: { tool_calls: [{ index: 0, ...toolCall('{"content":"中文\\n\\uD83D') }] }, finish_reason: null }] }) });
  assert.equal(first.error, undefined);
  assert.equal(first.events[0].data.model, 'alpha-fc');
  assert.equal(first.events[0].data.choices[0].delta.content, '中文\n');
  assert.doesNotMatch(JSON.stringify(first.events), /__tfa_final_answer/);
  ctx.state = plain(first.state);
  const last = plugin.convertStreamEvent(ctx, { data: JSON.stringify({ model: 'alpha', choices: [{ index: 0,
    delta: { tool_calls: [{ index: 0, function: { arguments: '\\uDE00"}' } }] }, finish_reason: 'tool_calls' }] }) });
  assert.equal(last.error, undefined);
  assert.equal(last.events[0].data.choices[0].delta.content, '😀');
  assert.equal(last.events[0].data.choices[0].finish_reason, 'stop');
  ctx.state = plain(last.state);
  assert.deepEqual(plain(plugin.convertStreamEvent(ctx, { data: '[DONE]' }).events), [{ data: '[DONE]' }]);
  assert.deepEqual(plain(plugin.convertStreamEvent(ctx, { done: true }).events || []), []);
});

test('standalone plugin still rewrites model names when body injection is bypassed', () => {
  const plugin = loadPlugin();
  const ctx = context();
  const converted = plugin.convertRequest(ctx, request({ tool_choice: 'none' }));
  assert.notEqual(converted.nativeResponse, true);
  assert.equal(converted.body.model, 'alpha');
  assert.equal(converted.body.tools, undefined);
  const result = plugin.convertResponse({ ...ctx, state: plain(converted.state) }, {
    status: 200, headers: {}, body: JSON.stringify({ model: 'alpha', choices: [{ message: { content: 'native' }, finish_reason: 'stop' }] }),
  });
  assert.equal(result.body.model, 'alpha-fc');
  assert.equal(result.body.choices[0].message.content, 'native');
});
