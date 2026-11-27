import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isHighest, parseVersion, previousRelease, releaseNotes } from '../scripts/release-version.ts';

const SCRIPT = fileURLToPath(new URL('../scripts/release-version.ts', import.meta.url));

function run(args: string[], input = '') {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const CHANGELOG = `# Changelog

## [Unreleased]

- Something not released yet.

## [0.2.0] - 2027-01-10

### Fixed

- Second fix.

## [0.1.0] - 2026-12-01

### Added

- First release.

[0.2.0]: https://example.com/compare/v0.1.0...v0.2.0
[0.1.0]: https://example.com/releases/tag/v0.1.0
`;

describe('release versions', () => {
  it('accepts only plain X.Y.Z versions', () => {
    assert.deepEqual(parseVersion('v1.20.3'), [1, 20, 3]);
    assert.deepEqual(parseVersion('0.1.0'), [0, 1, 0]);
    assert.equal(parseVersion('v1.2.3-rc.1'), null);
    assert.equal(parseVersion('v1.2'), null);
    assert.equal(run(['check', 'v0.1.0']).code, 0);
    assert.equal(run(['check', '0.1.0']).code, 1, 'the tag needs the v prefix');
    assert.equal(run(['check', 'v0.1.0-rc.1']).code, 1);
  });

  it('picks the highest release not newer than the version as the upgrade start', () => {
    const tags = ['v0.1.0', 'v0.10.0', 'v0.2.0', 'v0.2.1', 'v1.0.0-rc.1', 'nightly'];
    assert.equal(previousRelease('0.3.0', tags), 'v0.2.1');
    assert.equal(previousRelease('0.2.1', tags), 'v0.2.1', 'an already released version upgrades from itself');
    assert.equal(previousRelease('v0.2.2', tags), 'v0.2.1', 'a patch for an older line starts from that line');
    assert.equal(previousRelease('0.11.0', tags), 'v0.10.0', 'numeric, not text, order');
    assert.equal(previousRelease('0.1.0', []), null, 'the first release has nothing to upgrade from');
    assert.equal(run(['previous', '0.3.0'], tags.join('\n') + '\n').out, 'v0.2.1\n');
    assert.equal(run(['previous', '0.1.0'], '').out, '');
  });

  it('moves latest only for the highest version', () => {
    const tags = ['v0.1.0', 'v0.2.0'];
    assert.equal(isHighest('0.3.0', tags), true);
    assert.equal(isHighest('0.1.1', tags), false, 'a patch for an older line keeps latest where it is');
    assert.equal(isHighest('0.1.0', []), true, 'the first release is latest');
    assert.equal(isHighest('v0.10.0', ['v0.9.9']), true);
    assert.equal(run(['is-highest', '0.1.1'], tags.join('\n')).out, 'false\n');
  });

  it('takes release notes from the CHANGELOG section of the version', () => {
    assert.equal(releaseNotes('0.2.0', CHANGELOG), '### Fixed\n\n- Second fix.');
    assert.equal(releaseNotes('v0.1.0', CHANGELOG), '### Added\n\n- First release.', 'link definitions are left out');
    assert.equal(releaseNotes('0.3.0', CHANGELOG), null);
    assert.equal(releaseNotes('0.1.0', '## [0.1.0]\n\n## [0.0.9]\n- old\n'), null, 'an empty section is not notes');
    assert.equal(releaseNotes('0.1.0', '## [0.1.00] - x\n- no\n'), null, 'the version must match exactly');
    const missing = run(['notes', '0.6.0', fileURLToPath(new URL('../CHANGELOG.md', import.meta.url))]);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /no non-empty section/);
  });
});
