import { readFileSync } from 'node:fs'
import { builtinCommands } from './builtins.js'
import { RsqError } from './core.js'

type Flow = { id: string; name: string; status: string; commands: string[]; blockers?: unknown[]; [key: string]: unknown }
type Module = { id: string; name: string; flows: Flow[]; later: string[]; [key: string]: unknown }
export const mainFlows = JSON.parse(readFileSync(new URL('../contracts/main-flows.json', import.meta.url), 'utf8')) as {
  modules: Module[]; [key: string]: unknown
}
export function mainFlowCoverage(commands: { command: string }[], moduleId?: string, flowId?: string) {
  const available = new Set([...commands, ...builtinCommands].map(command => command.command))
  const modules = mainFlows.modules.map(module => {
    const flows = module.flows.map(flow => {
      const missingCommands = flow.commands.filter(command => !available.has(command))
      return { ...flow, ...(missingCommands.length && { status: 'review-required', missingCommands }), schemas: flow.commands.map(command => 'rsq schema "' + command + '"') }
    })
    const status = flows.every(flow => flow.status === 'verified') ? 'verified' : flows.some(flow => flow.status === 'review-required') ? 'review-required' : flows.some(flow => flow.status === 'pending') ? 'pending' : 'blocked'
    return { ...module, status, flows }
  })
  const { modules: _, summary: __, ...meta } = mainFlows
  if (moduleId) {
    const module = modules.find(module => module.id === moduleId)
    if (!module) throw new RsqError('UNKNOWN_BUSINESS_AREA', '主流程清单没有此模块。运行 rsq coverage --core 发现模块。', 2)
    if (!flowId) return { ...meta, ...module }
    const flow = module.flows.find(flow => flow.id === flowId)
    if (!flow) throw new RsqError('UNKNOWN_CAPABILITY', '主流程清单没有此流程。运行 rsq coverage ' + moduleId + ' --core 查看。', 2)
    return { ...meta, module: module.id, ...flow }
  }
  return { ...meta, summary: { modules: modules.length, verified: modules.filter(module => module.status === 'verified').length,
    pending: modules.filter(module => module.status === 'pending').length, blocked: modules.filter(module => module.status === 'blocked').length,
    reviewRequired: modules.filter(module => module.status === 'review-required').length },
    modules: modules.map(({ flows, ...module }) => ({ ...module, flows: flows.map(({ id, name, status, blockers }) => ({ id, name, status, ...(blockers && { blockers }) })), details: 'rsq coverage ' + module.id + ' --core' })) }
}
