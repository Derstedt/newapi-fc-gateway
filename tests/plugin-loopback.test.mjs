import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { convertRequest, convertResponse, convertStreamEvent } from '../src/plugin.js';

// A real HTTP loopback with a small Provider API host fixture. This is not a
// running New API container: routing, authentication and vendor replies are fixtures.
const rawKey = 'Bearer fixture-raw-key';
const userKey = 'Bearer fixture-user-key';
const finalName = '__tfa_final_answer';
const clone = value => JSON.parse(JSON.stringify(value));
const text = value => typeof value === 'string' ? value : JSON.stringify(value);
const modelList = ids => ({ object: 'list', data: ids.map(id => ({ id, object: 'model' })) });
const chat = model => ({ model, messages: [{ role: 'user', content: 'Hello' }] });
const toolCall = (name, args) => ({ id: 'call-' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const reply = (body, message, finish_reason = 'stop') => ({ model: body.model, choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason }], usage: { prompt_tokens: 17, completion_tokens: 9 } });
const final = (body, content) => reply(body, { content: null, tool_calls: [toolCall(finalName, { content })] }, 'tool_calls');
const sendJSON = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(text(body)); };
const sendEvent = (res, data) => res.write(`data: ${text(data)}\n\n`);
const post = (url, body, signal) => fetch(url + '/v1/chat/completions', { method: 'POST', headers: { Authorization: userKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });

async function fixture(t, { vendor, denyRaw = false } = {}) {
  const requests = [], generated = [];
  let convertedCalls = 0;
  const config = { models: ['*'], exclude: [], prefix: '', suffix: '-fc', with_tools: 'required' };
  const originals = ['alpha', 'beta'];
  const savedChannelModels = ['alpha-fc', 'beta-fc'];
  let url;

  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      requests.push({ path: req.url, authorization: req.headers.authorization, body });
      const internal = req.headers.authorization === rawKey;
      if (internal && denyRaw) return sendJSON(res, { error: { message: 'raw token rejected' } }, 401);
      if (!internal && req.headers.authorization !== userKey) return sendJSON(res, { error: { message: 'unauthorized' } }, 401);
      if (req.url === '/v1/models') return sendJSON(res, modelList(internal ? originals : [...originals, ...savedChannelModels]));
      if (req.url !== '/v1/chat/completions') return sendJSON(res, {}, 404);

      if (!internal && savedChannelModels.includes(body.model)) {
        convertedCalls++;
        const ctx = { baseUrl: url, path: req.url, config, state: null };
        const converted = convertRequest(ctx, { body: clone(body), model: body.model, stream: !!body.stream });
        ctx.state = clone(converted.state ?? null);
        const upstream = await fetch(url + (converted.path || req.url), {
          method: 'POST', headers: { Authorization: rawKey, 'Content-Type': 'application/json' }, body: text(converted.body),
        });
        if (!upstream.ok || !converted.stream || converted.nativeResponse) {
          const source = { status: upstream.status, headers: Object.fromEntries(upstream.headers), body: await upstream.text() };
          const result = converted.nativeResponse && upstream.ok ? { body: source.body } : convertResponse(ctx, source);
          return result.error ? sendJSON(res, { error: result.error }, result.error.status || 502) : sendJSON(res, result.body, upstream.status);
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const apply = input => {
          const output = convertStreamEvent({ ...ctx, state: clone(ctx.state) }, input);
          if (output.error) throw new Error(output.error.message);
          if (output.state !== undefined) ctx.state = clone(output.state);
          for (const event of output.events || []) sendEvent(res, event.data);
        };
        // The fake vendor emits data-only SSE. New API's own frame parser is
        // outside this contract test; every real plugin state crosses JSON.
        for await (const line of createInterface({ input: Readable.fromWeb(upstream.body), crlfDelay: Infinity })) {
          if (line.startsWith('data: ')) apply({ data: line.slice(6) });
        }
        apply({ done: true });
        return res.end();
      }

      if (!originals.includes(body.model)) return sendJSON(res, { error: { message: 'model is outside the raw group' } }, 404);
      generated.push(clone(body));
      if (vendor) return await vendor(body, res);
      const hasFinalTool = body.tools?.some(tool => tool.function.name === finalName);
      return sendJSON(res, hasFinalTool ? final(body, '正文😀') : reply(body, { content: 'native answer' }));
    } catch (error) {
      if (!res.headersSent) sendJSON(res, { error: { message: error.message } }, 502);
      else res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return {
    url, requests, generated, convertedCalls: () => convertedCalls,
    async fetchChannelModels() {
      const source = await fetch(url + '/v1/models', { headers: { Authorization: rawKey } });
      return convertResponse({ baseUrl: url, path: '/v1/models', config, state: null }, {
        status: source.status, headers: Object.fromEntries(source.headers), body: await source.text(),
      });
    },
  };
}

test('provider model discovery loops back with the raw key and returns only FC aliases', async t => {
  const f = await fixture(t);
  const result = await f.fetchChannelModels();
  const body = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
  assert.deepEqual(body.data.map(model => model.id), ['alpha-fc', 'beta-fc']);
  assert.deepEqual(f.requests.map(({ path, authorization }) => ({ path, authorization })), [{ path: '/v1/models', authorization: rawKey }]);
  assert.equal(f.convertedCalls(), 0);
  assert.equal(f.generated.length, 0);
});

test('one FC request makes one inner raw-model request and one vendor generation', async t => {
  const f = await fixture(t);
  const response = await post(f.url, chat('alpha-fc'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.model, 'alpha-fc');
  assert.equal(body.choices[0].message.content, '正文😀');
  assert.equal(body.choices[0].message.tool_calls, undefined);
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.deepEqual(body.usage, { prompt_tokens: 17, completion_tokens: 9 });
  assert.equal(f.convertedCalls(), 1);
  assert.equal(f.generated.length, 1);
  assert.deepEqual(f.requests.map(call => [call.authorization, call.body.model]), [[userKey, 'alpha-fc'], [rawKey, 'alpha']]);
  assert.equal(f.generated[0].tools.at(-1).function.name, finalName);
});

test('an original model goes directly to its existing channel without FC hooks', async t => {
  const f = await fixture(t);
  const response = await post(f.url, chat('alpha'));
  assert.equal((await response.json()).choices[0].message.content, 'native answer');
  assert.equal(f.requests.length, 1);
  assert.equal(f.convertedCalls(), 0);
  assert.equal(f.generated.length, 1);
  assert.equal(f.generated[0].tools, undefined);
});

test('a rejected raw token returns the inner status and never reaches the vendor', async t => {
  const f = await fixture(t, { denyRaw: true });
  const response = await post(f.url, chat('alpha-fc'));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.message, 'raw token rejected');
  assert.equal(f.convertedCalls(), 1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.generated.length, 0);
});

test('loopback preserves explicit none while still restoring the FC response model', async t => {
  const f = await fixture(t);
  const response = await post(f.url, { ...chat('alpha-fc'), tool_choice: 'none' });
  const body = await response.json();
  assert.equal(body.model, 'alpha-fc');
  assert.equal(body.choices[0].message.content, 'native answer');
  assert.equal(f.generated[0].tool_choice, 'none');
  assert.equal(f.generated[0].tools, undefined);
});

test('loopback streams partial final text before the raw channel finishes', { timeout: 4000 }, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const chunk = (args, finish_reason, first = false) => ({ model: 'alpha', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { ...(first ? { name: finalName } : {}), arguments: args } }] }, finish_reason }] });
  const f = await fixture(t, { vendor: async (body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sendEvent(res, chunk('{"content":"first', null, true));
    await gate;
    sendEvent(res, chunk(' 正文😀"}', 'tool_calls'));
    sendEvent(res, '[DONE]');
    res.end();
  } });
  const response = await post(f.url, { ...chat('alpha-fc'), stream: true }, AbortSignal.timeout(3000));
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = decoder.decode((await reader.read()).value, { stream: true });
  assert.match(output, /"content":"first"/);
  assert.match(output, /alpha-fc/);
  assert.doesNotMatch(output, /__tfa_final_answer/);
  release();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  output += decoder.decode();
  assert.match(output, /正文😀/);
  assert.match(output, /"finish_reason":"stop"/);
  assert.equal(output.split('[DONE]').length - 1, 1);
  assert.equal(f.convertedCalls(), 1);
  assert.equal(f.generated.length, 1);
});

test('a real tool call and its result continue through the same FC model', async t => {
  const lookup = { type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } };
  const call = toolCall('lookup', {});
  const f = await fixture(t, { vendor: (body, res) => {
    sendJSON(res, body.messages.at(-1).role === 'tool' ? final(body, 'Value is 42') : reply(body, { content: null, tool_calls: [call] }, 'tool_calls'));
  } });
  const request = { ...chat('alpha-fc'), tools: [lookup] };
  const firstResponse = await post(f.url, request);
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.deepEqual(first.choices[0].message.tool_calls, [call]);
  assert.equal(first.choices[0].finish_reason, 'tool_calls');
  const result = { role: 'tool', tool_call_id: call.id, content: '{"value":42}' };
  const history = [...request.messages, first.choices[0].message, result];
  const secondResponse = await post(f.url, { ...request, messages: history });
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json();
  assert.equal(second.choices[0].message.content, 'Value is 42');
  assert.equal(second.choices[0].message.tool_calls, undefined);
  assert.deepEqual(f.generated[1].messages.slice(1), history);
  assert.equal(f.convertedCalls(), 2);
  assert.equal(f.generated.length, 2);
});
