import { Builder, parseString } from 'xml2js'
import { createHash } from 'node:crypto'
import { asObject, RsqError, type JsonObject } from './core.js'

const list = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(asObject) : []
const element = (value: JsonObject, name: string) => value[Object.keys(value).find(key => key.split(':').at(-1) === name) ?? name]
const identifier = (value: unknown) => {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new RsqError('CONTEXT_MISSING', '流程图节点需要有效的步骤 ID。', 2)
  return value
}
export function parseWorkflowGraph(value: unknown) {
  if (typeof value !== 'string' || value.length > 4 * 1024 * 1024 || /<!\s*(?:DOCTYPE|ENTITY)/i.test(value)) throw new RsqError('CONTEXT_MISSING', '流程图缺少有效且不含外部实体的 XML。', 5)
  let parsed: unknown, problem: unknown
  parseString(value, { explicitArray: true, explicitRoot: true, strict: true }, (error, data: unknown) => { problem = error; parsed = data })
  if (problem || !parsed) throw new RsqError('CONTEXT_MISSING', '服务端流程图 XML 无法解析。', 5)
  const root = asObject(element(asObject(parsed), 'definitions')), process = list(element(root, 'process'))[0]
  if (!process) throw new RsqError('CONTEXT_MISSING', '服务端流程图没有 process 节点。', 5)
  const edges = list(element(process, 'sequenceFlow')).map(flow => ({ from: String(asObject(flow.$).sourceRef), to: String(asObject(flow.$).targetRef) }))
  const version = createHash('sha256').update(value).digest('hex')
  return { version, processId: asObject(process.$).id, edges, nodes: list(element(process, 'userTask')).map(node => ({ id: asObject(node.$).id, name: asObject(node.$).name })) }
}
const protocolId = (value: unknown) => value === 'start' ? 'startEvent1' : value === 'end' ? 'endEvent1' : 'userTask' + identifier(value)
export function buildWorkflowGraph(application: JsonObject, steps: JsonObject[], links: JsonObject[]) {
  const nodeIds = new Set(steps.map(step => protocolId(String(step.id)))), all = new Set(['startEvent1', 'endEvent1', ...nodeIds])
  if (!steps.length || steps.length > 200 || nodeIds.size !== steps.length || !links.length || links.length > 1000) throw new RsqError('INVALID_INPUT', '流程图需要 1..200 个不重复步骤和明确的连线。', 2)
  const edges = links.map(link => ({ from: protocolId(link.from), to: protocolId(link.to) })), seen = new Set<string>()
  for (const edge of edges) {
    const key = edge.from + '-' + edge.to
    if (!all.has(edge.from) || !all.has(edge.to) || edge.from === 'endEvent1' || edge.to === 'startEvent1' || edge.from === edge.to || seen.has(key)) throw new RsqError('INVALID_INPUT', '流程连线有重复、无效端点或不属于当前应用的步骤。', 2)
    seen.add(key)
  }
  const reached = (start: string, reverse = false) => {
    const result = new Set([start]), queue = [start]
    while (queue.length) {
      const id = queue.shift()!
      for (const edge of edges) if ((reverse ? edge.to : edge.from) === id) {
        const target = reverse ? edge.from : edge.to
        if (!result.has(target)) { result.add(target); queue.push(target) }
      }
    }
    return result
  }
  const fromStart = reached('startEvent1'), toEnd = reached('endEvent1', true)
  if ([...all].some(id => !fromStart.has(id) || !toEnd.has(id))) throw new RsqError('INVALID_INPUT', '每个步骤都必须从开始可达，并能到达结束；未连接步骤不会被静默丢弃。', 2)
  const processId = 'flow' + identifier(String(application.id)), nodes = [
    { id: 'startEvent1', name: '开始', type: 'startEvent' }, ...steps.map(step => ({ id: protocolId(String(step.id)), name: String(step.name ?? ''), type: 'userTask', stepType: step.stepType })), { id: 'endEvent1', name: '结束', type: 'endEvent' },
  ]
  const process = { $: { id: processId, name: String(application.name ?? ''), isExecutable: 'true' }, startEvent: [{ $: { id: 'startEvent1' } }], endEvent: [{ $: { id: 'endEvent1' } }],
    userTask: nodes.filter(node => node.type === 'userTask').map(node => ({ $: { id: node.id, name: node.name } })),
    sequenceFlow: edges.map(edge => ({ $: { id: edge.from + '-' + edge.to, sourceRef: edge.from, targetRef: edge.to } })) }
  const shapes = nodes.map((node, index) => ({ $: { id: 'BPMNShape_' + node.id, bpmnElement: node.id, ...(node.type === 'userTask' && { 'g6:isRepeat': 'stepType' in node && node.stepType === 'repeat' ? 'true' : 'false', 'g6:isAutoStep': 'stepType' in node && node.stepType === 'auto' ? 'true' : 'false' }) },
    'omgdc:Bounds': [{ $: { x: String(index * 200), y: '100', width: node.type === 'userTask' ? '136' : '68', height: node.type === 'userTask' ? '58' : '68' } }] }))
  const definitions = { $: { xmlns: 'http://www.omg.org/spec/BPMN/20100524/MODEL', 'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance', 'xmlns:xsd': 'http://www.w3.org/2001/XMLSchema', 'xmlns:activiti': 'http://activiti.org/bpmn',
    'xmlns:bpmndi': 'http://www.omg.org/spec/BPMN/20100524/DI', 'xmlns:omgdc': 'http://www.omg.org/spec/DD/20100524/DC', 'xmlns:omgdi': 'http://www.omg.org/spec/DD/20100524/DI', 'xmlns:g6': 'http://bpmn.io/schema/bpmn/g6/1.0', targetNamespace: 'http://www.activiti.org/processdef', typeLanguage: 'http://www.w3.org/2001/XMLSchema', expressionLanguage: 'http://www.w3.org/1999/XPath' },
  process: [process], 'bpmndi:BPMNDiagram': [{ $: { id: 'BPMNDiagram_' + processId }, 'bpmndi:BPMNPlane': [{ $: { id: 'BPMNPlane_' + processId, bpmnElement: processId }, 'bpmndi:BPMNShape': shapes,
    'bpmndi:BPMNEdge': edges.map(edge => ({ $: { id: 'BPMNEdge_' + edge.from + '-' + edge.to, bpmnElement: edge.from + '-' + edge.to }, 'omgdi:waypoint': [{ $: { x: '0', y: '0' } }, { $: { x: '0', y: '100' } }] })) }] }] }
  return { content: new Builder({ renderOpts: { pretty: false }, xmldec: { version: '1.0', encoding: 'UTF-8' } }).buildObject({ definitions }), edges }
}
