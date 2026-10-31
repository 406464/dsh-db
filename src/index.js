/**
 * dsh-db 宿主入口：连接注册表 + node:sqlite 执行核 + Agent 工具 + 面板数据面
 * + storage hub 的 sqlite 后端。
 *
 * 不 import 任何 @deepseek-ai/* 包：宿主服务一律经 ctx 取，避免 profile 侧模块解析失败。
 * @module dsh-db
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DbCore } from './sqlite.js'
import { ConnectionStore } from './connections.js'
import { buildApi } from './api.js'
import { dbToolDef } from './tools.js'
import {
	PLUGIN_ID,
	BodyTooLargeError,
	errorStatus,
	handleApi,
	isLoopbackRequest,
	json,
	readJsonBody,
} from './routes.js'
import { registerSqliteBackend } from './backend.js'

export const name = PLUGIN_ID

/** 硬依赖：工具面 + HTTP 面。storage 后端走 ctx.inject 软挂（缺 storage 时其余功能不受影响）。 */
export const inject = ['tools', 'webServer']

/**
 * 定位当前 profile 目录。宿主进程的 env 里未必有 DSH_PROFILE_DIR，
 * 所以优先从「本模块自己的真实路径」反推挂载点（~/.dsh/profiles/<name>/node_modules/<pkg>）。
 * 反推不到（本地 link 安装会解析到仓库目录）就退回 env，再退回 ~/.dsh —— 绝不猜某个 profile 名。
 */
export function dataRoot() {
	const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || homedir(), '.dsh')
	try {
		const here = fileURLToPath(import.meta.url)
		const mounted = /[\\/]\.dsh[\\/]profiles[\\/]([^\\/]+)[\\/]node_modules[\\/]/i.exec(here)
		if (mounted) return join(dshHome, 'profiles', mounted[1], 'plugin-data', 'dsh-db')
	} catch {
		/* 路径形态不认识：往下走 */
	}
	if (process.env.DSH_PROFILE_DIR) return join(process.env.DSH_PROFILE_DIR, 'plugin-data', 'dsh-db')
	return join(dshHome, 'plugin-data', 'dsh-db')
}

function intOf(value, fallback, min, max) {
	const n = Number(value)
	if (!Number.isFinite(n)) return fallback
	return Math.min(max, Math.max(min, Math.floor(n)))
}

/** 手写配置校验：不声明 Config（不依赖 schemastery），默认值保守。 */
export function resolveConfig(raw = {}) {
	const root = typeof raw.root === 'string' && raw.root ? resolve(raw.root) : dataRoot()
	return {
		root,
		defaultLimit: intOf(raw.defaultLimit, 200, 1, 100_000),
		maxLimit: intOf(raw.maxLimit, 5_000, 1, 1_000_000),
		maxRows: intOf(raw.maxRows, 1_000, 1, 100_000),
		maxBytes: intOf(raw.maxBytes, 262_144, 1_024, 33_554_432),
		agentDefaultLimit: intOf(raw.agentDefaultLimit, 50, 1, 5_000),
		allowWrite: raw.allowWrite === true,
		allowAttach: raw.allowAttach === true,
		allowAddConnection: raw.allowAddConnection === true,
		registerStorageBackend: raw.registerStorageBackend !== false,
		extraDirs: Array.isArray(raw.allowDirs) ? raw.allowDirs.filter((p) => typeof p === 'string' && isAbsolute(p)).map((p) => resolve(p)) : [],
	}
}

/**
 * @param ctx - Cordis 插件上下文。
 * @param rawConfig - cordis.patch.yml 里该行的 config。
 */
export function apply(ctx, rawConfig = {}) {
	const cfg = resolveConfig(rawConfig)
	mkdirSync(cfg.root, { recursive: true, mode: 0o700 })

	const core = new DbCore(cfg)
	const workspaceDirs = new Set()
	const connections = new ConnectionStore({
		file: join(cfg.root, 'connections.json'),
		rootsProvider: () => [cfg.root, ...cfg.extraDirs, ...workspaceDirs],
	})
	const api = buildApi({ core, connections, cfg })

	const disposers = []

	// ── Agent 工具面 ──
	disposers.push(ctx.effect(() => ctx.tools.register(dbToolDef(api)), `${PLUGIN_ID}: db tool`))

	// ── 面板数据面 ──
	const web = ctx.webServer
	disposers.push(ctx.effect(() => web.register({
		kind: 'prefix',
		// 前缀匹配按 `${prefix}/` 判定，注册路径不带尾斜杠
		path: `/${PLUGIN_ID}/api`,
		handler: async (req, res) => {
			if (!isLoopbackRequest(req.headers.host, req.socket.remoteAddress)) {
				json(res, 403, { ok: false, error: { code: 'forbidden', message: '仅限本机回环访问' } })
				return
			}
			if (req.method !== 'POST') {
				json(res, 405, { ok: false, error: { code: 'bad-request', message: '仅 POST' } })
				return
			}
			const method = (req.url ?? '').split('/api/')[1]?.split('?')[0] ?? ''
			let body = {}
			try {
				body = await readJsonBody(req)
			} catch (error) {
				if (error instanceof BodyTooLargeError) {
					json(res, 413, { ok: false, error: { code: 'too-large', message: '请求体超过 4MB' } })
				} else {
					json(res, 400, { ok: false, error: { code: 'bad-json', message: '请求体非法 JSON' } })
				}
				return
			}
			const envelope = await handleApi(api, method, body)
			json(res, envelope.ok ? 200 : errorStatus(envelope), envelope)
		},
	}), `${PLUGIN_ID}: api face`))

	// ── 工作区目录纳入允许根（软依赖：无 workspaceRegistry 时跳过） ──
	ctx.inject(['workspaceRegistry'], (sctx) => {
		sctx.effect(() => {
			const refresh = () => {
				try {
					for (const ws of sctx.workspaceRegistry.list()) {
						if (ws && typeof ws.path === 'string') workspaceDirs.add(resolve(ws.path))
					}
				} catch {
					/* 宿主面变化：允许根保持现状 */
				}
			}
			refresh()
			return refresh
		}, `${PLUGIN_ID}: workspace roots`)
	})

	// ── storage hub 的 sqlite 后端（软依赖） ──
	if (cfg.registerStorageBackend) {
		ctx.inject(['storage'], (sctx) => {
			sctx.effect(() => {
				try {
					return registerSqliteBackend(sctx, cfg.root)
				} catch (error) {
					console.warn(`[dsh-db] storage 后端注册失败（面板与工具不受影响）：${error?.message ?? error}`)
					return () => {}
				}
			}, `${PLUGIN_ID}: storage backend`)
		})
	}

	return () => {
		for (const dispose of disposers) {
			try {
				dispose()
			} catch {
				/* 回收失败不阻断卸载 */
			}
		}
		core.closeAll()
	}
}
