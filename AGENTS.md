# AGENTS.md — omni-migrate

## What This Repo Does

`omni-migrate.mjs` exports and imports OmniRoute SQLite databases across installs.
Works for both **npm CLI** (`omniroute serve`) and **Electron** desktop app.

Cross-platform: Windows, Linux, macOS.

## Agent Safety Rules

### NEVER delete or modify the user's database without explicit confirmation

- **NEVER** run `rm`, `del`, `unlink`, or any file deletion command on `storage.sqlite`, `storage.sqlite-wal`, `storage.sqlite-shm`, or any database file unless the user has explicitly confirmed the action in writing.
- **NEVER** run `DELETE FROM` or `DROP TABLE` on any database unless the user has explicitly confirmed the action.
- **NEVER** execute destructive operations silently. Always show the user what will happen and ask for confirmation.
- If you need to perform a destructive operation, **generate the command as text** and explain what it does, then let the user run it themselves.
- The only exception is using the repo's own `omni-migrate.mjs` script with the user's explicit instruction.

### Script execution rules

- Only execute `omni-migrate.mjs` when the user explicitly asks for it.
- Always use `--experimental-sqlite` flag with Node.js: `node --experimental-sqlite omni-migrate.mjs <command>`
- Always specify `--db` and `--file` flags explicitly rather than relying on auto-detection when possible.
- Before running `sql-import`, confirm the target database path with the user.
- Before running `delete`, confirm with the user AND show what will be deleted.

### What to generate vs execute

| Action | Agent should... |
|--------|----------------|
| Read/analyze database | Execute directly (read-only, safe) |
| Export database | Execute directly (read-only, safe) |
| Import database | **Ask user first** — writes to DB |
| Delete database | **Generate command, let user run** |
| Start/stop Electron | Execute only with user's explicit instruction |
| Any `rm`/`del`/`unlink` | **Never execute** — generate command for user |
| Any `DELETE FROM`/`DROP TABLE` | **Never execute** — generate command for user |

### When unsure

Generate the command as text, explain what it does and what the risks are, and let the user decide.

## Commands

All commands require Node.js >= 22 with `--experimental-sqlite`:

```bash
node --experimental-sqlite omni-migrate.mjs <command> [options]
```

| Command | Description | Server needed? |
|---------|-------------|----------------|
| `detect` | Show detected DB paths | No |
| `export` | Read DB → write JSON + SQL | No |
| `delete` | Remove DB (+ WAL/SHM) | Must be stopped |
| `sql-import` | Write SQL into DB | Must be stopped |
| `import` | POST JSON via REST API | Must be running |
| `migrate` | All-in-one guided workflow | Auto-managed |

## Key Options

| Option | Description |
|--------|-------------|
| `--target <npm\|electron>` | Which install to target |
| `--db <path>` | Override database path |
| `--out <dir>` | Export output directory |
| `--file <dir>` | Import file directory |
| `--force` / `-y` | Skip confirmation prompts |

## Database Paths

| Install | Windows | Linux |
|---------|---------|-------|
| npm CLI | `%USERPROFILE%\.omniroute\storage.sqlite` | `~/.omniroute/storage.sqlite` |
| Electron | `%APPDATA%\omniroute\storage.sqlite` | `~/.config/omniroute/storage.sqlite` |

## Schema Auto-Adaptation

The import process automatically handles schema mismatches:
- Extra columns in source → silently dropped
- Missing tables in target → skipped with warning
- Missing columns in source → app fills defaults on next startup
- Foreign keys disabled during import to prevent cascading failures

## Electron Cold-Start Fix (#7132)

The standalone Next.js bundle ships `better-sqlite3` compiled for system Node.js, but Electron uses its own ABI. Fix by copying the correct binary:

```bash
# Windows
cp "%LOCALAPPDATA%\Programs\OmniRoute\resources\app\node_modules\better-sqlite3\build\Release\better_sqlite3.node" "%LOCALAPPDATA%\Programs\OmniRoute\resources\app\.build\next\node_modules\better-sqlite3-90e2652d1716b047\build\Release\better_sqlite3.node"
```

## Typical Migration Flow

```
1. Export from old DB (read-only, safe)
2. Start app to create schema (creates empty DB)
3. Stop app
4. Import SQL into fresh DB (writes data)
5. Start app — data restored
```

## Known Limitations

- `sql-import` requires the server/Electron to be **stopped** (DB must not be locked)
- Runtime/log tables are intentionally skipped (usage_history, call_logs, proxy_logs, etc.)
- The tool uses `node:sqlite` (system Node.js), independent of the app's bundled drivers
- After import, the app may modify some data on startup (e.g., model_intelligence sync, key_value defaults)
