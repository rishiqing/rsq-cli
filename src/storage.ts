import OSS from 'ali-oss'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { asObject, RsqError, type JsonObject } from './core.js'

export type LocalUpload = { path: string; name: string; size: number; md5: string; mtimeMs: number; ino: number; dev: number }
export type StoredUpload = { path: string; size: number; md5: string; mode: 'put' | 'multipart'; etag?: string }
export type UploadTransfer = (certificate: unknown, file: LocalUpload, progress: (checkpoint: JsonObject) => void) => Promise<StoredUpload>

export async function inspectUpload(path: unknown, name?: unknown): Promise<LocalUpload> {
  if (typeof path !== 'string' || !path || name !== undefined && (typeof name !== 'string' || !name)) throw new RsqError('INVALID_INPUT', '上传需要明确的本地文件路径和合法文件名。', 2)
  try {
    const actual = await realpath(path), before = await stat(actual), fileName = typeof name === 'string' ? name : basename(actual)
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 1 || fileName.length > 100 || /[\x00-\x1f\x7f/\\]/.test(fileName)) throw new RsqError('INVALID_FILE', '上传需要非空普通文件；文件名最多 100 字符且不能含路径或控制字符。', 2)
    const md5 = createHash('md5')
    for await (const chunk of createReadStream(actual)) md5.update(chunk)
    const after = await stat(actual)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev) throw new RsqError('CONTEXT_CONFLICT', '读取上传文件期间内容发生变化；停止写入。', 5)
    return { path: actual, name: fileName, size: before.size, md5: md5.digest('hex'), mtimeMs: before.mtimeMs, ino: before.ino, dev: before.dev }
  } catch (error) {
    if (error instanceof RsqError) throw error
    throw new RsqError('FILE_READ_ERROR', '无法读取待上传文件。', 2)
  }
}

export function storageOptions(raw: unknown) {
  const certificate = asObject(raw), credentials = asObject(certificate.credentials)
  if (certificate.storage !== 'oss') throw new RsqError('STORAGE_UNSUPPORTED', '当前正式服务的上传需要 OSS；收到其他存储类型时停止，不猜测外部服务。', 5)
  if (typeof certificate.bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(certificate.bucket)
    || typeof certificate.prefix !== 'string' || !/^[a-zA-Z0-9_/-]+$/.test(certificate.prefix) || certificate.prefix.split('/').some(part => !part || part === '.' || part === '..')
    || !['AccessKeyId', 'AccessKeySecret', 'SecurityToken'].every(key => typeof credentials[key] === 'string' && (credentials[key] as string).length > 0)
    || typeof credentials.Expiration !== 'string' || !(Date.parse(credentials.Expiration) > Date.now() + 30000)) throw new RsqError('CONTEXT_MISSING', '服务端未返回有效的临时上传权限或受限路径。', 5)
  const endpoint = typeof certificate.endpoint === 'string' ? certificate.endpoint : 'https://oss-cn-beijing.aliyuncs.com'
  let parsed: URL
  try { parsed = new URL(endpoint.includes('://') ? endpoint : 'https://' + endpoint) } catch { throw new RsqError('STORAGE_ORIGIN_MISMATCH', '上传地址不符合正式存储服务配置。', 5) }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || parsed.pathname !== '/'
    || !/^oss-[a-z0-9-]+\.aliyuncs\.com$/.test(parsed.hostname)) throw new RsqError('STORAGE_ORIGIN_MISMATCH', '临时上传凭证只能发送至正式 OSS 服务。', 5)
  return { prefix: certificate.prefix, options: { bucket: certificate.bucket, region: 'oss-cn-beijing', endpoint: parsed.origin, secure: true,
    accessKeyId: String(credentials.AccessKeyId), accessKeySecret: String(credentials.AccessKeySecret), stsToken: String(credentials.SecurityToken),
    retryMax: 0, refreshSTSTokenInterval: 3600000, timeout: 120000 } }
}

// Temporary storage credentials are never the RSQ token or Cookie. No write
// retry, automatic token refresh, public ACL change, or credential persistence.
export const uploadToStorage: UploadTransfer = async (certificate, file, progress) => {
  const { prefix, options } = storageOptions(certificate)
  const before = await stat(file.path).catch(() => null)
  if (!before || before.size !== file.size || before.mtimeMs !== file.mtimeMs || before.ino !== file.ino || before.dev !== file.dev) throw new RsqError('CONTEXT_CONFLICT', '上传前本地文件发生变化；停止写入。', 5)
  const objectPath = prefix + '/' + randomUUID() + extname(file.name).toLowerCase()
  if (objectPath.length > 150) throw new RsqError('INVALID_INPUT', '上传存储路径超出业务接口 150 字符限制。', 2)
  const client = new OSS(options), multipart = file.size >= 8 * 1024 * 1024
  const checkpoint: JsonObject = { objectPath, size: file.size, mode: multipart ? 'multipart' : 'put' }
  progress(checkpoint)
  try {
    const headers = { 'Content-Disposition': 'attachment; filename="' + encodeURIComponent(file.name) + '"' }
    const result = multipart ? await client.multipartUpload(objectPath, file.path, { partSize: 8 * 1024 * 1024, parallel: 1, headers,
      progress: async (_percentage, state) => {
        if (state?.uploadId) checkpoint.uploadId = state.uploadId
        checkpoint.completedParts = state?.doneParts?.map((part: { number: number; etag: string }) => ({ number: part.number, etag: part.etag })) ?? []
        progress({ ...checkpoint })
      } }) : await client.put(objectPath, file.path, { headers: { ...headers, 'Content-MD5': Buffer.from(file.md5, 'hex').toString('base64') } })
    if (result.res.status !== 200) throw new Error('Unconfirmed upload status')
    return { path: objectPath, size: file.size, md5: file.md5, mode: multipart ? 'multipart' : 'put', ...('etag' in result && typeof result.etag === 'string' && { etag: result.etag }) }
  } catch {
    throw new RsqError('STORAGE_TRANSFER_UNKNOWN', '文件上传未能确认完成；不会自动重放。请根据存储路径和分片进度核对，再决定恢复或清理。', 5, { storage: checkpoint })
  }
}
