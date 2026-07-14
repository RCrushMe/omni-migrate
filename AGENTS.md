# AGENTS.md — omni-migrate

## What This Repo Does

`omni-migrate.mjs` exports and imports OmniRoute SQLite databases across installs.
Works for both **npm CLI** (`omniroute serve`) and **Electron** desktop app.

Cross-platform: Windows, Linux, macOS.

---

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

---

## ⚠️ Backup First

**Before any migration or import/export operation, copy all database files to a safe location outside the OmniRoute install directory.**

OmniRoute uninstallers (and the `delete` command) remove the **entire data directory** including:

- `storage.sqlite`
- `storage.sqlite-wal`
- `storage.sqlite-shm`
- `migrate-export/` folder with your JSON/SQL dumps

```bash
# Example backup (adjust paths for your OS)
# Windows:
copy "%APPDATA%\omniroute\storage.sqlite" "D:\backups\omniroute\storage.sqlite.bak"
copy "%APPDATA%\omniroute\storage.sqlite-wal" "D:\backups\omniroute\storage.sqlite-wal.bak"
copy "%APPDATA%\omniroute\storage.sqlite-shm" "D:\backups\omniroute\storage.sqlite-shm.bak"
xcopy "%APPDATA%\omniroute\migrate-export" "D:\backups\omniroute\migrate-export\" /E /I

# Linux:
mkdir -p ~/backups/omniroute
cp ~/.omniroute/storage.sqlite ~/backups/omniroute/
cp ~/.omniroute/storage.sqlite-wal ~/backups/omniroute/
cp ~/.omniroute/storage.sqlite-shm ~/backups/omniroute/
cp -r ~/.omniroute/migrate-export ~/backups/omniroute/
```

**Rule:** Never keep the only copy of your database inside `~/.omniroute/` or `%APPDATA%\omniroute\`.

---

## Environment Detection

### Check Node.js version

```bash
node --version
# Must be >= 22 for node:sqlite support
```

### Check OmniRoute version

```bash
# npm CLI
omniroute --version

# Electron — check package.json
cat "%LOCALAPPDATA%\Programs\OmniRoute\resources\app\package.json" | grep version
# Linux:
cat ~/.local/share/omniroute/resources/app/package.json | grep version
```

### Detect database paths

```bash
node --experimental-sqlite omni-migrate.mjs detect
```

Or manually check:

| Install | Windows | Linux |
|---------|---------|-------|
| npm CLI | `%USERPROFILE%\.omniroute\storage.sqlite` | `~/.omniroute/storage.sqlite` |
| Electron | `%APPDATA%\omniroute\storage.sqlite` | `~/.config/omniroute/storage.sqlite` |

### Check database file info

```bash
# File size (large DB may trigger #7132)
ls -la "%APPDATA%\omniroute\storage.sqlite"

# Or on Linux
ls -la ~/.omniroute/storage.sqlite
```

---

## Process Management

### Check if OmniRoute/Electron is running

```bash
# Windows
tasklist | findstr OmniRoute

# Linux
ps aux | grep omniroute
```

### Start Electron

```bash
# Windows
start "" "%LOCALAPPDATA%\Programs\OmniRoute\OmniRoute.exe"

# Linux
~/.local/share/omniroute/OmniRoute &
```

### Stop Electron

```bash
# Windows — generate command for user (force kill)
# taskkill /F /IM OmniRoute.exe

# Linux — generate command for user
# killall OmniRoute
```

### Start npm CLI server

```bash
omniroute serve --port 20128 --no-open --daemon
```

### Stop npm CLI server

```bash
omniroute stop
```

---

## Directory Structure

### npm CLI data directory

```
~/.omniroute/
├── storage.sqlite          # Main database
├── storage.sqlite-wal      # WAL journal (if in WAL mode)
├── storage.sqlite-shm      # Shared memory file
├── migrate-export/         # Export files (created by omni-migrate)
│   ├── omniroute-migrate-*.json
│   └── omniroute-migrate-*.sql
└── logs/
    └── omniroute.log
```

### Electron data directory

```
%APPDATA%\omniroute\        # Windows
~/.config/omniroute/        # Linux
├── storage.sqlite
├── storage.sqlite-wal
├── storage.sqlite-shm
├── server.env              # JWT_SECRET, API_KEY_SECRET, etc.
├── db_backups/             # Auto-created backups
└── logs\
    └── application\
        └── app.log         # Application logs
