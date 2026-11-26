import { createContentParser, readContent, finishContent } from './content-json.js';

const FINAL_NAME = '__tfa_final_answer';
const INSTRUCTION = `Write your complete user-facing final answer by calling ${FINAL_NAME} once.
The content argument is the answer itself: preserve the requested depth, language, Markdown, equations and code.
Use the other available tools normally when needed. Finish their work before giving the final answer.
Do not repeat that answer in ordinary text, and do not wait for a result from this final-answer tool.`;
const FINAL_TOOL = {
  type: 'function',
  function: {
    name: FINAL_NAME,
    description: 'Deliver the complete final answer to the user. This is an output channel, not an external action.',
    parameters: {
      type: 'object',
      properties: { content: { type: 'string', description: 'The complete user-facing answer.' } },
      required: ['content'],
      additionalProperties: false,
    },
  },
};

export function prepareBody(body, config = {}) {
  const tools = body.tools || [];
  const bypass = body.tool_choice === 'none' || typeof body.tool_choice === 'object'
    || body.functions !== undefined || body.function_call !== undefined
    || (body.response_format && body.response_format.type !== 'text')
    || (body.modalities || []).some(value => value !== 'text')
    || tools.some(tool => tool.function?.name === FINAL_NAME);
  if (bypass) return { body, active: false };
  return {
    active: true,
    body: {
      ...body,
      messages: [{ role: 'system', content: INSTRUCTION }, ...body.messages],
      tools: [...tools, FINAL_TOOL],
      tool_choice: tools.length ? (body.tool_choice === 'required' ? 'required' : config.with_tools || 'required')
        : { type: 'function', function: { name: FINAL_NAME } },
    },
  };
}

function isTruncated(reason) {
  return reason === 'length' || reason === 'content_filter';
}

function finalReason(reason, hasFinal, realCount) {
  return reason === 'tool_calls' && hasFinal && realCount === 0 ? 'stop' : reason;
}

export function restoreResponse(body) {
  for (const choice of body.choices || []) {
    const message = choice.message;
    if (!message?.tool_calls) continue;
    const realCalls = [];
    let content = '', hasFinal = false;
    for (const call of message.tool_calls) {
      if (call.function?.name !== FINAL_NAME) {
        realCalls.push(call);
        continue;
      }
      hasFinal = true;
      const parser = createContentParser();
      content += readContent(parser, call.function.arguments);
      if (!isTruncated(choice.finish_reason)) finishContent(parser);
    }
    if (!hasFinal) continue;
    message.content = (message.content || '') + content;
    if (realCalls.length) message.tool_calls = realCalls;
    else delete message.tool_calls;
    choice.finish_reason = finalReason(choice.finish_reason, hasFinal, realCalls.length);
  }
  return body;
}

export function createStreamState() {
  return { choices: {} };
}

function createChoice() {
  return { tools: {}, order: [], realCount: 0, hasFinal: false, nextText: 0, finished: false };
}

function classifyTool(choice, tool, isFinal) {
  tool.kind = isFinal ? 'final' : 'real';
  if (isFinal) {
    tool.parser = createContentParser();
    tool.buffer = '';
    choice.hasFinal = true;
  } else tool.outputIndex = choice.realCount++;
}

function consumePart(tool, part, outgoing) {
  if (tool.kind === 'real') outgoing.push({ ...part, index: tool.outputIndex });
  else tool.buffer += readContent(tool.parser, part.function?.arguments || '');
}

function flushPending(tool, outgoing) {
  for (const part of tool.pending) consumePart(tool, part, outgoing);
  delete tool.pending;
  delete tool.name;
}

function acceptPart(choice, part, outgoing) {
  let tool = choice.tools[part.index];
  if (!tool) {
    tool = choice.tools[part.index] = { name: '', pending: [], kind: null };
    choice.order.push(part.index);
  }
  if (tool.kind) {
    consumePart(tool, part, outgoing);
    return;
  }
  tool.name += part.function?.name || '';
  tool.pending.push(part);
  // Arguments establish the name boundary; an exact prefix may still grow.
  if (part.function?.arguments) classifyTool(choice, tool, tool.name === FINAL_NAME);
  else if ((tool.name && !FINAL_NAME.startsWith(tool.name))
    || (part.type && part.type !== 'function')) {
    classifyTool(choice, tool, false);
  }
  if (tool.kind) flushPending(tool, outgoing);
}

function drainFinals(choice, finishing = false) {
  let text = '';
  while (choice.nextText < choice.order.length) {
    const tool = choice.tools[choice.order[choice.nextText]];
    if (!tool.kind) break;
    if (tool.kind === 'real') {
      choice.nextText++;
      continue;
    }
    text += tool.buffer;
    tool.buffer = '';
    // Only later parallel final calls are buffered; the first streams immediately.
    if (!finishing && tool.parser.phase !== 'done') break;
    choice.nextText++;
  }
  return text;
}

export function restoreChunk(chunk, state) {
  for (const choice of chunk.choices || []) {
    const current = state.choices[choice.index] ||= createChoice();
    const delta = choice.delta || {};
    const outgoing = [];
    for (const part of delta.tool_calls || []) acceptPart(current, part, outgoing);
    const finishing = choice.finish_reason != null;
    if (finishing) {
      for (const tool of Object.values(current.tools)) {
        if (!tool.kind) {
          classifyTool(current, tool, tool.name === FINAL_NAME);
          flushPending(tool, outgoing);
        }
        if (tool.kind === 'final' && !isTruncated(choice.finish_reason)) finishContent(tool.parser);
      }
      choice.finish_reason = finalReason(choice.finish_reason, current.hasFinal, current.realCount);
      current.finished = true;
    }
    delete delta.tool_calls;
    if (outgoing.length) delta.tool_calls = outgoing;
    const content = drainFinals(current, finishing);
    if (content) delta.content = (delta.content || '') + content;
    choice.delta = delta;
  }
  return chunk;
}

export function finishStream(state) {
  const choices = Object.values(state.choices);
  if (!choices.length || choices.some(choice => !choice.finished)) {
    throw new Error('Upstream ended without finish_reason.');
  }
}
