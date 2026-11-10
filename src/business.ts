import { readFileSync } from 'node:fs'
import type { Operation } from './operations.js'
import { RsqError } from './core.js'

type Binding = { operationId: string; [key: string]: unknown }
type Capability = { id: string; name: string; prerequisites: string[]; context: string[]; bindings: Binding[]; steps: string[]; assertions: string[]; [key: string]: unknown }
type Domain = { id: string; name: string; capabilities: Capability[]; [key: string]: unknown }
const ledger = JSON.parse(readFileSync(new URL('../contracts/business.json', import.meta.url), 'utf8')) as {
  version: number; summary: Record<string, unknown>; domains: Domain[]; operations: Record<string, unknown>
}
export const businessScope = { status: ledger.summary.status, scope: ledger.summary.scope, ...ledger.summary, domains: ledger.domains }
export function operationBusinessContext(op: Operation) {
  return {
    audit: ledger.operations[op.id] ?? { status: 'pending' },
    capabilities: ledger.domains.flatMap(domain => domain.capabilities.filter(cap => cap.bindings.some(b => b.operationId === op.id)).map(cap => ({
      domain: domain.id, id: cap.id, name: cap.name,
      prerequisites: cap.prerequisites, context: cap.context,
      bindings: cap.bindings.filter(binding => binding.operationId === op.id), steps: cap.steps, assertions: cap.assertions,
      relatedCommands: op.requiresBusinessContext ?? [op.command],
      coverage: 'rsq coverage ' + domain.id + ' ' + cap.id,
    }))),
  }
}
export function businessCoverage(domainId?: string, capabilityId?: string) {
  if (!domainId) return ledger.summary
  const domain = ledger.domains.find(domain => domain.id === domainId)
  if (!domain) throw new RsqError('UNKNOWN_BUSINESS_AREA', '业务清单中没有该分类。运行 rsq coverage 查看已登记分类。', 2)
  if (!capabilityId) return { version: ledger.version, ...domain }
  const capability = domain.capabilities.find(capability => capability.id === capabilityId)
  if (!capability) throw new RsqError('UNKNOWN_CAPABILITY', '该业务域没有此能力。运行 rsq coverage ' + domainId + ' 查看。', 2)
  return { version: ledger.version, domain: domain.id, ...capability }
}
