# 贡献与维护指南

这份文件面向**改代码和发版本的人**（维护者、fork 的人、提 PR 的人）。
只是装插件用的人不需要读这里，看 [README.zh.md](README.zh.md) / [README.md](README.md) 就够。

---

## 代码结构

| 文件 | 职责 |
|---|---|
| `src/index.js` | 宿主入口：解析 config、装配各面、`inject` 声明依赖、返回卸载 disposer |
| `src/sqlite.js` | `node:sqlite` 封装：连接句柄表、语句分类、安全闸、行/字节上限、结果整形 |
| `src/connections.js` | 连接注册表（落盘 JSON，按 mtime 自动重读） |
| `src/api.js` | **应用操作层**：面板与 Agent 工具共用同一份方法 |
| `src/tools.js` | Agent 工具 `db` 的定义与 dispatch（`action` 参数） |
| `src/routes.js` | HTTP 面 `POST /dsh-db/api/<method>`、错误码→状态码映射、回环校验 |
| `src/backend.js` | storage hub 的 `sqlite` 后端（`KvFacet` / `KvUnit` 契约） |
| `client.js` | Web 面板（手写 plain JS，经 `window.__ModuleLoader__.load` 自注册） |
| `test/selftest.mjs` | 29 组断言，不依赖 DSH 宿主 |
| `test/seed-demo.mjs` | 造演示库 |

## 改代码要守的四条约定

1. **不 import 任何 `@deepseek-ai/*` 包。** 宿主能力一律经 `ctx` 取（`ctx.tools`、`ctx.webServer`、`ctx.storage`）。第三方 bundle 装在 profile 的 `node_modules` 里，直接 import 宿主包会在别人机器上 `ERR_MODULE_NOT_FOUND`。`src/backend.js` 里的 `StorageError` / `UNIT_NAME_RE` / `storageBackendServiceKey` 是**故意复刻**的，不是偷懒。
2. **一个操作只写一份。** 面板按钮和 Agent 工具都调 `src/api.js` 的同一个方法。要区分权限就按调用方传 `caller`（例：`connectionsAdd` 的 `allowAddConnection` 只约束 Agent，不约束面板），别复制出两套逻辑。
3. **错误带稳定 `code`。** 抛 `DbError(code, message)`；新 code 要同步进 `src/routes.js` 的 `STATUS_BY_CODE`，否则 HTTP 面会退化成 500。
4. **面板只用宿主 theme token**（`--dsw-alias-*` / `--dsw-specific-*`），控件自己写。不要 iframe 嵌宿主出的 HTML 页，不要 `require` 宿主的 UI 包，不要往 `document.body` 挂东西。

## 本地开发

```bash
npm run check    # 逐文件语法检查（没有构建步骤，源码就是产物）
npm test         # 29 组断言：语句分类、安全闸、schema、网格、写操作、导出、storage 契约、调用方权限
npm run seed     # 造一个 playground.db，面板和工具立刻有东西可看
```

改完 `src/*.js` 要**重启 DSH** 才生效（宿主模块只在启动时加载一次；禁用/启用插件不会重新 apply）。改 `client.js` 需要刷新页面。

## 发布流程

版本号写在 `package.json`，遵循语义化版本；`CHANGELOG.md` 每个版本补一段。

打 tag 会触发 `.github/workflows/publish.yml`：

```bash
npm version patch          # 或 minor / major，会自己改 package.json 并打 tag
git push origin master --follow-tags
```

workflow 会先跑 `npm run check` + `npm test`，再校验 `package.json` 版本与 tag 一致，然后 `npm publish --provenance --access public`，最后建 GitHub Release。

### 一次性配置（只做一次）

1. **npm 账号 + 两步验证**：https://www.npmjs.com/signup → Settings → Account → Two-Factor Authentication。npm 要求开 2FA 才能发布 `@406464` 这个 scope。
2. **仓库 secret**：npm → Access Tokens → Generate Token → 类型选 **Automation**，复制那串 `npm_...`；GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret，名字必须是 `NPM_TOKEN`。
3. **（推荐）Trusted Publisher**：npm 包页 → Publishing → Trusted Publisher，指向本仓库 + `publish.yml`。这样 `--provenance` 能签出可验证来源，装的人看得到 Provenance 标记。

没配 `NPM_TOKEN` 时 workflow 会**跳过发布并以成功结束**，不会把 tag 标红——这是刻意的，方便先发 GitHub 再补 npm。

补好配置后要重新触发发布，两种办法：Actions → Publish → Re-run jobs；或者删 tag 重推：

```bash
git tag -d v0.1.0 && git push origin :refs/tags/v0.1.0 && git push origin v0.1.0
```

### 别做的事

- 不要把 token 提交进仓库、写进 `cordis.patch.yml`、或贴进任何聊天窗口。
- 不要把真实用户数据库放进仓库当 fixture；测试用临时目录现建（见 `test/selftest.mjs`）。
- 不要 force-push `master`。tag 可以重打，分支历史不要改写。

## 提 PR

改 `src/` 或 `client.js` 的 PR 请带上：为什么改、怎么复现、`npm test` 是否通过。
新增 `action` 或 HTTP 方法时，同步更新 `README` 的工具/配置表和 `CHANGELOG`。
