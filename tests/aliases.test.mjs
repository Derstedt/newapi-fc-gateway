import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, candidateForAlias, buildCatalog } from '../src/aliases.js';

const modelList = (...ids) => ({ object: 'list', data: ids.map(id => ({ id, object: 'model', created: 1, owned_by: 'provider' })) });

test('default configuration leaves every original model visible without aliases', () => {
  const config = normalizeConfig({});
  assert.deepEqual(config, { models: [], exclude: [], prefix: '', suffix: '-fc', with_tools: 'required' });
  const payload = modelList('alpha', 'beta');
  const result = buildCatalog(payload, config);
  assert.deepEqual(result.body, payload);
  assert.equal(result.aliases.size, 0);
});

test('selected exact names produce aliases while preserving the original list and metadata', () => {
  const payload = modelList('alpha', 'beta');
  payload.data[0].supported_endpoint_types = ['openai', 'openai_responses'];
  payload.data[0].provider_detail = { region: 'region-1' };
  payload.extra = 'preserved';
  const snapshot = structuredClone(payload);
  const result = buildCatalog(payload, normalizeConfig({ models: ['alpha'] }));
  assert.deepEqual(payload, snapshot);
  assert.deepEqual(result.body.data.slice(0, 2), snapshot.data);
  assert.deepEqual(result.body.data[2], { id: 'alpha-fc', object: 'model', created: 1, owned_by: 'provider' });
  assert.equal(result.body.extra, 'preserved');
  assert.equal(result.aliases.get('alpha-fc'), 'alpha');
  assert.equal(candidateForAlias('alpha-fc', normalizeConfig({ models: ['alpha'] })), 'alpha');
  assert.equal(candidateForAlias('beta-fc', normalizeConfig({ models: ['alpha'] })), null);
});

test('wildcards and exclusions select model families with literal regex punctuation', () => {
  const config = normalizeConfig({ models: ['chat-*', 'literal.[x]'], exclude: ['*-preview'] });
  const result = buildCatalog(modelList('chat-a', 'chat-a-preview', 'embed-a', 'literal.[x]', 'literal.x'), config);
  assert.deepEqual([...result.aliases], [['chat-a-fc', 'chat-a'], ['literal.[x]-fc', 'literal.[x]']]);
  assert.equal(candidateForAlias('chat-a-preview-fc', config), null);
  assert.equal(candidateForAlias('chat-new-fc', config), 'chat-new');
});

test('a real upstream model wins over a generated alias collision', () => {
  const config = normalizeConfig({ models: ['*'] });
  const result = buildCatalog(modelList('alpha', 'alpha-fc'), config);
  assert.deepEqual(result.body.data.map(x => x.id), ['alpha', 'alpha-fc', 'alpha-fc-fc']);
  assert.equal(result.aliases.has('alpha-fc'), false);
  assert.equal(result.aliases.get('alpha-fc-fc'), 'alpha-fc');
  assert.equal(candidateForAlias('alpha-fc', config), 'alpha'); // The catalog decides whether this candidate is real.
});

test('custom prefix and suffix are removed exactly once', () => {
  const config = normalizeConfig({ models: ['*'], prefix: 'fc/', suffix: '@tools' });
  const result = buildCatalog(modelList('vendor/model'), config);
  assert.equal(result.aliases.get('fc/vendor/model@tools'), 'vendor/model');
  assert.equal(candidateForAlias('fc/vendor/model@tools', config), 'vendor/model');
  assert.equal(candidateForAlias('vendor/model@tools', config), null);
  assert.equal(candidateForAlias('fc/vendor/model', config), null);
  assert.equal(candidateForAlias('fc/@tools', config), null);
});

test('prefix-only aliases work without the empty-suffix slicing trap', () => {
  const config = normalizeConfig({ models: ['alpha'], prefix: 'fc-', suffix: '' });
  assert.equal(candidateForAlias('fc-alpha', config), 'alpha');
  assert.equal(candidateForAlias('alpha', config), null);
  assert.equal(buildCatalog(modelList('alpha'), config).aliases.get('fc-alpha'), 'alpha');
});

test('catalog calls depend only on their own upstream list', () => {
  const config = normalizeConfig({ models: ['*'] });
  assert.deepEqual([...buildCatalog(modelList('user-a'), config).aliases.keys()], ['user-a-fc']);
  assert.deepEqual([...buildCatalog(modelList('user-b'), config).aliases.keys()], ['user-b-fc']);
  assert.equal(buildCatalog(modelList('user-b'), config).aliases.has('user-a-fc'), false);
});

test('duplicate upstream ids do not cause duplicate generated aliases', () => {
  const result = buildCatalog(modelList('alpha', 'alpha'), normalizeConfig({ models: ['*'] }));
  assert.equal(result.body.data.filter(x => x.id === 'alpha-fc').length, 1);
});

test('configuration errors identify the setting rather than failing during a request', () => {
  assert.throws(() => normalizeConfig({ models: 'alpha' }), /models/);
  assert.throws(() => normalizeConfig({ exclude: [3] }), /exclude/);
  assert.throws(() => normalizeConfig({ prefix: '', suffix: '' }), /prefix.*suffix/);
  assert.throws(() => normalizeConfig({ prefix: 3 }), /prefix/);
  assert.throws(() => normalizeConfig({ with_tools: 'force' }), /with_tools/);
});
