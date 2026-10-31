/**
 * 连接注册表：把「数据库文件」登记成有 id 的连接，落盘为一份 JSON。
 * 只允许访问已登记的连接 —— 这是防「任意文件读写」的第一道闸。
 * @module dsh-db/connections
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DbError } from './sqlite.js'

const FILE_NAME = 'connections.json'

function safePathLabel(target, roots) {
	for (const root of roots) {
		const rel = relative(root, target)
		if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return `~/${rel.replace(/\\/g, '/')}`
	}
	return target
}

export class ConnectionStore {
	constructor({ file, rootsProvider }) {
		this.file = file
		this.rootsProvider = rootsProvider ?? (() => [])
		this.records = []
		this.load()
	}

	roots() {
		return this.rootsProvider()
	}

	load() {
		try {
			this.mtime = statSync(this.file).mtimeMs
		} catch {
			this.mtime = 0
		}
		try {
			if (!existsSync(this.file)) return
			const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
			if (Array.isArray(parsed?.connections)) {
				this.records = parsed.connections.filter(
					(r) => r && typeof r.id === 'string' && typeof r.path === 'string',
				)
			}
		} catch {
			this.records = []
		}
	}

	/** 面板与 Agent 可能并发写这份表；文件变了就重读，避免两侧看到不同状态。 */
	maybeReload() {
		try {
			const mtime = statSync(this.file).mtimeMs
			if (mtime !== this.mtime) this.load()
		} catch {
			/* 文件还没写过 */
		}
	}

	save() {
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
		const tmp = `${this.file}.tmp`
		writeFileSync(tmp, `${JSON.stringify({ version: 1, connections: this.records }, null, 2)}\n`, 'utf8')
		renameSync(tmp, this.file)
		try {
			this.mtime = statSync(this.file).mtimeMs
		} catch {
			this.mtime = 0
		}
	}

	list() {
		this.maybeReload()
		return this.records.map((r) => ({
			...r,
			exists: existsSync(r.path),
			label: safePathLabel(r.path, this.roots()),
		}))
	}

	get(id) {
		this.maybeReload()
		const found = this.records.find((r) => r.id === id)
		if (!found) throw new DbError('not-found', `未知连接 id：${id}（先用 db action=connections 查列表）`)
		return found
	}

	/** 登记一个库文件；路径必须落在允许根内（默认：插件数据目录 + 各工作区）。 */
	add({ path, label, allowCreate = false }) {
		const abs = resolve(String(path ?? ''))
		if (!abs || abs === resolve('.')) throw new DbError('bad-request', 'path 不能为空')
		const inRoot = this.roots().some((root) => {
			const rel = relative(root, abs)
			return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
		})
		if (!inRoot) {
			throw new DbError(
				'path-out-of-scope',
				`路径不在允许范围内：${abs}。允许根：${this.roots().join(', ')}。要放开更多目录，在插件 config 里加 allowDirs。`,
			)
		}
		if (!existsSync(abs) && !allowCreate) throw new DbError('no-such-file', `文件不存在：${abs}`)
		const existing = this.records.find((r) => r.path === abs)
		if (existing) return { ...existing, reused: true }
		const record = {
			id: `db-${randomUUID().slice(0, 8)}`,
			path: abs,
			label: label || abs.split(/[\\/]/).pop(),
			createdAt: new Date().toISOString(),
		}
		this.records.push(record)
		this.save()
		return record
	}

	remove(id) {
		const before = this.records.length
		this.records = this.records.filter((r) => r.id !== id)
		if (this.records.length === before) throw new DbError('not-found', `未知连接 id：${id}`)
		this.save()
		return { removed: id }
	}
}
