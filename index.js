#! /usr/bin/env node
import fs from 'fs';
import os from 'os';
import ora from 'ora';
import path from 'path';
import chalk from 'chalk';
import readline from 'readline';
import ShellJS from 'shelljs';
import OpenAI from 'openai';

const PATH_TO_API_KEY_FILE = path.join(os.homedir(), '.x');
const FIXED_MODEL = 'gpt-5-mini';
const MAX_ALTERNATIVES = 3;
const SYSTEM_PROMPT = [
  'You convert user requests into one safe shell command.',
  'Respond with exactly one bash command and no explanation.',
  'Do not include markdown, comments, backticks, or a leading "$".',
  'If a command is unsafe or ambiguous, prefer a non-destructive command.',
].join(' ');

const args = process.argv.slice(2);
const query = args.join(' ');

function getApiKey() {
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  if (process.env.OPENAI_TOKEN) {
    return process.env.OPENAI_TOKEN;
  }

  if (fs.existsSync(PATH_TO_API_KEY_FILE)) {
    return fs.readFileSync(PATH_TO_API_KEY_FILE, 'utf8').trim();
  }

  return undefined;
}

async function fetchAndStoreApiKey() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const apiKey = await new Promise((resolve) => {
    rl.question('Enter your OpenAI API key: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  if (!apiKey) {
    throw new Error('No API key provided');
  }

  fs.writeFileSync(PATH_TO_API_KEY_FILE, apiKey, 'utf8');
  console.log('API key saved');
}

function extractOutputText(response) {
  const directText = response?.output_text;
  if (typeof directText === 'string' && directText.trim()) {
    return directText;
  }

  return (response?.output ?? [])
    .flatMap((item) => item?.content ?? [])
    .map((content) => (typeof content?.text === 'string' ? content.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function sanitizeSuggestion(text) {
  let cleaned = (text || '').trim();
  if (!cleaned) {
    return '';
  }

  const fencedMatch = cleaned.match(/```(?:bash|sh)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    cleaned = fencedMatch[1].trim();
  }

  cleaned = cleaned.replace(/^`+|`+$/g, '').trim();
  cleaned = cleaned.replace(/^command:\s*/i, '').trim();
  cleaned = cleaned.replace(/^\$\s*/, '').trim();

  const line = cleaned
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);

  return line ? line.replace(/^\$\s*/, '').trim() : '';
}

function buildPrompt(userQuery, rejectedSuggestions) {
  if (!rejectedSuggestions.length) {
    return userQuery;
  }

  const rejectedText = rejectedSuggestions
    .map((suggestion, idx) => `${idx + 1}. ${suggestion}`)
    .join('\n');

  return [
    `User request: ${userQuery}`,
    'Prior suggestions to avoid:',
    rejectedText,
    'Return a different command that still satisfies the request.',
  ].join('\n\n');
}

function createSuggestionRequest(userQuery, rejectedSuggestions, maxOutputTokens) {
  return {
    model: FIXED_MODEL,
    instructions: SYSTEM_PROMPT,
    input: buildPrompt(userQuery, rejectedSuggestions),
    reasoning: { effort: 'minimal' },
    max_output_tokens: maxOutputTokens,
  };
}

function waitForAction() {
  return new Promise((resolve) => {
    const listener = (_chunk, key) => {
      if (key?.name === 'return') {
        process.stdin.removeListener('keypress', listener);
        resolve(true);
      } else if (key?.name === 'space') {
        process.stdin.removeListener('keypress', listener);
        resolve(false);
      }
    };

    process.stdin.on('keypress', listener);
  });
}

async function getSuggestion(client, userQuery, rejectedSuggestions) {
  let request = createSuggestionRequest(userQuery, rejectedSuggestions, 200);
  let response = await client.responses.create(request);
  let suggestion = sanitizeSuggestion(extractOutputText(response));

  // Some reasoning-capable models can consume output tokens before emitting text.
  if (!suggestion && response?.incomplete_details?.reason === 'max_output_tokens') {
    request = createSuggestionRequest(userQuery, rejectedSuggestions, 500);
    response = await client.responses.create(request);
    suggestion = sanitizeSuggestion(extractOutputText(response));
  }

  if (!suggestion) {
    throw new Error('No suggestion found');
  }

  return suggestion.replace(/^!/, '').trim();
}

async function suggest() {
  const client = new OpenAI({ apiKey: getApiKey() });
  const rejectedSuggestions = [];
  const interactive = Boolean(process.stdin.isTTY && process.stdin.setRawMode);
  let ctrlCPressed = false;
  let keypressListener;
  const spinner = ora(query);
  if (interactive) {
    spinner.start();
  }

  const cleanup = () => {
    if (keypressListener) {
      process.stdin.removeListener('keypress', keypressListener);
      keypressListener = undefined;
    }
    if (interactive) {
      process.stdin.setRawMode(false);
    }
  };

  if (interactive) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    keypressListener = (_chunk, key) => {
      if (key?.ctrl && key.name === 'c') {
        ctrlCPressed = true;
        cleanup();
        process.exit(130);
      }
    };
    process.stdin.on('keypress', keypressListener);
  }

  try {
    for (let attempt = 0; attempt < MAX_ALTERNATIVES; attempt += 1) {
      const suggestion = await getSuggestion(client, query, rejectedSuggestions);

      if (!interactive) {
        console.log(chalk.green('$ ') + chalk.bold(suggestion));
        return;
      }

      spinner.color = 'green';
      spinner.text = `${chalk.bold(suggestion)}\n\nenter → run command\nspace → new suggestion`;
      spinner.spinner = { frames: ['$'] };

      const shouldExecuteCommand = await waitForAction();

      if (shouldExecuteCommand) {
        spinner.stop();
        console.log(chalk.green('$ ') + chalk.bold(suggestion));

        ShellJS.exec(suggestion, {async: true});
        return;
      }

      rejectedSuggestions.push(suggestion);
      spinner.color = 'cyan';
      spinner.text = query;
      spinner.spinner = 'dots';
    }

    throw new Error('No suggestion found');
  } catch (error) {
    const message = error?.message || String(error);
    if (interactive) {
      spinner.fail(message);
    } else {
      console.error(message);
    }
  } finally {
    if (!ctrlCPressed) {
      cleanup();
    }
  }
}

if (!query) {
  console.log('Use like:');
  console.log(chalk.green('$ ') + chalk.bold('x list s3 buckets'));
} else if (query === 'init') {
  await fetchAndStoreApiKey();
} else {
  if (!getApiKey()) {
    console.log('No API key found. Run `x init` or set OPENAI_API_KEY (or OPENAI_TOKEN).');
    process.exit(1);
  }
  await suggest();
}
