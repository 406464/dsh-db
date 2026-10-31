/**
 * 应用操作层：面板与 Agent 工具共用同一份实现（一个操作、两个调用方）。
 * 每个方法返回结果对象，失败抛 DbError（带 code）。
 * @module dsh-db/api
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DbError } from './sqlite.js'

export function buildApi({ core, connections, cfg }) {
	function connOf(id) {
		if (!id) throw new DbError('bad-request', '缺少 conn（连接 id）')
		return connections.get(id)
	}

	return {
		info() {
			return {
				limits: {
					defaultLimit: cfg.defaultLimit,
					maxLimit: cfg.maxLimit,
					maxRows: cfg.maxRows,
					maxBytes: cfg.maxBytes,
					agentDefaultLimit: cfg.agentDefaultLimit,
				},
				policy: {
					allowWrite: cfg.allowWrite,
					allowAttach: cfg.allowAttach,
					allowAddConnection: cfg.allowAddConnection,
				},
				roots: [cfg.root, ...cfg.extraDirs],
				storageBackend: 'sqlite',
			}
		},

		connectionsList() {
			return { connections: connections.list() }
		},

		connectionsAdd({ path, label, allowCreate = false }) {
			if (cfg.allowAddConnection !== true) {
				throw new DbError(
					'forbidden',
					'连接登记默认只在面板里做：Agent 侧需先在插件 config 里设 allowAddConnection: true',
				)
			}
			return connections.add({ path, label, allowCreate: allowCreate === true })
		},

		connectionsRemove({ id }) {
			return connections.remove(id)
		},

		schema({ conn, includeCounts = true }) {
			return core.schema({ conn: connOf(conn), includeCounts: includeCounts !== false })
		},

		query({ conn, sql, params = [], limit }) {
			const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : cfg.defaultLimit
			return core.query({ conn: connOf(conn), sql, params: normalizeParams(params), limit: cap })
		},

		/** Agent 面：更小的默认 limit，避免把整表塞进 context。 */
		agentQuery({ conn, sql, params = [], limit }) {
			const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : cfg.agentDefaultLimit
			return core.query({ conn: connOf(conn), sql, params: normalizeParams(params), limit: cap })
		},

		exec({ conn, sql, params = [], confirm = false }) {
			return core.exec({ conn: connOf(conn), sql, params: normalizeParams(params), confirm: confirm === true })
		},

		grid({ conn, table, where, order, limit, offset }) {
			return core.grid({
				conn: connOf(conn),
				table,
				where: where ?? '',
				order: order ?? [],
				limit,
				offset: offset ?? 0,
			})
		},

		setCell({ conn, table, key, column, value, confirm = false }) {
			return core.setCell({ conn: connOf(conn), table, key, column, value, confirm: confirm === true })
		},

		deleteRow({ conn, table, key, confirm = false }) {
			return core.deleteRow({ conn: connOf(conn), table, key, confirm: confirm === true })
		},

		insertRow({ conn, table, values, confirm = false }) {
			return core.insertRow({ conn: connOf(conn), table, values, confirm: confirm === true })
		},

		/** 导出：format=csv|json；给了 to 就落盘（限插件数据目录内），否则回文本给面板下载。 */
		async export({ conn, sql, params = [], format = 'csv', limit, to }) {
			const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : cfg.maxLimit
			const result = await core.export({ conn: connOf(conn), sql, params: normalizeParams(params), format, limit: cap })
			if (!to) return result
			const target = resolve(String(to))
			const roots = [cfg.root, ...cfg.extraDirs]
			const inside = roots.some((root) => target === root || target.startsWith(root + '/') || target.startsWith(root + '\\'))
			if (!inside) {
				throw new DbError('path-out-of-scope', `导出目标必须在允许目录下：${roots.join(', ')}`)
			}
			mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
			writeFileSync(target, result.text, 'utf8')
			const bytes = Buffer.byteLength(result.text, 'utf8')
			return { format: result.format, path: target, bytes, rowCount: result.rowCount, truncated: result.truncated }
		},

		async create({ path, label }) {
			const created = await core.create({ path })
			const connection = connections.add({ path: created.path, label, allowCreate: true })
			return { ...created, connection }
		},

		backup({ conn, to }) {
			return core.backup({ conn: connOf(conn), to })
		},
	}
}

function normalizeParams(params) {
	if (params === undefined || params === null) return []
	if (Array.isArray(params)) return params
	throw new DbError('bad-request', 'params 必须是数组（对应 SQL 里的 ?）')
}
