# omni-migrate

[**English**](./README.md) | **简体中文**

导出和导入 OmniRoute 数据库，支持 **npm CLI**（`omniroute serve`）和 **Electron** 桌面应用。

跨平台：Windows、Linux、macOS。

## 为什么需要这个工具？

OmniRoute 冷启动 Bug（[#7132](https://github.com/omniroute/omniroute/issues/7132)）导致当 `storage.sqlite` ≥1.6MB 时启动失败，报 `Internal Server Error`。原因是 standalone Next.js 构建中打包的 `better-sqlite3` 原生模块无法加载。本工具可以：

1. **导出**：用系统 Node.js + `node:sqlite` 读取旧数据库（绕过有 Bug 的驱动）
2. **删除**：删除旧数据库
3. **导入**：通过 SQL 直接写入新数据库（无需认证）或通过 REST API 导入

迁移后，后续冷启动不会有问题，因为新数据库由应用自身的 migration 创建。

## 环境要求

- **Node.js ≥ 22**（内置 `node:sqlite`）
- 需要 `--experimental-sqlite` 参数

```bash
node --experimental-sqlite omni-migrate.mjs <命令> [选项]
```

## 快速开始

```bash
# 1. 检测数据库位置
node --experimental-sqlite omni-migrate.mjs detect

# 2. 导出旧数据库
node --experimental-sqlite omni-migrate.mjs export

# 3. 删除旧数据库
node --experimental-sqlite omni-migrate.mjs delete -y

# 4. 启动 OmniRoute/Electron（创建空数据库）

# 5. 停止，导入 SQL，重启
omniroute stop
node --experimental-sqlite omni-migrate.mjs sql-import
omniroute serve
```

或使用一键命令：

```bash
node --experimental-sqlite omni-migrate.mjs migrate --force
```

## ⚠️ 先备份

迁移前，务必将数据库文件复制到 OmniRoute 数据目录之外的安全位置。卸载程序和 `delete` 命令会删除**整个** `~/.omniroute/`（或 `%APPDATA%\omniroute\`）文件夹，包括导出文件。

```bash
# Windows
mkdir D:\backups\omniroute
copy "%APPDATA%\omniroute\storage.sqlite" "D:\backups\omniroute\storage.sqlite.bak"
copy "%APPDATA%\omniroute\storage.sqlite-wal" "D:\backups\omniroute\storage.sqlite-wal.bak"
copy "%APPDATA%\omniroute\storage.sqlite-shm" "D:\backups\omniroute\storage.sqlite-shm.bak"
xcopy "%APPDATA%\omniroute\migrate-export" "D:\backups\omniroute\migrate-export\" /E /I

# Linux
mkdir -p ~/backups/omniroute
cp ~/.omniroute/storage.sqlite ~/backups/omniroute/
cp ~/.omniroute/storage.sqlite-wal ~/backups/omniroute/
cp ~/.omniroute/storage.sqlite-shm ~/backups/omniroute/
cp -r ~/.omniroute/migrate-export ~/backups/omniroute/
```

**原则：永远不要让唯一副本留在 OmniRoute 数据目录内。**

## 命令说明

| 命令 | 说明 | 需要服务器？ |
|------|------|-------------|
| `detect` | 显示检测到的数据库路径 | 不需要 |
| `export` | 读取数据库 → 生成 JSON + SQL 文件 | 不需要 |
| `delete` | 删除旧数据库（含 WAL/SHM 文件） | 必须停止 |
| `sql-import` | 将 SQL 直接写入数据库 | 必须停止 |
| `import` | 通过 REST API 导入 JSON | 必须运行中 |
| `migrate` | 一键引导式迁移 | 自动管理 |

## 选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--target <npm\|electron>` | 指定目标安装方式 | 自动检测 |
| `--db <path>` | 覆盖数据库路径 | 按平台自动定位 |
| `--out <dir>` | 导出目录 | `<数据目录>/migrate-export` |
| `--host <h>` | API 导入时的服务器地址 | `localhost` |
| `--port <p>` | 服务器端口 | `20128` |
| `--file <dir>` | 导入文件目录 | 导出目录 |
| `--force` / `-y` | 跳过确认提示 | 否 |

## 数据库路径

| 安装方式 | Windows | Linux |
|----------|---------|-------|
| npm CLI | `%USERPROFILE%\.omniroute\storage.sqlite` | `~/.omniroute/storage.sqlite` |
| Electron | `%APPDATA%\omniroute\storage.sqlite` | `~/.config/omniroute/storage.sqlite` |

用 `--target electron` 或 `--target npm` 手动指定。

## npm CLI 工作流

```bash
# 导出
node --experimental-sqlite omni-migrate.mjs export --target npm

# 删除
node --experimental-sqlite omni-migrate.mjs delete --target npm -y

# 启动（创建空数据库）
omniroute serve --port 20128 --no-open --daemon

# 等待启动后停止并导入
omniroute stop
node --experimental-sqlite omni-migrate.mjs sql-import --target npm

# 重启
omniroute serve --port 20128 --no-open --daemon
```

## Electron 工作流

```bash
# 从 Electron 数据库导出
node --experimental-sqlite omni-migrate.mjs export --target electron

# 删除旧数据库
node --experimental-sqlite omni-migrate.mjs delete --target electron -y

# 启动 Electron（它会创建空数据库并运行 migrations）
# ...等待仪表板加载...

# 完全关闭 Electron

# 将 SQL 导入新数据库
node --experimental-sqlite omni-migrate.mjs sql-import --target electron

# 再次启动 Electron — 所有数据已恢复
```

## Electron：修复冷启动 bug (#7132)

standalone Next.js bundle 打包的 `better-sqlite3` 二进制文件是为系统 Node.js 编译的，但 Electron 使用自己的 Node ABI。这导致冷启动时报 `Database closed` 错误。

**修复方法**（每次 OmniRoute 更新后执行一次）：

```bash
# Windows
cp "%LOCALAPPDATA%\Programs\OmniRoute\resources\app\node_modules\better-sqlite3\build\Release\better_sqlite3.node" "%LOCALAPPDATA%\Programs\OmniRoute\resources\app\.build\next\node_modules\better-sqlite3-90e2652d1716b047\build\Release\better_sqlite3.node"

# Linux
cp ~/.local/share/omniroute/resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node ~/.local/share/omniroute/resources/app/.build/next/node_modules/better-sqlite3-*/build/Release/better_sqlite3.node
```

源二进制在 `electron-builder` 打包时通过 vcxproj 编译，匹配 Electron 的 `node_module_version`（148）。standalone bundle 中的副本是为系统 Node.js（ABI 137）编译的，会静默失败。

## Schema 自动适配

从不同版本的 OmniRoute 导入时，工具自动检测列不匹配：

- **源中多余的列**（如新版本添加的 `blocked_models`）：导入时自动跳过
- **源中缺少的列**：只导入可用数据，应用在下次启动时填充默认值
- 无需手动编辑 schema — 工具自动适配

## 导出内容

### JSON（旧版备份格式）
兼容 OmniRoute 的 `/api/settings/import-json` 接口：

- `settings` — 所有键值配置
- `providerConnections` — API 密钥、令牌、连接设置
- `providerNodes` — 自定义 provider 端点
- `combos` — 模型组合路由规则
- `apiKeys` — 带权限的访问密钥

### SQL（完整数据库导出）
所有非临时性表的数据，包括：

- JSON 导出中的所有内容
- `model_intelligence` — 模型能力数据
- `compression_combos` — 压缩管道配置
- `quota_groups` — 配额分配设置
- `key_value` — 所有命名空间/键/值设置
- 更多（通常 350+ 行数据）

## 使用 AI Agent 辅助

本仓库包含 `AGENTS.md`，为 AI 编程 Agent 提供详细的安全规则和操作流程。可用于：

- **诊断**数据库损坏、冷启动失败、WAL/SHM 问题
- **运行**安全的数据库操作（只读查询、导出、比对）
- **调试**Electron 二进制 ABI 不匹配、进程锁、schema 不匹配
- **生成**迁移命令并验证结果

### 使用方法

1. 将 AI Agent（Claude、Copilot 等）指向本仓库
2. Agent 自动读取 `AGENTS.md` 获取安全规则和流程
3. 直接提问，例如：
   - "我的 OmniRoute Electron 冷启动为什么崩溃？"
   - "比对 npm 和 Electron 的数据库"
   - "如何安全迁移到全新安装？"
   - "检查 app.log 中的 #7132 错误"

### Agent 可安全执行的操作

| 安全（只读） | 需要你确认 |
|-------------|-----------|
| 导出数据库 | 导入/SQL 写入 |
| 读取 schema 和行数 | 删除数据库 |
| 比对两个数据库 | 停止/启动 Electron |
| 检查日志错误 | WAL/SHM 清理 |

### Agent 会生成但不执行的命令

这些是破坏性操作，Agent 会写出命令由你运行：

```bash
# 删除数据库
del "%APPDATA%\omniroute\storage.sqlite"    # Windows
rm ~/.omniroute/storage.sqlite              # Linux

# 清理 WAL/SHM
del "%APPDATA%\omniroute\storage.sqlite-wal"
del "%APPDATA%\omniroute\storage.sqlite-shm"

# 强制终止 Electron
taskkill /F /IM OmniRoute.exe               # Windows
killall OmniRoute                            # Linux
```

完整安全规则和流程请查看 `AGENTS.md`。

## 限制

- **SQL 导入**要求服务器/Electron **已停止**（数据库不能被锁定）
- **API 导入**需要管理令牌认证 — 推荐使用 sql-import
- 临时性/运行时表（日志、缓存、计数器）不会导出 — 应用会自动重建
- 工具使用系统 Node.js 的 `node:sqlite` 读取数据库，与应用打包的驱动无关

## 常见问题

### "unable to open database file"
数据库被运行中的服务器锁定。先停止 OmniRoute/Electron。

### "EBUSY: resource busy or locked"
同上 — 进程仍在占用文件。停止后等几秒再试。

### "No such built-in module: node:sqlite"
需要 Node.js ≥ 22，并且必须传 `--experimental-sqlite` 参数。

### 导入时 "Authentication required"
API 接口需要管理令牌。改用 `sql-import`（先停止服务器）。
