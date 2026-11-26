import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { normalizeConfig } from '../src/aliases.js';

function selectModels(answer, models) {
  if (answer.toLowerCase() === 'all') return ['*'];
  if (answer.toLowerCase() === 'none') return [];
  const selected = new Set();
  for (const part of answer.split(',')) {
    const range = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim());
    const start = Number(range?.[1]);
    const end = Number(range?.[2] ?? range?.[1]);
    if (!range || start < 1 || end < start || end > models.length) {
      throw new Error(`Invalid model selection: ${part.trim()}`);
    }
    for (let index = start; index <= end; index++) selected.add(index);
  }
  return [...selected].sort((a, b) => a - b).map(index => models[index - 1].id);
}

async function main() {
  const { values } = parseArgs({ options: { list: { type: 'boolean' } } });
  const { NEW_API_URL, NEW_API_TOKEN, TFA_CONFIG } = process.env;
  if (!NEW_API_URL) throw new Error('Set NEW_API_URL to your New API base URL.');
  if (!NEW_API_TOKEN) throw new Error('Set NEW_API_TOKEN to a New API API key.');
  const response = await fetch(`${NEW_API_URL.replace(/\/+$/, '')}/v1/models`, {
    headers: { authorization: `Bearer ${NEW_API_TOKEN}` },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const { data: models } = await response.json();
  for (const [index, model] of models.entries()) console.log(`${index + 1}  ${model.id}`);
  if (!models.length) console.log('No models available.');
  if (values.list) return;

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    answer = (await readline.question('Select models (1,3-5 / all / none; Enter keeps current): ')).trim();
  } finally {
    readline.close();
  }
  if (!answer) return;
  const selected = selectModels(answer, models);
  const configPath = TFA_CONFIG || fileURLToPath(new URL('../config/config.json', import.meta.url));
  let current = {};
  try {
    current = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const config = normalizeConfig({ ...current, models: selected });
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(`${configPath}.tmp`, JSON.stringify(config, null, 2) + '\n');
  await rename(`${configPath}.tmp`, configPath);
  console.log(`Saved model selection to ${configPath}`);
}

main().catch(error => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
