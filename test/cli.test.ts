import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startService } from './helpers/harness.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function cli(dataDir: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: dataDir,
    env: { PATH: process.env.PATH, PUBLIC_URL: 'https://workspace.example.org', SECRET_KEY: Buffer.alloc(32, 3).toString('base64'), DATA_DIR: dataDir },
    timeout: 30_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('administration CLI', () => {
  it('runs the offline commands on a stopped workspace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsmcp-cli-'));
    const setup = cli(dir, 'setup-code');
    assert.equal(setup.code, 0, setup.err);
    assert.match(setup.out, /https:\/\/workspace\.example\.org\/setup/);
    assert.match(setup.out, /\n {4}\S+/, 'prints the code on its own line');

    const b = cli(dir, 'backup');
    assert.equal(b.code, 0, b.err);
    const file = b.out.trim();
    assert.ok(fs.existsSync(file));
    assert.match(cli(dir, 'backups').out, /manual/);
    assert.match(cli(dir, 'verify', file).out, /^ok/);

    const exp = cli(dir, 'export', path.join(dir, 'out.zip'));
    assert.equal(exp.code, 0, exp.err);
    assert.match(cli(dir, 'check-export', path.join(dir, 'out.zip')).out, /^ok: format v1/);

    const r = cli(dir, 'restore', path.basename(file));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Restored/);
    assert.equal(cli(dir, 'nonsense').code, 1);
  });

  it('refuses to touch the database while the service runs', async () => {
    const env = await startService();
    try {
      const r = cli(env.dataDir, 'backup');
      assert.equal(r.code, 1);
      assert.match(r.err, /in use\. Stop the service first/);
    } finally {
      await env.close();
    }
  });

  it('reports a missing configuration clearly', () => {
    const r = spawnSync(process.execPath, [CLI, 'backups'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PUBLIC_URL|SECRET_KEY/);
  });
});
