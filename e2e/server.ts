import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A long source address, so the phone layout test proves that long addresses wrap whatever the fonts are.
const LONG_SOURCE_URL = 'https://github.com/anexampleorganizationwithalongname/workspacemcpforkwithalongname';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export interface RunningServer {
  base: string;
  setupCode: string;
  dataDir: string;
  githubToken: string;
  stop(): Promise<void>;
}

const E2E_GITHUB_TOKEN = 'e2e-github-token';

/** A local stand-in for the GitHub REST API, so the GitHub screen can be used without the public API. */
function startFakeGithub(): Promise<{ url: string; stop(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${E2E_GITHUB_TOKEN}`;
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const p = url.pathname;
    let status = 404;
    let body: unknown = { message: 'Not Found' };
    if (!ok) {
      status = 401;
      body = { message: 'Bad credentials' };
    } else if (p === '/user') {
      status = 200;
      body = { login: 'octo-e2e' };
    } else if (p === '/user/repos') {
      status = 200;
      body = [{ full_name: 'example/site', private: false, has_issues: true }];
    } else if (p === '/repos/example/site/issues') {
      status = 200;
      body = [
        {
          number: 7,
          title: 'Seeded issue',
          body: '',
          state: 'open',
          html_url: 'https://github.test/example/site/issues/7',
          user: { login: 'a' },
          labels: [],
          created_at: '2026-11-01T00:00:00Z',
          updated_at: '2026-11-01T00:00:00Z',
          closed_at: null,
        },
      ];
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        stop: () =>
          new Promise((r, j) => {
            server.close((e) => (e ? j(e) : r()));
          }),
      });
    });
    server.on('error', reject);
  });
}

/** Starts `node src/main.ts` on a free port with a fresh data directory and waits for the setup code. */
export async function startServer(): Promise<RunningServer> {
  if (!fs.existsSync(path.join(root, 'dist/ui/index.html'))) throw new Error('Build the interface first: npm run build:ui');
  const github = await startFakeGithub();
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-e2e-'));
  const child: ChildProcess = spawn(process.execPath, ['src/main.ts'], {
    cwd: root,
    env: { ...process.env, PUBLIC_URL: base, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, SECRET_KEY: randomBytes(32).toString('base64'), LOG_LEVEL: 'warn', BACKUP_INTERVAL_HOURS: '0', GITHUB_SYNC_INTERVAL_MINUTES: '0', GITHUB_API_URL: github.url, SOURCE_URL: LONG_SOURCE_URL },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  const setupCode = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`server did not print a setup code:\n${out}`)), 20_000);
    const check = () => {
      const m = /enter this one-time code:\s+(\S+)/.exec(out);
      if (m) {
        clearTimeout(deadline);
        resolve(m[1]!);
      }
    };
    child.stdout!.on('data', check);
    child.on('exit', (code) => reject(new Error(`server exited (${code}):\n${out}`)));
  });
  // Wait until it answers.
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    base,
    setupCode,
    dataDir,
    githubToken: E2E_GITHUB_TOKEN,
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((r) => child.once('exit', r));
      }
      await github.stop().catch(() => undefined);
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
