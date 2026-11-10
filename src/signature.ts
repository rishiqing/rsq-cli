import { open } from 'node:fs/promises'
import { asObject, parseJson, request, RsqError, type Context, type JsonObject, type Transport } from './core.js'
import { catalog, runOperation } from './operations.js'
import { requireSession, type Session } from './session.js'
import { inspectUpload, uploadToStorage, type UploadTransfer } from './storage.js'
import { validateCloudUpload } from './cloud-file.js'
import type { Workflow } from './workflows.js'

export type SignatureAction = 'latest' | 'register' | 'upload'
type Route = [string, string, string]
export type SignatureCall = (step: string, args?: JsonObject) => Promise<unknown>
export function signatureId(value: unknown): string {
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value) || typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  throw new RsqError('CONTEXT_MISSING', '签名上下文缺少精确文件 ID。', 5)
}
export function ownSignatureFile(value: unknown, fileId: unknown, userId: string) {
  const file = asObject(value), creator = file.creatorId ?? (typeof file.creator === 'object' ? asObject(file.creator).id : file.creator)
  if (signatureId(file.id) !== signatureId(fileId) || signatureId(creator) !== userId) throw new RsqError('FORBIDDEN', '签名文件必须是当前公司身份本人创建的文件。', 4)
  if (typeof file.name !== 'string' || !/\.png$/i.test(file.name) || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 20 * 1024 * 1024) throw new RsqError('INVALID_SIGNATURE_FILE', '签名需要不超过 20 MiB 的本人 PNG 文件。', 2)
  return { id: signatureId(file.id), name: file.name, size: file.size, creatorId: userId }
}
export async function resolveOwnSignature(call: SignatureCall, userId: string, businessUnit: string, expected?: unknown) {
  const latest = asObject(await call('signature', { query: { fromWhere: businessUnit } })), fileId = signatureId(latest.fileId)
  if (expected !== undefined && signatureId(expected) !== fileId) throw new RsqError('CONTEXT_CONFLICT', '签名已变化，或所选文件不是本业务本人最近一次登记的签名；不会提交审批。', 5)
  const file = ownSignatureFile(await call('signatureFile', { query: { id: fileId } }), fileId, userId)
  return { fileId, businessUnit, file }
}
export function signatureSteps(action: SignatureAction): Route[] {
  const identity: Route = ['identity', 'GET', '/task/login/authAjax']
  if (action === 'latest') return [identity, ['signature', 'GET', '/task/file/signature/getFront'], ['signatureFile', 'GET', '/task/v1/folder/file']]
  const tail: Route[] = [['registered', 'POST', '/task/file/signature'], ['signature', 'GET', '/task/file/signature/getFront'], ['signatureFile', 'GET', '/task/v1/folder/file']]
  if (action === 'register') return [identity, ['file', 'GET', '/task/v1/folder/file'], ...tail]
  return [identity, ['state', 'GET', '/task/ordercenter/v2/member/state/independent'], ['usage', 'GET', '/task/v1/folder/file/used'], ['uploadCheck', 'GET', '/task/files/file/upload/check'], ['certificate', 'GET', '/task/sts/token/oss'], ['stored', 'GET', '/task/sts/token/oss'], ['created', 'POST', '/task/v1/folder/file/getAliFile'], ['file', 'GET', '/task/v1/folder/file'], ...tail]
}
export function validateSignatureWorkflow(flow: Workflow) {
  if (!['latest', 'register', 'upload'].includes(flow.signatureAction!)) throw new RsqError('INVALID_CONTRACT', '未知签名操作。', 6)
  const expected = signatureSteps(flow.signatureAction!)
  if (flow.executor !== 'signature' || flow.steps.length !== expected.length || expected.some(([id, method, route], index) => {
    const step = flow.steps[index], op = catalog.operations.find(op => op.id === step.operationId)
    return step.id !== id || op?.method !== method || op.route !== route || Object.keys(step.input).length || (id === 'stored' ? step.transfer !== 'storage-upload' : !!step.transfer) || step.prepare || step.verify || step.resources || step.collectPages || step.readback || step.forEach
  })) throw new RsqError('INVALID_CONTRACT', '签名业务必须使用已核对的本人文件和 HTTP 读回步骤。', 6)
}
async function png(path: string) {
  const file = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(24), read = await file.read(bytes, 0, 24, 0)
    if (read.bytesRead !== 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString() !== 'IHDR'
      || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(20) < 1 || bytes.readUInt32BE(16) > 20000 || bytes.readUInt32BE(20) > 20000) throw new RsqError('INVALID_SIGNATURE_FILE', '签名文件不是有界 PNG 图片。', 2)
  } finally { await file.close() }
}
export async function runSignature(ctx: Context, flow: Workflow, input: JsonObject, supplied: Session | null, options: { transport?: Transport; approved?: boolean; uploadTransfer?: UploadTransfer } = {}) {
  validateSignatureWorkflow(flow)
  const session = requireSession(supplied), completed: string[] = [], resources: JsonObject = {}
  let phase = 'identity', pending = false
  const call: SignatureCall = async (id, args = {}) => {
    const step = flow.steps.find(step => step.id === id), operation = catalog.operations.find(op => op.id === step?.operationId)
    if (!operation) throw new RsqError('INVALID_CONTRACT', '签名调用了未声明的 HTTP 步骤。', 6)
    phase = id; pending = false
    const transport: Transport = async (url, init) => {
      pending = operation.effect !== 'read'
      const response = await (options.transport ?? request)(url, init)
      if (id === 'created' && response.ok) try {
        const receipt = asObject(parseJson(await response.clone().text()))
        if (receipt.id != null) resources.fileId = signatureId(receipt.id)
      } catch { /* Retain successful creation receipts before contract validation. */ }
      return response
    }
    const value = await runOperation(ctx, operation, args, session, { ...options, transport })
    pending = false; completed.push(id); return value
  }
  try {
    const identity = asObject(await call('identity'))
    if (String(identity.id) !== session.identity.userId || String(asObject(identity.team).id) !== session.identity.teamId) throw new RsqError('IDENTITY_CHANGED', '签名上下文与当前用户或公司不符。', 3)
    let fileId = input.fileId
    if (flow.signatureAction === 'upload') {
      const local = await inspectUpload(input.localFile, input.fileName)
      if (!/\.png$/i.test(local.name) || local.size > 20 * 1024 * 1024) throw new RsqError('INVALID_SIGNATURE_FILE', '请提供不超过 20 MiB 的本人 PNG 签名文件。', 2)
      await png(local.path)
      validateCloudUpload(asObject(await call('state')), asObject(await call('usage')), local)
      if (asObject(await call('uploadCheck', { query: { fileName: local.name } })).canUpload !== true) throw new RsqError('FILE_TYPE_FORBIDDEN', '当前公司不允许上传该文件扩展名。', 4)
      const certificate = await call('certificate', { query: { type: 'file' } })
      phase = 'stored'; pending = true
      const stored = await (options.uploadTransfer ?? uploadToStorage)(certificate, local, checkpoint => {
        for (const key of ['objectPath', 'uploadId', 'completedParts']) if (checkpoint[key] !== undefined) resources[key] = checkpoint[key]
      })
      pending = false; completed.push('stored')
      if (stored.size !== local.size || stored.md5 !== local.md5 || typeof stored.path !== 'string') throw new RsqError('BUSINESS_ASSERTION_FAILED', '存储回执与实际签名文件不一致。', 5)
      const created = asObject(await call('created', { body: { fileName: local.name, filePath: stored.path } }))
      fileId = signatureId(created.id); resources.fileId = fileId
      const file = ownSignatureFile(await call('file', { query: { id: fileId } }), fileId, session.identity.userId)
      if (file.size !== local.size || file.name !== local.name) throw new RsqError('BUSINESS_ASSERTION_FAILED', '独立读回的签名文件与上传内容不符。', 5)
    } else if (flow.signatureAction === 'register') ownSignatureFile(await call('file', { query: { id: input.fileId } }), input.fileId, session.identity.userId)
    if (flow.signatureAction !== 'latest') {
      resources.fileId = signatureId(fileId)
      await call('registered', { body: { fromWhere: input.businessUnit, fileId } })
    }
    const result = await resolveOwnSignature(call, session.identity.userId, String(input.businessUnit), fileId)
    return { workflow: flow.id, completedSteps: completed, resources, result: { ...result, identity: session.identity, validation: 'current-user-file-ownership-and-independent-business-latest-readback', limitations: ['登记只更新本业务的最近签名；提交审批须使用相应业务命令并显式确认。', 'CLI 原样上传提供的图片；请使用本人已标明对应审批用途的签名 PNG。画布绘制与扫码推送属于浏览器本地或 WebSocket 范围。', '服务端没有签名历史删除接口，不会伪造删除或自动回滚最近签名。'] } }
  } catch (error) {
    const failure = error instanceof RsqError ? error : new RsqError('WORKFLOW_FAILED', '签名操作未能完成。', 5)
    throw new RsqError(failure.code, failure.message, failure.exit, { workflow: flow.id, failedStep: phase, completedSteps: completed, resources,
      writeOutcome: pending ? 'unknown' : 'check-completed-steps', retry: 'manual-after-readback', automaticRollback: false, ...(failure.details && { cause: failure.details }) })
  }
}
