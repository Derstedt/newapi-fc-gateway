import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { createGateway } from '../src/gateway.js';

const defaultConfig = { models: ['alpha'], suffix: '-fc' };
const models = ids => ({ object: 'list', data: ids.map(id => ({ id, object: 'model', created: 1, owned_by: 'test' })) });
const finalResponse = (content = 'hello') => ({ model: 'alpha', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'final', type: 'function', function: { name: '__tfa_final_answer', arguments: JSON.stringify({ content }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 15, completion_tokens: 20 } });
const json = (res, body, status = 200) => { const bytes = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes), 'X-Upstream': 'newapi' }); res.end(bytes); };
async function read(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function setup(t, handler, config = defaultConfig, prefix = '') {
  const calls = [];
  const upstream = createServer(async (req, res) => {
    try {
      const body = await read(req);
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      await handler(req, res, body, calls);
    } catch (error) { if (!res.destroyed) json(res, { error: error.message }, 500); }
  });
  const upstreamURL = await listen(upstream);
  const directory = await mkdtemp(join(fileURLToPath(new URL('../', import.meta.url)), '.test-'));
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  const gateway = createGateway({ upstream: upstreamURL + prefix, configPath });
  const url = await listen(gateway);
  t.after(async () => {
    for (const server of [gateway, upstream]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(directory, { recursive: true, force: true });
  });
  return { url, calls, configPath, upstream };
}
const post = (url, body, options = {}) => fetch(url + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options });
const chat = model => ({ model, messages: [{ role: 'user', content: 'hi' }] });

test('models list keeps originals and adds aliases using the current client credentials', async t => {
  const env = await setup(t, (req, res) => json(res, models(['alpha', 'beta'])));
  const response = await fetch(env.url + '/v1/models', { headers: { Authorization: 'Bearer alice', 'New-Api-User': '7' } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map(m => m.id), ['alpha', 'beta', 'alpha-fc']);
  assert.equal(env.calls[0].headers.authorization, 'Bearer alice');
  assert.equal(env.calls[0].headers['new-api-user'], '7');
  assert.equal(env.calls[0].url, '/v1/models');
});

test('different clients never share model catalogs', async t => {
  const env = await setup(t, (req, res) => json(res, models([req.headers.authorization === 'Bearer alice' ? 'a' : 'b'])), { models: ['*'] });
  for (const [who, expected] of [['alice', ['a', 'a-fc']], ['bob', ['b', 'b-fc']]]) {
    const res = await fetch(env.url + '/v1/models', { headers: { Authorization: `Bearer ${who}` } });
    assert.deepEqual((await res.json()).data.map(m => m.id), expected);
  }
  assert.equal(env.calls.length, 2);
});

test('normal chat preserves request bytes and does not fetch the model list', async t => {
  const reply = { model: 'alpha', choices: [{ message: { content: 'native' }, finish_reason: 'stop' }] };
  const env = await setup(t, (req, res) => json(res, reply));
  const bytes = '{ "model": "alpha", "messages": [{"role":"user","content":"hi"}] }';
  const res = await fetch(env.url + '/v1/chat/completions?trace=yes', { method: 'POST', headers: { Authorization: 'Bearer alice', 'Content-Type': 'application/json' }, body: bytes });
  assert.deepEqual(await res.json(), reply);
  assert.equal(res.headers.get('x-upstream'), 'newapi');
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].body.toString(), bytes);
  assert.equal(env.calls[0].url, '/v1/chat/completions?trace=yes');
});

test('an FC alias resolves to the existing model and restores the final answer', async t => {
  const env = await setup(t, (req, res) => json(res, req.url === '/v1/models' ? models(['alpha']) : finalResponse('正文😀')));
  const res = await post(env.url, chat('alpha-fc'));
  const result = await res.json();
  assert.equal(result.model, 'alpha-fc');
  assert.equal(result.choices[0].message.content, '正文😀');
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.deepEqual(result.usage, { prompt_tokens: 15, completion_tokens: 20 });
  const sent = JSON.parse(env.calls[1].body);
  assert.equal(sent.model, 'alpha');
  assert.equal(sent.tools.at(-1).function.name, '__tfa_final_answer');
  assert.equal(env.calls.filter(c => c.url === '/v1/chat/completions').length, 1);
  assert.ok(env.calls.every(c => c.headers.authorization === 'Bearer client-key'));
});

test('FC alias honors explicit tool disable and preserves native content', async t => {
  const env = await setup(t, (req, res) => json(res, req.url === '/v1/models' ? models(['alpha']) : { model: 'alpha', choices: [{ message: { content: 'native' }, finish_reason: 'stop' }] }));
  const response = await post(env.url, { ...chat('alpha-fc'), tool_choice: 'none' });
  const body = await response.json();
  assert.equal(body.model, 'alpha-fc');
  assert.equal(body.choices[0].message.content, 'native');
  const sent = JSON.parse(env.calls[1].body);
  assert.equal(sent.model, 'alpha');
  assert.equal(sent.tool_choice, 'none');
  assert.equal('tools' in sent, false);
});

