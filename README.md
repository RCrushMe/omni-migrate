# omni-migrate

**English** | [**简体中文**](./README_CN.md)

Export and import OmniRoute databases across installs. Works with both **npm CLI** (`omniroute serve`) and **Electron** desktop app.

Cross-platform: Windows, Linux, macOS.

## Why?

OmniRoute's cold-restart bug ([#7132](https://github.com/omniroute/omniroute/issues/7132)) causes `Internal Server Error` when a `storage.sqlite` ≥1.6MB exists on startup, because the bundled `better-sqlite3` native module fails to load in the standalone Next.js build. This tool lets you:

1. **Export** your old database using system Node.js + `node:sqlite` (bypasses the broken driver)
2. **Delete** the old database
3. **Import** into a fresh install via SQL (no auth needed) or REST API

After migration, subsequent cold starts work because the fresh database is created by the app's own migrations.

## Requirements

- **Node.js ≥ 22** (for built-in `node:sqlite`)
- The `--experimental-sqlite` flag (SQLite support is experimental)

```bash
node --experimental-sqlite omni-migrate.mjs <command> [options]
```

## Quick Start

```bash
# 1. Detect where your databases are
node --experimental-sqlite omni-migrate.mjs detect

# 2. Export old database
node --experimental-sqlite omni-migrate.mjs export

# 3. Delete old database
node --experimental-sqlite omni-migrate.mjs delete -y

# 4. Start OmniRoute/Electron (creates empty DB with migrations)

# 5. Stop it, import SQL, restart
omniroute stop
node --experimental-sqlite omni-migrate.mjs sql-import
omniroute serve
```

Or use the all-in-one command:

```bash
node --experimental-sqlify omni-migrate.mjs migrate --force
```

## Commands

| Command | Description | Server needed? |
|---------|-------------|----------------|
| `detect` | Show detected DB paths for npm CLI and Electron | No |
| `export` | Read DB → write JSON + SQL files | No |
| `delete` | Remove old DB (+ WAL/SHM files) | Must be stopped |
| `sql-import` | Write SQL directly into DB | Must be stopped |
| `import` | POST JSON via REST API | Must be running |
| `migrate` | All-in-one guided workflow | Auto-managed |

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--target <npm\|electron>` | Which install to target | Auto-detected |
| `--db <path>` | Override database path | Platform-dependent |
| `--out <dir>` | Export output directory | `<db-dir>/migrate-export` |
| `--host <h>` | Server host for API import | `localhost` |
| `--port <p>` | Server port | `20128` |
| `--file <dir>` | Import file directory | Export dir |
| `--force` / `-y` | Skip confirmation prompts | No |

## Database Path Detection

| Install | Windows | Linux |
|---------|---------|-------|
| npm CLI | `%USERPROFILE%\.omniroute\storage.sqlite` | `~/.omniroute/storage.sqlite` |
| Electron | `%APPDATA%\omniroute\storage.sqlite` | `~/.config/omniroute/storage.sqlite` |

Use `--target electron` or `--target npm` to override auto-detection.

## npm CLI Workflow

```bash
# Export
node --experimental-sqlite omni-migrate.mjs export --target npm

# Delete
node --experimental-sqlite omni-migrate.mjs delete --target npm -y

# Start fresh (creates empty DB)
omniroute serve --port 20128 --no-open --daemon

# Wait for startup, then stop and import
omniroute stop
node --experimental-sqlite omni-migrate.mjs sql-import --target npm

# Restart
omniroute serve --port 20128 --no-open --daemon
```

## Electron Workflow

```bash
# Export from Electron's database
node --experimental-sqlite omni-migrate.mjs export --target electron

# Delete old database
node --experimental-sqlite omni-migrate.mjs delete --target electron -y

# Start Electron (it creates an empty DB and runs migrations)
# ...wait for dashboard to load...

# Close Electron completely

# Import SQL into the fresh database
node --experimental-sqlite omni-migrate.mjs sql-import --target electron

# Start Electron again — all data is restored
```

## Electron: Fix Cold Restart (#7132)

The standalone Next.js bundle ships a `better-sqlite3` binary compiled for system Node.js, but Electron uses its own Node.js ABI. This causes `Database closed` errors on cold restart.

**Fix** (run once after each OmniRoute update):

```bash
# Windows
cp "%LOCALAPPDATA%\Programs\OmniRoute\resources\app\node_modules\better-sqlite3\build\Release\better_sqlite3.node" "%LOCALAPPDATA%\Programs\OmniRoute\resources\app\.build\next\node_modules\better-sqlite3-90e2652d1716b047\build\Release\better_sqlite3.node"

# Linux
cp ~/.local/share/omniroute/resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node ~/.local/share/omniroute/resources/app/.build/next/node_modules/better-sqlite3-*/build/Release/better_sqlite3.node
```

The source binary is compiled from vcxproj during `electron-builder` packaging and matches Electron's `node_module_version` (148). The standalone bundle's copy was built for system Node.js (ABI 137) and fails silently.

## Schema Auto-Adaptation

When importing from a different OmniRoute version, the tool automatically detects column mismatches:

- **Extra columns in source** (e.g., `blocked_models` added in newer version): silently dropped during import
- **Missing columns in source**: the import uses only what's available; the app fills defaults on next startup
- No manual schema editing needed — the tool adapts automatically

## What Gets Exported

### JSON (legacy backup format)
Compatible with OmniRoute's `/api/settings/import-json` endpoint:

- `settings` — all key-value configuration
- `providerConnections` — API keys, tokens, connection settings
- `providerNodes` — custom provider endpoints
- `combos` — model combination routing rules
- `apiKeys` — access keys with permissions

### SQL (full database dump)
All non-ephemeral tables with data, including:

- Everything in the JSON export
- `model_intelligence` — model capability data
- `compression_combos` — compression pipeline config
- `quota_groups` — quota allocation settings
- `key_value` — all namespace/key/value settings
- And more (350+ rows typically)

## Limitations

- **SQL import** requires the server/Electron to be **stopped** (database must not be locked)
- **API import** requires a management token (auth) — SQL import is recommended instead
- Ephemeral/runtime tables (logs, caches, counters) are not exported — they're recreated by the app
- The tool reads the database with `node:sqlite` (system Node.js), which is independent of the app's bundled drivers

## Troubleshooting

### "unable to open database file"
The database is locked by a running server. Stop OmniRoute/Electron first.

### "EBUSY: resource busy or locked"
Same as above — the process is still holding the file. Wait a few seconds after stopping.

### "No such built-in module: node:sqlite"
You need Node.js ≥ 22 and must pass the `--experimental-sqlite` flag.

### "Authentication required" on import
The API endpoint requires a management token. Use `sql-import` instead (stop the server first).