# Backups, restore, export and import

The whole workspace lives in one SQLite database, `DATA_DIR/workspace.sqlite` (`/data/workspace.sqlite` in the container). There are two ways to keep a copy:

- **Backups** are complete, consistent copies of the database, for disaster recovery on the same instance.
- **Exports** are an open, versioned format (Markdown plus JSON) for moving to another instance, reading in any editor, or keeping an independent archive.

Neither contains `SECRET_KEY`. Keep a copy of it separately: a restored backup on a new machine needs the same key, or the owner is signed out and the stored GitHub token and webhook secrets become unreadable.

## Backups

A backup is made with SQLite's own online backup API, never by copying the live file, so it is consistent even while the service is writing.

| When | Reason in the file name | Kept |
| --- | --- | --- |
| Every `BACKUP_INTERVAL_HOURS` (default 24), and at start when `DATA_DIR/backups/` holds no backup yet | `scheduled` | the newest `BACKUP_KEEP` (default 14) scheduled and manual backups |
| **Back up now** in the web interface, or `cli backup` | `manual` | as above |
| Before a migration of a database that holds data | `pre-migration` | the newest 3 `pre-migration` backups, separately from the rotation |
| Before a restore | `pre-restore` | the newest 3 `pre-restore` backups, separately from the rotation |
| Before an import | `pre-import` | the newest 3 `pre-import` backups, separately from the rotation |

Files are named `workspace-<UTC timestamp>-<reason>.sqlite` and live in `DATA_DIR/backups/`. The web interface (**More → Export and backups**) lists them and lets you download each one.

Backups on the same disk do not protect against losing the disk. Copy them off the machine regularly:

```sh
# With Docker Compose, from the directory with compose.yaml
docker compose cp workspace:/data/backups ./backups-copy
```

### Checking a backup

```sh
docker compose stop workspace
docker compose run --rm workspace cli verify /data/backups/<file>.sqlite
docker compose start workspace
```

`verify` runs SQLite's integrity check and confirms the file is a workspace database.

### Restoring a backup

Restore replaces the database, so it runs with the service stopped. The current database is saved first as a `pre-restore` backup, so a restore can itself be undone.

```sh
docker compose stop workspace
docker compose run --rm workspace cli backups                    # list names
docker compose run --rm workspace cli restore <name>             # e.g. workspace-20261125T100000000Z-scheduled.sqlite
docker compose up -d workspace
docker compose logs --tail 20 workspace                          # expect a "listening" line
```

To restore a file from elsewhere, copy it into the volume first and pass its path:

```sh
docker compose cp ./my-backup.sqlite workspace:/data/restore-source.sqlite
docker compose run --rm workspace cli restore /data/restore-source.sqlite
```

A restore refuses files that fail the integrity check. If the backup comes from an older release, the service applies the newer migrations when it starts (after making a `pre-migration` backup).

Every offline command (`backup`, `restore`, `verify`, `export`, `import`, `setup-code`, `recovery-code`) needs the service stopped. While it runs, they print `The database is in use. Stop the service first…` and change nothing.

### Undoing an upgrade

A release that changes the database schema makes a `pre-migration` backup before it migrates. An older release refuses to open a database that a newer release has migrated, and says so, rather than risk damaging it. To go back:

1. Stop the service and switch back to the previous release (see [Updating and rolling back](deployment.md#updating-and-rolling-back)).
2. Restore the newest `pre-migration` backup with `cli restore`.
3. Start the service.

Changes made after the upgrade are in the `pre-restore` backup that the restore creates; they are not lost, but they are not merged back automatically. The newest 3 `pre-restore` backups are kept outside the `BACKUP_KEEP` rotation, so newer scheduled backups do not remove it.

## Export

An export is a zip file:

```text
manifest.json          format id and version, app version, export time, SHA-256 of every other file, row counts
workspace.json         every workspace table: structure, links, the full version history and the log
README.md              what the files are
rules.md               the current working rules
roles/<slug>.md        each role with its instruction
projects/<slug>.md     each project with its description, focus and state
documents/<scope>/…md  each document (scope: workspace, or the project or role it belongs to)
tasks/<title>-<id>.md  each task with its fields, comments and result
```

The Markdown files have YAML front matter with ids, links and times, so the folder opens in Obsidian or any editor. `workspace.json` is the complete data and is what import reads.

An export never contains secrets or live access: no OAuth clients, tokens, sessions or passkeys, no webhook URLs or secrets, and no GitHub token (`github_config`). The local GitHub mirror (`github_repo`, including `default_role_id`; `github_repo_assigner`; and `github_issue`, including the role label) is included so those settings and labels survive a move.

Make an export in the web interface (**Download export**) or offline:

```sh
docker compose stop workspace
docker compose run --rm workspace cli export /data/workspace-export.zip
docker compose start workspace
docker compose cp workspace:/data/workspace-export.zip ./
```

Check an export without importing it:

```sh
docker compose run --rm workspace cli check-export /data/workspace-export.zip
```

## Import

Import goes into an **empty** workspace only (no roles, projects, documents, tasks, working rules, or a GitHub mirror), so it can never mix two workspaces. It verifies the checksums in the manifest, refuses a format version newer than it knows, and makes a `pre-import` backup first. The search index is rebuilt from the imported current state, including mirrored GitHub issues: a later incremental sync would not reindex issues it skips as unchanged.

- In the web interface: on **More → Export and backups**, **Import** appears while the workspace is empty. Upload the zip (up to 100 MB).
- Offline: copy the zip into the volume, then `cli import`:

```sh
docker compose cp ./workspace-export.zip workspace:/data/import.zip
docker compose stop workspace
docker compose run --rm workspace cli import /data/import.zip
docker compose start workspace
```

After an import, connect the AI platforms again and, if you use them, reconnect GitHub (the token does not travel in an export; selected repositories, default roles, assigners and issue labels do, and imported issues are already in the search index) and recreate webhooks.

## Moving to another machine

Either way works:

- **Same data, same address:** restore a backup on the new machine with the same `PUBLIC_URL` and `SECRET_KEY`. Connections, passkeys and secrets keep working.
- **Fresh instance:** export on the old machine, set up the new one with its own `PUBLIC_URL` and `SECRET_KEY`, register the owner passkey, then import. Platforms connect again.