test('a genuine model with the alias name is called unchanged', async t => {
  const env = await setup(t, (req, res, body) => json(res, req.url === '/v1/models' ? models(['alpha', 'alpha-fc']) : { model: JSON.parse(body).model, choices: [] }));
  const res = await post(env.url, chat('alpha-fc'));
  assert.equal((await res.json()).model, 'alpha-fc');
  const sent = JSON.parse(env.calls[1].body);
  assert.equal(sent.model, 'alpha-fc');
  assert.equal('tools' in sent, false);
});

test('configuration updates apply to the next request and support custom prefixes', async t => {
  const env = await setup(t, (req, res) => json(res, models(['alpha', 'beta'])));
  await writeFile(env.configPath, JSON.stringify({ models: ['beta'], prefix: 'fc/', suffix: '' }));
  const res = await fetch(env.url + '/v1/models');
  assert.deepEqual((await res.json()).data.map(m => m.id), ['alpha', 'beta', 'fc/beta']);
});

test('model catalog HTTP errors preserve status and do not start generation', async t => {
  const env = await setup(t, (req, res) => json(res, { error: { message: 'not authorized' } }, 401));
  const res = await post(env.url, chat('alpha-fc'));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.message, 'not authorized');
  assert.equal(env.calls.length, 1);
});

test('generation errors preserve the upstream status and body', async t => {
  const env = await setup(t, (req, res) => req.url === '/v1/models' ? json(res, models(['alpha'])) : json(res, { error: { message: 'quota exceeded' } }, 429));
  const res = await post(env.url, chat('alpha-fc'));
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.message, 'quota exceeded');
});

test('other v1 HTTP endpoints preserve binary bodies, encodings and fixed upstream path prefixes', async t => {
  const compressed = gzipSync('unchanged response');
  const env = await setup(t, (req, res, body) => { res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.length }); res.end(compressed); }, defaultConfig, '/proxy');
  const response = await new Promise((resolve, reject) => {
    const req = request(env.url + '/v1/embeddings?test=1', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' } }, async res => resolve({ headers: res.headers, body: await read(res) }));
    req.on('error', reject); req.end(Buffer.from([0, 255, 12]));
  });
  assert.deepEqual(response.body, compressed);
  assert.equal(response.headers['content-encoding'], 'gzip');
  assert.equal(env.calls[0].url, '/proxy/v1/embeddings?test=1');
  assert.deepEqual(env.calls[0].body, Buffer.from([0, 255, 12]));
});

test('SSE final text streams immediately with a mixed-case Content-Type', { timeout: 4000 }, async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const env = await setup(t, async (req, res) => {
    if (req.url === '/v1/models') return json(res, models(['alpha']));
    res.writeHead(200, { 'Content-Type': 'Text/Event-Stream; charset=utf-8' });
    res.write('data: ' + JSON.stringify({ model: 'alpha', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: '__tfa_final_answer', arguments: '{"content":"first' } }] }, finish_reason: null }] }) + '\n\n');
    await wait;
    res.end('data: ' + JSON.stringify({ model: 'alpha', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ' last"}' } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n');
  });
  const res = await post(env.url, { ...chat('alpha-fc'), stream: true }, { signal: AbortSignal.timeout(3000) });
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /first/);
  assert.match(first, /alpha-fc/);
  assert.doesNotMatch(first, /__tfa_final_answer/);
  release();
  let rest = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
  assert.match(rest, /last/);
  assert.match(rest, /\[DONE\]/);
});

test('client cancellation closes a streaming upstream', { timeout: 4000 }, async t => {
  let closed;
  const ended = new Promise(resolve => { closed = resolve; });
  const env = await setup(t, (req, res) => {
    if (req.url === '/v1/models') return json(res, models(['alpha']));
    res.once('close', closed);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'started' }, finish_reason: null }] }) + '\n\n');
  });
  const controller = new AbortController();
  const res = await post(env.url, { ...chat('alpha-fc'), stream: true }, { signal: controller.signal });
  await res.body.getReader().read();
  controller.abort();
  await ended;
});

test('health is local and non-v1 routes are not sent to New API', async t => {
  const env = await setup(t, (req, res) => json(res, {}));
  assert.equal((await fetch(env.url + '/healthz')).status, 200);
  assert.equal((await fetch(env.url + '/api/option/')).status, 404);
  assert.equal(env.calls.length, 0);
});
