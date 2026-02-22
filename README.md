
# `x` - convert natural language to bash commands

This is a CLI tool to convert natural language to bash commands. Under the hood, it uses the OpenAI Responses API (default model: `gpt-5-mini`) to create suggestions.

![X Preview](https://github.com/davidfant/terminal-x/blob/master/assets/preview.gif)

## Installation
```bash
$ git clone https://github.com/davidfant/terminal-x.git
$ cd terminal-x
$ npm install
$ npm link
$ x init
```

`x init` prompts you to enter your own OpenAI API key and stores it at `~/.x`.

Authentication precedence:
1. `OPENAI_API_KEY`
2. `OPENAI_TOKEN` (legacy compatibility)
3. `~/.x` (created by `x init`)

## Examples
```bash
$ x list s3 buckets
$ x push current git branch
$ x show gcloud accounts
$ x change gcloud account to your@gmail.com
```