```

### Electron installation directory

```
%LOCALAPPDATA%\Programs\OmniRoute\    # Windows
~/.local/share/omniroute/             # Linux
├── OmniRoute.exe                     # Electron binary
└── resources\
    └── app\
        ├── node_modules\
        │   └── better-sqlite3\       # Original binary (Electron ABI)
        │       └── build\Release\better_sqlite3.node
        └── .build\
            └── next\
                ├── server\chunks\    # Standalone Next.js bundle
                └── node_modules\
                    └── better-sqlite3-*\  # Bundled binary (system ABI — may be wrong!)
                        └── build\Release\better_sqlite3.node
```

---

## Database Operations

### Read database schema (safe, read-only)

```bash
node --experimental-sqlite -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('PATH_TO_DB', { open: true, readOnly: true });
const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all();
for (const { name } of tables) {
  const count = db.prepare('SELECT count(*) as c FROM \"' + name + '\"').get().c;
  if (count > 0) console.log(name + ': ' + count + ' rows');
}
db.close();
"
```

### Compare two databases (safe, read-only)

```bash
node --experimental-sqlite -e "
const { DatabaseSync } = require('node:sqlite');
const src = new DatabaseSync('SOURCE_DB', { open: true, readOnly: true });
const tgt = new DatabaseSync('TARGET_DB', { open: true, readOnly: true });
const tables = src.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all();
for (const { name } of tables) {
  try {
    const sc = src.prepare('SELECT count(*) as c FROM \"' + name + '\"').get().c;
    const tc = tgt.prepare('SELECT count(*) as c FROM \"' + name + '\"').get().c;
    const mark = sc === tc ? '✅' : '❌';
    console.log(mark + ' ' + name + ': ' + sc + ' → ' + tc);
  } catch(e) {
    console.log('❌ ' + name + ': not in target');
  }
}
src.close(); tgt.close();
"
```

---

## WAL/SHM Cleanup & Cold Restart Test

### Why clean WAL/SHM?

SQLite uses WAL (Write-Ahead Logging) mode for concurrent reads. When the app is force-killed, WAL/SHM files may contain uncommitted data. Cleaning them ensures a clean cold restart test.

### Clean WAL/SHM files

```bash
# Generate command for user — NEVER execute rm directly
# Windows:
# del "%APPDATA%\omniroute\storage.sqlite-wal"
# del "%APPDATA%\omniroute\storage.sqlite-shm"

# Linux:
# rm ~/.omniroute/storage.sqlite-wal
# rm ~/.omniroute/storage.sqlite-shm
```

### Convert WAL to DELETE journal mode

better-sqlite3 in Electron may fail on WAL mode databases. Convert to DELETE mode before importing:

```bash
node --experimental-sqlite -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('PATH_TO_DB', { open: true });
db.exec('PRAGMA journal_mode=DELETE');
db.close();
"
```

### Cold restart test procedure

1. Stop OmniRoute/Electron
2. Clean WAL/SHM files
3. Start OmniRoute/Electron
4. Wait 25-30 seconds for full startup
5. Check logs for errors:

```bash
# Check for "Database closed" errors (should be 0 after #7132 fix)
grep -c "Database closed" "%APPDATA%\omniroute\logs\application\app.log"

# Check ModelSync status (should show "Cycle complete")
grep "ModelSync.*Cycle complete" "%APPDATA%\omniroute\logs\application\app.log"

# Check last log entry
tail -3 "%APPDATA%\omniroute\logs\application\app.log"
```

---

## Migration Flow

### Standard flow

```
1. Export from old DB (read-only, safe)
2. Start app to create schema (creates empty DB)
3. Stop app
4. Import SQL into fresh DB (writes data)
5. Start app — data restored
6. Verify data integrity
7. Cold restart test (clean WAL/SHM → restart → verify)
```

### Commands

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

### Key Options

| Option | Description |
|--------|-------------|
| `--target <npm\|electron>` | Which install to target |
| `--db <path>` | Override database path |
| `--out <dir>` | Export output directory |
| `--file <dir>` | Import file directory |
| `--force` / `-y` | Skip confirmation prompts |

---

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

## Known Limitations

- `sql-import` requires the server/Electron to be **stopped** (DB must not be locked)
- Runtime/log tables are intentionally skipped (usage_history, call_logs, proxy_logs, etc.)
- The tool uses `node:sqlite` (system Node.js), independent of the app's bundled drivers
- After import, the app may modify some data on startup (e.g., model_intelligence sync, key_value defaults)
