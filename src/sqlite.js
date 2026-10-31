/**
 * node:sqlite 封装：连接、语句分类、安全闸、结果整形。
 * 零原生依赖 —— 用 Node 内置的 node:sqlite（DSH 核心自己也在用）。
 * @module dsh-db/sqlite
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** 带稳定 code 的错误，路由与工具层按 code 映射状态码/提示。 */
export class DbError extends Error {
	constructor(code, message, detail) {
		super(message)
		this.name = 'DbError'
		this.code = code
		if (detail !== undefined) this.detail = detail
	}
}

let sqliteModule = null

/** 懒加载 node:sqlite；缺失时给出可操作的错误而不是崩栈。 */
export async function loadSqlite() {
	if (sqliteModule) return sqliteModule
	try {
		sqliteModule = await import('node:sqlite')
	} catch (error) {
		throw new DbError(
			'sqlite-unavailable',
			`node:sqlite 不可用（需 Node >= 22.5；DSH 运行时自带）：${error && error.message ? error.message : String(error)}`,
		)
	}
	return sqliteModule
}

const READ_FIRST = new Set(['select', 'with', 'values', 'explain'])
const WRITE_FIRST = new Set([
	'insert', 'update', 'delete', 'replace', 'create', 'drop', 'alter',
	'begin', 'commit', 'rollback', 'vacuum', 'reindex', 'analyze',
])

/** 去掉注释与字符串字面量，用于关键字判定（不改变语句本身）。 */
export function stripSql(sql) {
	return String(sql ?? '')
		.replace(/--[^\n]*/g, ' ')
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/'(?:''|[^'])*'/g, "''")
		.replace(/"(?:""|[^"])*"/g, '""')
}

/** 带参数的只读 PRAGMA（元数据类）；其余 `PRAGMA name(value)` 视为写。 */
const READ_PRAGMAS = new Set([
	'table_info', 'table_xinfo', 'index_list', 'index_info', 'index_column_info',
	'foreign_key_list', 'column_list', 'database_list', 'collation_list',
	'compile_options', 'function_list', 'module_list', 'pragma_list',
	'integrity_check', 'quick_check', 'foreign_key_check', 'page_count',
	'user_version', 'schema_version', 'data_version', 'application_id', 'encoding',
])

