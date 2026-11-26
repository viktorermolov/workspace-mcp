/**
 * Version helpers for the release pipeline (used by .github/workflows/release.yml and ci.yml).
 *
 *   node scripts/release-version.ts check <tag>               exits 1 unless <tag> is vX.Y.Z
 *   node scripts/release-version.ts previous <version>        highest released version <= <version>, or nothing
 *   node scripts/release-version.ts is-highest <version>      "true" when <version> is above every released one
 *   node scripts/release-version.ts notes <version> [file]    the CHANGELOG section of <version>; exits 1 if missing
 *
 * `previous` and `is-highest` read the released versions (tags such as v0.1.0) from stdin, one per line.
 * Only plain X.Y.Z versions are releases; anything else in the input is ignored.
 */
import fs from 'node:fs';

export type Version = [number, number, number];

const PLAIN = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(s: string): Version | null {
  const m = PLAIN.exec(s.trim());
  if (!m) return null;
  const v = m.slice(1).map(Number) as Version;
  return v.every(Number.isSafeInteger) ? v : null;
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

const format = (v: Version) => `v${v.join('.')}`;

function released(list: string[]): Version[] {
  return list.map(parseVersion).filter((v): v is Version => v !== null);
}

/** The highest released version that is not newer than `version`: the one an upgrade to `version` starts from. */
export function previousRelease(version: string, releasedTags: string[]): string | null {
  const target = parseVersion(version);
  if (!target) throw new Error(`not a release version: ${version}`);
  const older = released(releasedTags).filter((v) => compareVersions(v, target) <= 0);
  older.sort(compareVersions);
  const last = older.at(-1);
  return last ? format(last) : null;
}

/** True when `version` is at least every released version, so it may carry the `latest` tag. */
export function isHighest(version: string, releasedTags: string[]): boolean {
  const target = parseVersion(version);
  if (!target) throw new Error(`not a release version: ${version}`);
  return released(releasedTags).every((v) => compareVersions(target, v) >= 0);
}

/** The body of the `## [X.Y.Z]` section of a Keep a Changelog file, without link definitions. */
export function releaseNotes(version: string, changelog: string): string | null {
  const v = parseVersion(version);
  if (!v) throw new Error(`not a release version: ${version}`);
  const heading = new RegExp(`^## \\[${v.join('\\.')}\\](\\s|$)`);
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  const body = (end < 0 ? rest : rest.slice(0, end))
    .filter((l) => !/^\[[^\]]+\]:\s*\S+\s*$/.test(l))
    .join('\n')
    .trim();
  return body || null;
}

function stdinLines(): string[] {
  return fs.readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean);
}

function main(argv: string[]): number {
  const [cmd, arg, file] = argv;
  const fail = (msg: string) => (process.stderr.write(msg + '\n'), 1);
  if (!arg) return fail('usage: release-version.ts check|previous|is-highest|notes <version> [file]');
  switch (cmd) {
    case 'check':
      return /^v\d+\.\d+\.\d+$/.test(arg) && parseVersion(arg) ? 0 : fail(`${arg} is not a release tag of the form vX.Y.Z`);
    case 'previous': {
      const p = previousRelease(arg, stdinLines());
      if (p) process.stdout.write(p + '\n');
      return 0;
    }
    case 'is-highest':
      process.stdout.write(String(isHighest(arg, stdinLines())) + '\n');
      return 0;
    case 'notes': {
      const notes = releaseNotes(arg, fs.readFileSync(file ?? 'CHANGELOG.md', 'utf8'));
      if (!notes) return fail(`CHANGELOG has no non-empty section "## [${arg.replace(/^v/, '')}]"`);
      process.stdout.write(notes + '\n');
      return 0;
    }
    default:
      return fail(`unknown command: ${cmd}`);
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
