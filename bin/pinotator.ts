#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createManagerServer } from '../src/server.js';

export interface CliOptions {
  mode: 'global' | 'project';
  cwd: string;
  noOpen: boolean;
  readOnly: boolean;
  port: number;
  doctor: boolean;
  help: boolean;
}

export function parseArgs(argv: string[], cwd = process.cwd()): CliOptions {
  const options: CliOptions = {
    mode: resolve(cwd) === resolve(homedir()) ? 'global' : 'project',
    cwd: resolve(cwd),
    noOpen: false,
    readOnly: false,
    port: 0,
    doctor: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--global') options.mode = 'global';
    else if (arg === '--no-open') options.noOpen = true;
    else if (arg === '--read-only') options.readOnly = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === 'doctor') options.doctor = true;
    else if (arg === '--project') {
      if (!argv[i + 1]) throw new Error('--project requires a directory');
      options.cwd = resolve(argv[++i]);
      options.mode = 'project';
    } else if (arg === '--port') {
      const value = argv[++i];
      if (value == null || !/^\d+$/.test(value) || Number(value) > 65535)
        throw new Error('--port must be an integer from 0 to 65535');
      options.port = Number(value);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.mode === 'global') options.cwd = resolve(homedir());
  return options;
}

const help = `Pinotator — local Pi configuration manager\n\nUsage: pinotator [--global | --project DIR] [--no-open] [--read-only] [--port 0..65535]\n       pinotator doctor\n`;

function openBrowser(url: string) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

async function doctor() {
  const pi = spawn('pi', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let stdout = '',
    stderr = '';
  const timer = setTimeout(() => pi.kill('SIGKILL'), 2500);
  pi.stdout.on('data', (b) => {
    stdout = (stdout + b.toString()).slice(0, 2048);
  });
  pi.stderr.on('data', (b) => {
    stderr = (stderr + b.toString()).slice(0, 2048);
  });
  const code = await new Promise((resolveExit) => {
    pi.once('error', () => resolveExit(null));
    pi.once('close', resolveExit);
  });
  clearTimeout(timer);
  console.log(`Pi executable: ${code === null ? 'not found' : 'available'}`);
  if (stdout.trim()) console.log(`Pi version: ${stdout.trim()}`);
  if (code !== 0 && stderr.trim())
    console.log(`Diagnostic: ${stderr.trim().replace(/[\r\n]+/g, ' ')}`);
}

export async function main(argv: string[] = process.argv.slice(2)) {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(help);
    return;
  }
  if (options.doctor) {
    await doctor();
    return;
  }
  const cwdStat = await import('node:fs/promises').then((fs) =>
    fs.stat(options.cwd).catch(() => null),
  );
  if (!cwdStat?.isDirectory()) {
    console.error(`Working directory is not accessible: ${options.cwd}`);
    process.exitCode = 2;
    return;
  }
  options.cwd = await realpath(options.cwd);
  const server = createManagerServer({
    context: {
      cwd: options.cwd,
      home: homedir(),
      mode: options.mode,
      readOnly: options.readOnly,
      agentDirectory: process.env.PI_CODING_AGENT_DIR || resolve(homedir(), '.pi/agent'),
    },
    port: options.port,
  });
  await server.listen();
  const url = server.bootstrapUrl;
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.log(
    `Pinotator\n  Working directory: ${options.cwd}\n  Pi agent directory: ${process.env.PI_CODING_AGENT_DIR || resolve(homedir(), '.pi/agent')}\n  Mode: ${options.mode}${options.readOnly ? ' (read-only)' : ''}\n  Local URL: ${url}\n  To stop: Ctrl+C`,
  );
  if (!options.noOpen && process.env.SSH_CONNECTION == null) openBrowser(url);
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  main().catch((error) => {
    console.error(`Pinotator failed to start: ${error.message}`);
    process.exitCode = 1;
  });
}