/** 判定语句类型：read | write | unknown | empty。 */
export function classify(sql) {
	const body = stripSql(sql).trim()
	if (!body) return { kind: 'empty', first: '' }
	const head = /^([a-z_]+)/i.exec(body)
	const first = head ? head[1].toLowerCase() : ''
	if (first === 'pragma') {
		const m = /^\s*pragma\s+([a-z_]+)\s*([=(]?)/i.exec(body)
		const name = m ? m[1].toLowerCase() : ''
		const op = m ? m[2] : ''
		if (op === '=') return { kind: 'write', first: `pragma ${name}` }
		if (op === '(' && !READ_PRAGMAS.has(name)) return { kind: 'write', first: `pragma ${name}` }
		return { kind: 'read', first: `pragma ${name}` }
	}
	if (READ_FIRST.has(first)) return { kind: 'read', first }
	if (WRITE_FIRST.has(first)) return { kind: 'write', first }
	return { kind: 'unknown', first }
}

/** 安全闸：默认禁 ATTACH/DETACH 与 load_extension；未识别语句一律拒绝。 */
export function assertSafeSql(sql, cfg) {
	const cls = classify(sql)
	if (cls.kind === 'empty') throw new DbError('empty-sql', '空语句')
	if (cls.first === 'attach' || cls.first === 'detach') {
		if (!cfg.allowAttach) {
			throw new DbError('forbidden-sql', '默认禁止 ATTACH / DETACH（可跨文件读写任意路径）；确需时在插件 config 里设 allowAttach: true')
		}
		return cls
	}
	if (/\bload_extension\s*\(/i.test(stripSql(sql))) {
		throw new DbError('forbidden-sql', '禁止 load_extension：不加载外部原生扩展')
	}
	if (cls.kind === 'unknown') {
		throw new DbError('forbidden-sql', `未识别的语句起始关键字：${cls.first || '(无)'}`)
	}
	return cls
}

/** 标识符引用；拒绝 NUL。 */
export function quoteIdent(name) {
	const s = String(name ?? '')
	if (!s) throw new DbError('bad-identifier', '空标识符')
	if (s.includes('\0')) throw new DbError('bad-identifier', '标识符含非法字符')
	return `"${s.replace(/"/g, '""')}"`
}

/** 单元格值 → JSON 安全表示（BLOB 转 base64 摘要，BigInt 保精度）。 */
function encodeCell(value) {
	if (value === null || value === undefined) return null
	if (typeof value === 'bigint') {
		const n = Number(value)
		return Number.isSafeInteger(n) ? n : { __bigint: String(value) }
	}
	if (value instanceof Uint8Array) {
		let binary = ''
		const chunk = 0x8000
		for (let i = 0; i < value.length; i += chunk) {
			binary += String.fromCharCode(...value.subarray(i, i + chunk))
		}
		return { __blob: Buffer.from(binary, 'binary').toString('base64'), bytes: value.length }
	}
	if (typeof value === 'object' && typeof value.text === 'function') {
		const bytes = new Uint8Array(value.buffer ?? value.arrayBuffer?.() ?? new ArrayBuffer(0))
		return { __blob: Buffer.from(bytes).toString('base64'), bytes: bytes.length }
	}
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
	return String(value)
}

function approxBytes(row) {
	try {
		return JSON.stringify(row).length + 8
	} catch {
		return 64
	}
}

/**
 * 连接与语句执行的核心。持有已打开的 DatabaseSync 句柄（按 连接id + 读写模式 分键）。
 */
export class DbCore {
	constructor(cfg) {
		this.cfg = cfg
		this.handles = new Map()
	}

	/** 关掉全部句柄；卸载路径调用。 */
	closeAll() {
		for (const db of this.handles.values()) {
			try {
				db.close()
			} catch {
				/* 已关闭或底层错误：忽略，卸载不该因此中断 */
			}
		}
		this.handles.clear()
	}

	/** 文件不存在时是否允许创建（db.create 走这里）。 */
	async handle(conn, { readOnly }) {
		const key = `${conn.id}:${readOnly ? 'ro' : 'rw'}`
		const cached = this.handles.get(key)
		if (cached) return cached
		const { DatabaseSync } = await loadSqlite()
		const path = resolve(conn.path)
		if (!existsSync(path)) {
			if (!readOnly) {
				mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
			} else {
				throw new DbError('no-such-file', `数据库文件不存在：${path}`)
			}
		}
		const db = new DatabaseSync(path, { readOnly: false })
		try {
			db.exec('PRAGMA busy_timeout = 5000')
			if (readOnly) db.exec('PRAGMA query_only = 1')
		} catch {
			/* 老版本 sqlite 编译期没开这些 pragma：不致命 */
		}
		this.handles.set(key, db)
		return db
	}

	/** 单语句查询：返回列 + 行 + 截断标记。多语句明确拒绝（改用 exec）。 */
	async query({ conn, sql, params = [], limit, readOnly = true }) {
		const cfg = this.cfg
		const cls = assertSafeSql(sql, cfg)
		if (cls.kind === 'write' && !cfg.allowWrite) {
			throw new DbError('write-disabled', '插件配置 allowWrite=false：query 面只允许读语句（写走 exec）')
		}
		const stripped = stripSql(sql).trim().replace(/;\s*$/, '')
		if (/;/.test(stripped)) {
			throw new DbError('multi-statement', 'query 只接受单语句；多条语句请用 exec')
		}
		const cap = Math.min(
			Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : cfg.defaultLimit,
			cfg.maxLimit,
			cfg.maxRows,
		)
		const db = await this.handle(conn, { readOnly: cls.kind === 'read' ? true : !readOnly })
		const started = Date.now()
		let stmt
		try {
			stmt = db.prepare(sql)
		} catch (error) {
			throw new DbError('sql-error', `准备语句失败：${error && error.message ? error.message : error}`)
		}
		const columns = typeof stmt.columns === 'function'
			? stmt.columns().map((c) => (typeof c === 'string' ? c : c.name))
			: null
		const rows = []
		let bytes = 0
		let truncated = false
		let iterator
		try {
			iterator = stmt.iterate(...params)
		} catch (error) {
			throw new DbError('sql-error', `执行失败：${error && error.message ? error.message : error}`)
		}
		try {
			for (const raw of iterator) {
				const row = {}
				for (const [k, v] of Object.entries(raw)) row[k] = encodeCell(v)
				bytes += approxBytes(row)
				if (rows.length >= cap || bytes > cfg.maxBytes) {
					truncated = true
					break
				}
				rows.push(row)
			}
		} catch (error) {
			throw new DbError('sql-error', `读取结果中断：${error && error.message ? error.message : error}`)
		} finally {
			try {
				iterator.return?.()
			} catch {
				/* 迭代器释放失败不影响已取结果 */
			}
		}
		const names = columns && columns.length ? columns : (rows.length ? Object.keys(rows[0]) : [])
		return {
			kind: cls.kind,
			columns: names,
			rows,
			rowCount: rows.length,
			truncated,
			limit: cap,
			elapsedMs: Date.now() - started,
		}
	}

	/** 多语句执行（无结果集）：写操作要 allowWrite + confirm。 */
	async exec({ conn, sql, params = [], confirm = false }) {
		const cfg = this.cfg
		const cls = assertSafeSql(sql, cfg)
		if (!cfg.allowWrite) {
			throw new DbError('write-disabled', '插件配置 allowWrite=false：写/DDL 已禁用。要开启请在 cordis.patch.yml 里设 allowWrite: true')
		}
		if (cls.kind === 'write' && confirm !== true) {
			throw new DbError('confirm-required', '写操作需显式确认：携带 confirm: true 重试')
		}
		const db = await this.handle(conn, { readOnly: false })
		const started = Date.now()
		let changes = 0
		let lastInsertRowid = null
		if (/;/.test(stripSql(sql).trim().replace(/;\s*$/, ''))) {
			try {
				db.exec(sql)
			} catch (error) {
				throw new DbError('sql-error', `执行失败：${error && error.message ? error.message : error}`)
			}
		} else {
			let stmt
			try {
				stmt = db.prepare(sql)
			} catch (error) {
				throw new DbError('sql-error', `准备语句失败：${error && error.message ? error.message : error}`)
			}
			try {
				const info = stmt.run(...params)
				changes = Number(info.changes ?? 0)
				lastInsertRowid = info.lastInsertRowid === undefined ? null : Number(info.lastInsertRowid)
			} catch (error) {
				throw new DbError('sql-error', `执行失败：${error && error.message ? error.message : error}`)
			}
		}
		return {
			kind: cls.kind,
			changes,
			lastInsertRowid,
			elapsedMs: Date.now() - started,
		}
	}

	/** 表/视图/索引清单 + 列 + 行数估计。 */
	async schema({ conn, includeCounts = true }) {
		const db = await this.handle(conn, { readOnly: true })
		const objects = db
			.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
			.all()
		const tables = []
		for (const obj of objects) {
			if (obj.type !== 'table' && obj.type !== 'view') continue
			const columns = db
				.prepare(`PRAGMA table_info(${quoteIdent(obj.name)})`)
				.all()
				.map((c) => ({
					name: c.name,
					type: c.type,
					notnull: !!c.notnull,
					pk: !!c.pk,
					dflt: c.dflt_value,
				}))
			const indexes = db
				.prepare(`PRAGMA index_list(${quoteIdent(obj.name)})`)
				.all()
				.map((i) => {
					const cols = db
						.prepare(`PRAGMA index_info(${quoteIdent(i.name)})`)
						.all()
						.map((x) => x.name)
					return { name: i.name, unique: !!i.unique, origin: i.origin, columns: cols }
				})
			let rows = null
			if (includeCounts && obj.type === 'table') {
				try {
					rows = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(obj.name)}`).get().c)
				} catch {
					rows = null
				}
			}
			tables.push({ name: obj.name, type: obj.type, columns, indexes, rows, ddl: obj.sql })
		}
		const indexes = objects
			.filter((o) => o.type === 'index')
			.map((o) => ({ name: o.name, table: null, ddl: o.sql }))
		return { tables, indexes, objectCount: objects.length }
	}

	/** 主键列；没有主键时回退 rowid。 */
	async primaryKey({ conn, table }) {
		const db = await this.handle(conn, { readOnly: true })
		const pk = db
			.prepare(`PRAGMA table_info(${quoteIdent(table)})`)
			.all()
			.filter((c) => c.pk)
			.sort((a, b) => a.pk - b.pk)
			.map((c) => c.name)
		return pk.length ? { kind: 'pk', columns: pk } : { kind: 'rowid', columns: ['rowid'] }
	}

	/** 数据网格：分页 + 排序 + 原始 WHERE 过滤。 */
	async grid({ conn, table, where = '', order = [], limit, offset = 0 }) {
		const cfg = this.cfg
		const cap = Math.min(
			Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : cfg.defaultLimit,
			cfg.maxLimit,
			cfg.maxRows,
		)
		const frag = String(where ?? '').trim()
		// 分号检测在去字面量后的文本上做，SQL 里用原始片段（stripSql 会抹掉字符串内容）
		if (/;/.test(stripSql(frag))) throw new DbError('forbidden-sql', '过滤条件里不允许分号')
		const quoted = quoteIdent(table)
		const orderSql = Array.isArray(order) && order.length
			? ` ORDER BY ${order
				.map((o) => `${quoteIdent(o.column)} ${String(o.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`)
				.join(', ')}`
			: ''
		const whereSql = frag ? ` WHERE ${frag}` : ''
		const db = await this.handle(conn, { readOnly: true })
		let total = null
		try {
			total = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${quoted}${whereSql}`).get().c)
		} catch {
			total = null
		}
		const started = Date.now()
		const result = await this.query({
			conn,
			sql: `SELECT * FROM ${quoted}${whereSql}${orderSql} LIMIT ? OFFSET ?`,
			params: [cap + 1, Math.max(0, Math.floor(offset))],
			limit: cap,
		})
		return { ...result, total, table, where: frag, order, elapsedMs: Date.now() - started }
	}

	/** 改一个单元格。按主键（或 rowid）定位。 */
	async setCell({ conn, table, key, column, value, confirm = false }) {
		const cfg = this.cfg
		if (!cfg.allowWrite) throw new DbError('write-disabled', 'allowWrite=false：网格编辑已禁用')
		if (confirm !== true) throw new DbError('confirm-required', '写操作需显式确认：携带 confirm: true 重试')
		const pk = await this.primaryKey({ conn, table })
		const sets = Object.entries(key).map(([k]) => `${quoteIdent(k)} = ?`)
		const params = Object.values(key)
		const db = await this.handle(conn, { readOnly: false })
		const started = Date.now()
		const info = db
			.prepare(`UPDATE ${quoteIdent(table)} SET ${quoteIdent(column)} = ? WHERE ${sets.join(' AND ')}`)
			.run(value, ...params)
		return { changes: Number(info.changes ?? 0), elapsedMs: Date.now() - started, keyKind: pk.kind }
	}

	/** 删一行。 */
	async deleteRow({ conn, table, key, confirm = false }) {
		const cfg = this.cfg
		if (!cfg.allowWrite) throw new DbError('write-disabled', 'allowWrite=false：网格删除已禁用')
		if (confirm !== true) throw new DbError('confirm-required', '写操作需显式确认：携带 confirm: true 重试')
		const db = await this.handle(conn, { readOnly: false })
		const where = Object.keys(key).map((k) => `${quoteIdent(k)} = ?`).join(' AND ')
		const started = Date.now()
		const info = db.prepare(`DELETE FROM ${quoteIdent(table)} WHERE ${where}`).run(...Object.values(key))
		return { changes: Number(info.changes ?? 0), elapsedMs: Date.now() - started }
	}

	/** 插入一行（列名 → 值）。 */
	async insertRow({ conn, table, values, confirm = false }) {
		const cfg = this.cfg
		if (!cfg.allowWrite) throw new DbError('write-disabled', 'allowWrite=false：网格插入已禁用')
		if (confirm !== true) throw new DbError('confirm-required', '写操作需显式确认：携带 confirm: true 重试')
		const cols = Object.keys(values)
		if (!cols.length) throw new DbError('bad-request', '没有要插入的列')
		const db = await this.handle(conn, { readOnly: false })
		const started = Date.now()
		const info = db
			.prepare(`INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
			.run(...cols.map((c) => values[c]))
		return { changes: Number(info.changes ?? 0), lastInsertRowid: Number(info.lastInsertRowid ?? 0), elapsedMs: Date.now() - started }
	}

	/** 导出：跑一条 SELECT，序列化成 CSV 或 JSON 文本。 */
	async export({ conn, sql, params = [], format = 'csv', limit }) {
		const result = await this.query({ conn, sql, params, limit: limit ?? this.cfg.maxLimit, readOnly: true })
		const { columns, rows } = result
		if (format === 'json') {
			return { format, text: JSON.stringify(rows, null, 2), rowCount: rows.length, truncated: result.truncated }
		}
		const esc = (v) => {
			const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
			return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
		}
		const lines = [columns.map(esc).join(',')]
		for (const row of rows) lines.push(columns.map((c) => esc(row[c])).join(','))
		return { format: 'csv', text: lines.join('\r\n'), rowCount: rows.length, truncated: result.truncated }
	}

	/** 新建空库文件。 */
	async create({ path }) {
		const abs = resolve(path)
		mkdirSync(dirname(abs), { recursive: true, mode: 0o700 })
		const { DatabaseSync } = await loadSqlite()
		const db = new DatabaseSync(abs)
		try {
			db.exec('PRAGMA user_version = 0')
		} finally {
			db.close()
		}
		return { path: abs, created: true }
	}

	/** VACUUM INTO 备份（sqlite 3.27+）。 */
	async backup({ conn, to }) {
		if (!this.cfg.allowWrite) throw new DbError('write-disabled', 'allowWrite=false：备份需要打开写权限')
		const abs = resolve(to)
		mkdirSync(dirname(abs), { recursive: true, mode: 0o700 })
		const db = await this.handle(conn, { readOnly: false })
		db.prepare('VACUUM INTO ?').run(abs)
		return { path: abs }
	}
}
