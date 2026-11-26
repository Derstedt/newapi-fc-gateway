import { StringDecoder } from 'node:string_decoder';
import { createStreamState, restoreChunk, finishStream } from './transform.js';

// Scan each decoded character once; keep only the current SSE frame.
async function* frames(readable) {
  const decoder = new StringDecoder('utf8');
  let buffer = '', position = 0, lineStart = 0;
  let atStart = true;
  function* scan(text, final = false) {
    if (atStart && text.length) {
      text = text.replace(/^\uFEFF/, '');
      atStart = false;
    }
    buffer += text;
    while (position < buffer.length) {
      const char = buffer[position];
      if (char !== '\r' && char !== '\n') {
        position++;
        continue;
      }
      if (char === '\r' && position + 1 === buffer.length && !final) return;
      const end = position + (char === '\r' && buffer[position + 1] === '\n' ? 2 : 1);
      if (position === lineStart) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end);
        position = lineStart = 0;
        yield raw;
      } else position = lineStart = end;
    }
  }
  for await (const chunk of readable) yield* scan(typeof chunk === 'string' ? chunk : decoder.write(chunk));
  yield* scan(decoder.end(), true);
  if (buffer.length) throw new Error('Upstream ended inside an SSE event.');
}

function eventData(raw) {
  const metadata = [], values = [];
  let event = '';
  for (const line of raw.split(/\r\n|\r|\n/)) {
    if (!line) continue;
    if (line === 'data' || line.startsWith('data:')) values.push(line.slice(5).replace(/^ /, ''));
    else {
      metadata.push(line);
      if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '');
    }
  }
  return { data: values.join('\n'), metadata, event };
}

export async function* rewriteSSE(readable, { active, model }) {
  const state = createStreamState();
  try {
    for await (const raw of frames(readable)) {
      const { data, metadata, event } = eventData(raw);
      if (event === 'error') {
        yield raw;
        return;
      }
      if (!data) {
        yield raw;
        continue;
      }
      if (data === '[DONE]') {
        if (active) finishStream(state);
        yield raw;
        return;
      }
      const body = JSON.parse(data);
      if (body.error) {
        yield raw;
        return;
      }
      if (active) restoreChunk(body, state);
      if ('model' in body) body.model = model;
      yield metadata.map(line => line + '\n').join('') + `data: ${JSON.stringify(body)}\n\n`;
    }
    if (active) finishStream(state);
  } catch (error) {
    yield `data: ${JSON.stringify({ error: { message: error.message, type: 'upstream_error', code: 'tfa_stream_error' } })}\n\n`;
  } finally {
    readable.destroy();
  }
}
