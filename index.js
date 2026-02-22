#! /usr/bin/env node
import fs from 'fs';
import os from 'os';
import ora from 'ora';
import path from 'path';
import request from 'request-promise';
import chalk from 'chalk';
import readline from 'readline';
import ShellJS from 'shelljs';

const PATH_TO_API_KEY_FILE = path.join(os.homedir(), '.x');

const args = process.argv.slice(2);
const query = args.join(' ');

function getApiKey() {
  if (!!process.env.OPENAI_TOKEN) {
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

async function getSuggestion(prompt) {
  const response = await request({
    url: 'https://api.openai.com/v1/engines/davinci-codex/completions',
    method: 'POST',
    json: true,
    headers: {
      'Authorization': `Bearer ${getApiKey()}`,
    },
    body: {
      prompt,
      temperature: 0,
      max_tokens: 300,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      stop: ['#']
    },
  });

  if (!response || !response.choices || !response.choices.length) {
    throw new Error('No suggestion found');
  }

  const suggestion = response.choices[0].text.trim().replace(/^!/, '');
  if (!suggestion) {
    throw new Error('No suggestion found');
  }

  return suggestion;
}

async function suggest() {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', (_chunk, key) => {
    if (key.ctrl && key.name === 'c') {
      process.exit();
    }
  });

  let prompt = `# Bash\n# ${query}\n`;
  let attempt = 0;
  const spinner = ora(query).start();
  try {
    while (true) {
      const suggestion = await getSuggestion(prompt);

      spinner.color = 'green';
      spinner.text = `${chalk.bold(suggestion)}\n\nenter → run command\nspace → new suggestion`;
      spinner.spinner = { frames: ['$'] };

      const shouldExecuteCommand = await new Promise((resolve) => {
        function listener(_chunk, key) {
          switch (key.name) {
            case 'return':
              process.stdin.removeListener('keypress', listener);
              resolve(true);
              break;
            case 'space':
              process.stdin.removeListener('keypress', listener);
              resolve(false);
              break;
          }
        }

        process.stdin.on('keypress', listener);
      });

      if (shouldExecuteCommand) {
        spinner.stop();
        console.log(chalk.green('$ ') + chalk.bold(suggestion));

        ShellJS.exec(suggestion, {async: true});
      } else {
        attempt++;
        if (attempt === 3) break;
        spinner.color = 'cyan';
        spinner.text = query;
        spinner.spinner = 'dots';
        prompt += `${suggestion}\n\n# Same command, but differently formatted\n`;
      }
    }

    throw new Error('No suggestion found');
  } catch (error) {
    spinner.fail(error.toString());
  }
}

if (!query) {
  console.log('Use like:');
  console.log(chalk.green('$ ') + chalk.bold('x list s3 buckets'));
} else if (query === 'init') {
  await fetchAndStoreApiKey();
} else {
  if (!getApiKey()) {
    console.log('No API key found. Run `x init` or set OPENAI_TOKEN.');
    process.exit(1);
  }
  await suggest();
}
