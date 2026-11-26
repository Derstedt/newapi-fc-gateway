import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { normalizeConfig, candidateForAlias, buildCatalog } from './aliases.js';
import { prepareBody, restoreResponse } from './transform.js';
import { rewriteSSE } from './sse.js';

const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'];

function copyHeaders(source, changed = false) {
  const headers = { ...source };
  const connectionNames = String(source.connection || '').split(',').map(name => name.trim().toLowerCase());
  for (const name of [...HOP_HEADERS, ...connectionNames]) delete headers[name];
  if (changed) for (const name of ['content-length', 'content-encoding', 'etag', 'content-md5']) delete headers[name];
  return headers;
}

async function readBody(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function loadConfig(path) {
  try { return normalizeConfig(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { error.status = 500; throw error; }
}

function sendJSON(res, body, status = 200, sourceHeaders = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { ...copyHeaders(sourceHeaders, true), 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length });
  res.end(bytes);
}

async function forward(upstream, res) {
  res.writeHead(upstream.statusCode, copyHeaders(upstream.headers));
  await pipeline(upstream, res);
}

function requestUpstream(base, path, { method, headers, body, signal, identity = false }) {
  // Concatenating after the fixed origin keeps request paths from choosing a host.
  const url = new URL(base + path);
  const outgoingHeaders = copyHeaders(headers);
  if (identity) outgoingHeaders['accept-encoding'] = 'identity';
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers: outgoingHeaders, signal }, resolve);
    request.on('error', reject);
    if (body instanceof Readable) {
      body.on('error', error => request.destroy(error));
      body.pipe(request);
    } else request.end(body);
  });
}

export function createGateway({ upstream, configPath }) {
  const parsed = new URL(upstream);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.search || parsed.hash) {
    throw new Error('NEW_API_URL must be an http(s) root URL without query or fragment.');
  }
  const base = parsed.href.replace(/\/$/, '');

  async function handle(req, res, signal) {
    const path = req.url.split('?')[0];
    if (req.method === 'GET' && path === '/healthz') return sendJSON(res, { status: 'ok' });
    if (!path.startsWith('/v1/')) return sendJSON(res, { error: { message: 'Not found' } }, 404);

    const listModels = req.method === 'GET' && path === '/v1/models';
    const chat = req.method === 'POST' && path === '/v1/chat/completions';
    if (!listModels && !chat) {
      const response = await requestUpstream(base, req.url, { method: req.method, headers: req.headers, body: req, signal });
      return forward(response, res);
    }

    const config = await loadConfig(configPath);
    const original = chat ? await readBody(req) : null;
    let body;
    if (chat) {
      try { body = JSON.parse(original); }
      catch { throw Object.assign(new Error('Invalid JSON request body.'), { status: 400 }); }
    }
    let mapped;
    if (listModels || candidateForAlias(body.model, config)) {
      const headers = copyHeaders(req.headers, true);
      const response = await requestUpstream(base, listModels ? req.url : '/v1/models', { method: 'GET', headers, signal, identity: true });
      if (response.statusCode < 200 || response.statusCode >= 300) return forward(response, res);
      const catalog = buildCatalog(JSON.parse(await readBody(response)), config);
      if (listModels) return sendJSON(res, catalog.body, response.statusCode, { ...response.headers, 'cache-control': 'no-store' });
      mapped = catalog.aliases.get(body.model);
    }

    if (!mapped) {
      const response = await requestUpstream(base, req.url, { method: req.method, headers: req.headers, body: original, signal });
      return forward(response, res);
    }

    const model = body.model;
    const prepared = prepareBody({ ...body, model: mapped }, config);
    const bytes = Buffer.from(JSON.stringify(prepared.body));
    const headers = { ...copyHeaders(req.headers, true), 'content-type': 'application/json', 'content-length': bytes.length };
    const response = await requestUpstream(base, req.url, { method: req.method, headers, body: bytes, signal, identity: true });
    if (response.statusCode < 200 || response.statusCode >= 300) return forward(response, res);

    if (String(response.headers['content-type']).toLowerCase().includes('text/event-stream')) {
      res.writeHead(response.statusCode, { ...copyHeaders(response.headers, true), 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
      await pipeline(Readable.from(rewriteSSE(response, { active: prepared.active, model })), res);
      return;
    }
    const result = JSON.parse(await readBody(response));
    if (prepared.active && !result.error) restoreResponse(result);
    if (typeof result.model === 'string') result.model = model;
    sendJSON(res, result, response.statusCode, response.headers);
  }

  return createServer((req, res) => {
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    req.once('aborted', () => abort.abort());
    handle(req, res, abort.signal).catch(error => {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      sendJSON(res, { error: { message: error.message, type: 'gateway_error', code: 'tfa_gateway_error' } }, error.status || 502);
    });
  });
}
