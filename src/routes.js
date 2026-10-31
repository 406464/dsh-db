/**
 * HTTP 面：面板的数据通道。POST /dsh-db/api/<method>，JSON 信封 {ok,value} | {ok:false,error}。
 * 与 Agent 工具共用 api.js 的同一份方法。
 * @module dsh-db/routes
 */
import { DbError } from './sqlite.js'

export const PLUGIN_ID = 'dsh-db'

/** 仅限本机回环：面板与宿主同源，外部地址一律拒。 */
export function isLoopbackRequest(hostHeader, remoteAddress) {
	const addr = String(remoteAddress ?? '')
	if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') return true
	const host = String(hostHeader ?? '').toLowerCase()
	if (host.startsWith('localhost')) return true
	if (host.startsWith('127.0.0.1')) return true
	if (host.startsWith('[::1]')) return true
	return false
}

const STATUS_BY_CODE = {
	'not-found': 404,
	'bad-request': 400,
	'empty-sql': 400,
	'unknown-method': 400,
	'unknown-action': 400,
	'path-out-of-scope': 400,
	'bad-identifier': 400,
	forbidden: 403,
	'forbidden-sql': 403,
	'write-disabled': 403,
	'confirm-required': 409,
	'sql-error': 422,
	'no-such-file': 404,
	'sqlite-unavailable': 500,
	'multi-statement': 400,
}

export function errorStatus(envelope) {
	return STATUS_BY_CODE[envelope?.error?.code] ?? 500
}

export function json(res, status, payload) {
	res.statusCode = status
	res.setHeader('content-type', 'application/json; charset=utf-8')
	res.end(JSON.stringify(payload))
}

export class BodyTooLargeError extends Error {}

export async function readJsonBody(req, limitBytes = 4 << 20) {
	const chunks = []
	let total = 0
	for await (const chunk of req) {
		total += chunk.length
		if (total > limitBytes) throw new BodyTooLargeError()
		chunks.push(chunk)
	}
	const raw = Buffer.concat(chunks).toString('utf8').trim()
	if (!raw) return {}
	const parsed = JSON.parse(raw)
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('body must be a json object')
	}
	return parsed
}

/** 方法名 → api 调用。面板只调这里出现的方法。 */
export function dispatch(api, method, body) {
	switch (method) {
		case 'info':
			return api.info()
		case 'connections.list':
			return api.connectionsList()
		case 'connections.add':
			return api.connectionsAdd(body)
		case 'connections.remove':
			return api.connectionsRemove(body)
		case 'db.create':
			return api.create(body)
		case 'db.backup':
			return api.backup(body)
		case 'schema':
			return api.schema(body)
		case 'query':
			return api.query(body)
		case 'exec':
			return api.exec(body)
		case 'grid':
			return api.grid(body)
		case 'grid.cell':
			return api.setCell(body)
		case 'grid.delete':
			return api.deleteRow(body)
		case 'grid.insert':
			return api.insertRow(body)
		case 'export':
			return api.export(body)
		default:
			throw new DbError('unknown-method', `未知方法：${String(method)}`)
	}
}

export async function handleApi(api, method, body) {
	try {
		const value = await dispatch(api, method, body ?? {})
		return { ok: true, value }
	} catch (error) {
		const code = error?.code ?? 'internal'
		return { ok: false, error: { code, message: error?.message ?? String(error) } }
	}
}
