import { normalizeConfig, candidateForAlias, buildCatalog } from './aliases.js';
import { prepareBody, restoreResponse, createStreamState, restoreChunk, finishStream } from './transform.js';

export const meta = {
  apiVersion: 1,
  key: 'newapi_fc_gateway',
  name: { en: 'New API FC', zh: 'New API FC 回环' },
  version: '2.1.0',
  author: { name: 'New API FC Gateway contributors' },
  description: { en: 'Selected model aliases with tool-based final answers', zh: '为所选原模型生成别名，通过工具生成并还原正文' },
  baseUrl: 'http://127.0.0.1:3000',
  keyHint: { en: 'New API model key fixed to the raw group', zh: '固定使用 raw 分组的 New API 模型调用 Key' },
  relay: [
    { incoming_path: '/v1/chat/completions', upstream_path: '/v1/chat/completions', converter: 'plugin' },
    { incoming_path: '/v1/models', upstream_path: '/v1/models', converter: 'plugin' },
  ],
  channelConfig: {
    type: 'object',
    properties: {
      models: {
        type: 'array', title: { en: 'Original model patterns', zh: '原模型选择规则' },
        description: { en: 'Exact names or * patterns; select published aliases in the channel model list', zh: '填写原模型精确名或 * 通配规则，再从渠道模型列表批量选择别名' },
        items: { type: 'string', title: { en: 'Model pattern', zh: '模型规则' } }, default: ['*'],
      },
      exclude: {
        type: 'array', title: { en: 'Excluded model patterns', zh: '排除的原模型规则' },
        items: { type: 'string', title: { en: 'Model pattern', zh: '模型规则' } }, default: [],
      },
      prefix: { type: 'string', title: { en: 'Alias prefix', zh: '别名前缀' }, default: '' },
      suffix: { type: 'string', title: { en: 'Alias suffix', zh: '别名后缀' }, default: '-fc' },
      with_tools: {
        type: 'string', title: { en: 'Choice with business tools', zh: '已有业务工具时的选择策略' },
        enum: ['required', 'auto'], default: 'required',
      },
    },
  },
};

function pluginConfig(ctx) {
  return normalizeConfig({ models: ['*'], ...ctx.config });
}

function conversionError(error) {
  return { error: { status: 502, type: 'upstream_error', code: 'tfa_invalid_response', message: error.message } };
}

function decodeBody(text) {
  const body = JSON.parse(text);
  if (body.error) throw new Error(body.error.message || 'Upstream API returned an error.');
  return body;
}

export function convertRequest(ctx, request) {
  const config = pluginConfig(ctx);
  const model = candidateForAlias(request.model, config);
  if (!model) throw new Error('Expected a selected FC alias. Refresh and save the channel model list after changing its rules.');
  const { body, active } = prepareBody({ ...request.body, model }, config);
  return { body, stream: request.stream, state: { model: request.model, active, ...createStreamState() } };
}

export function convertResponse(ctx, response) {
  // New API retains the original HTTP status and body on its error path.
  if (response.status < 200 || response.status >= 300) return { body: response.body };
  try {
    const body = decodeBody(response.body);
    // Model discovery calls only this hook, with no request state.
    if (ctx.path === '/v1/models') {
      const catalog = buildCatalog(body, pluginConfig(ctx));
      catalog.body.data = catalog.body.data.filter(model => catalog.aliases.has(model.id));
      return { body: catalog.body };
    }
    if (ctx.state.active) restoreResponse(body);
    if (typeof body.model === 'string') body.model = ctx.state.model;
    return { body };
  } catch (error) {
    return conversionError(error);
  }
}

export function convertStreamEvent(ctx, input) {
  try {
    if (input.done || input.data === '[DONE]') {
      if (ctx.state.active) finishStream(ctx.state);
      return input.done ? {} : { events: [{ data: '[DONE]' }] };
    }
    if (!input.data) return {};
    const body = decodeBody(input.data);
    if (ctx.state.active) restoreChunk(body, ctx.state);
    if (typeof body.model === 'string') body.model = ctx.state.model;
    return { events: [{ ...(input.event ? { event: input.event } : {}), data: body }], state: ctx.state };
  } catch (error) {
    return conversionError(error);
  }
}
