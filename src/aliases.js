export function normalizeConfig(value = {}) {
  const config = { models: [], exclude: [], prefix: '', suffix: '-fc', with_tools: 'required', ...value };
  for (const key of ['models', 'exclude']) {
    if (!Array.isArray(config[key]) || config[key].some(pattern => typeof pattern !== 'string')) {
      throw new Error(`${key} must be an array of model names or * patterns.`);
    }
  }
  for (const key of ['prefix', 'suffix']) {
    if (typeof config[key] !== 'string') throw new Error(`${key} must be a string.`);
  }
  if (!config.prefix && !config.suffix) throw new Error('prefix and suffix cannot both be empty.');
  if (!['required', 'auto'].includes(config.with_tools)) throw new Error('with_tools must be required or auto.');
  return config;
}

function matches(id, pattern) {
  const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('^' + escaped.join('.*') + '$').test(id);
}

function selected(id, config) {
  return config.models.some(pattern => matches(id, pattern))
    && !config.exclude.some(pattern => matches(id, pattern));
}

// This is only a fast candidate check. The live catalog resolves collisions.
export function candidateForAlias(id, config) {
  if (typeof id !== 'string' || !id.startsWith(config.prefix) || !id.endsWith(config.suffix)) return null;
  const model = id.slice(config.prefix.length, id.length - config.suffix.length);
  return model && selected(model, config) ? model : null;
}

export function buildCatalog(payload, config) {
  const originalIds = new Set(payload.data.map(model => model.id));
  const aliases = new Map();
  const extra = [];
  for (const model of payload.data) {
    if (!selected(model.id, config)) continue;
    const id = config.prefix + model.id + config.suffix;
    if (originalIds.has(id) || aliases.has(id)) continue;
    aliases.set(id, model.id);
    // FC aliases speak Chat Completions; do not copy vendor endpoint hints.
    const alias = { id, object: model.object || 'model' };
    for (const key of ['created', 'owned_by']) {
      if (key in model) alias[key] = model[key];
    }
    extra.push(alias);
  }
  return { body: { ...payload, data: [...payload.data, ...extra] }, aliases };
}
