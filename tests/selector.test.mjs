import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/select-models.mjs', import.meta.url));

async function fixture(t, status = 200, ids = ['alpha', 'beta', '中文模型', 'delta']) {
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ path: req.url, authorization: req.headers.authorization });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? {
      object: 'list', data: ids.map(id => ({ id, object: 'model' })),
    } : { error: { message: 'model access denied' } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const directory = await mkdtemp(fileURLToPath(new URL('../.test-selector-', import.meta.url)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = join(directory, 'config', 'config.json');
  const env = { ...process.env, NEW_API_URL: `http://127.0.0.1:${server.address().port}/newapi`,
    NEW_API_TOKEN: 'test-selector-secret', TFA_CONFIG: config };
  async function run(args = [], answer = '') {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.stdin.end(answer);
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  }
  async function existing(value) {
    await mkdir(join(directory, 'config'));
    await writeFile(config, JSON.stringify(value), 'utf8');
  }
  return { calls, config, env, run, existing };
}

test('--list fetches models with the caller token and never writes configuration', async t => {
  const f = await fixture(t);
  const result = await f.run(['--list']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /1\s+alpha/);
  assert.match(result.stdout, /3\s+中文模型/);
  assert.deepEqual(f.calls, [{ path: '/newapi/v1/models', authorization: 'Bearer test-selector-secret' }]);
  await assert.rejects(access(f.config));
});

test('numeric selections and ranges save exact names and preserve other settings', async t => {
  const f = await fixture(t);
  await f.existing({ models: ['old'], exclude: ['*-preview'], prefix: 'fc/', suffix: '', with_tools: 'auto', note: 'keep' });
  const result = await f.run([], '1,3-4,3\n');
  assert.equal(result.code, 0, result.stderr);
  const saved = await readFile(f.config, 'utf8');
  assert.deepEqual(JSON.parse(saved), { models: ['alpha', '中文模型', 'delta'], exclude: ['*-preview'], prefix: 'fc/', suffix: '', with_tools: 'auto', note: 'keep' });
  assert.equal(saved.includes(f.env.NEW_API_TOKEN), false);
  assert.equal((result.stdout + result.stderr).includes(f.env.NEW_API_TOKEN), false);
});

test('all creates an automatic wildcard rule and none clears the selection', async t => {
  const f = await fixture(t);
  assert.equal((await f.run([], 'all\n')).code, 0);
  assert.deepEqual(JSON.parse(await readFile(f.config, 'utf8')).models, ['*']);
  assert.equal((await f.run([], 'none\n')).code, 0);
  assert.deepEqual(JSON.parse(await readFile(f.config, 'utf8')).models, []);
});

test('none clears rules even when the upstream model list is empty', async t => {
  const f = await fixture(t, 200, []);
  await f.existing({ models: ['*'] });
  const result = await f.run([], 'none\n');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /No models available/);
  assert.deepEqual(JSON.parse(await readFile(f.config, 'utf8')).models, []);
});

test('enter leaves an existing config byte-for-byte unchanged', async t => {
  const f = await fixture(t);
  await f.existing({ models: ['alpha'] });
  const before = await readFile(f.config, 'utf8');
  const result = await f.run([], '\n');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(f.config, 'utf8'), before);
});

test('invalid model numbers report the problem without changing config', async t => {
  const f = await fixture(t);
  await f.existing({ models: ['alpha'] });
  const before = await readFile(f.config, 'utf8');
  const result = await f.run([], '1,99\n');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /99/);
  assert.equal(await readFile(f.config, 'utf8'), before);
});

test('a failed upstream model request is readable and is not retried', async t => {
  const f = await fixture(t, 401);
  const result = await f.run(['--list']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /401/);
  assert.match(result.stderr, /model access denied/);
  assert.equal(f.calls.length, 1);
  await assert.rejects(access(f.config));
});

test('first selection initializes the config directory with default alias settings', async t => {
  const f = await fixture(t);
  const result = await f.run([], '2\n');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(f.config, 'utf8')), {
    models: ['beta'], exclude: [], prefix: '', suffix: '-fc', with_tools: 'required',
  });
});

test('missing model token is identified before making a request', async t => {
  const f = await fixture(t);
  delete f.env.NEW_API_TOKEN;
  const result = await f.run(['--list']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /NEW_API_TOKEN/);
  assert.equal(f.calls.length, 0);
});
