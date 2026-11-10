import { asObject,RsqError,type JsonObject } from './core.js'
import { validateFeatures } from './access.js'
const categories = ['all','task','project','doc','file','archive','recycle']
const typeCategory: Record<string,string> = { todo: 'task',todo_comment: 'task',kanban: 'project',child_kanban: 'project',kanban_card: 'project',kanban_item: 'project',kanban_item_comment: 'project',corpus: 'doc',noteBook: 'doc',summary: 'doc',summary_comment: 'doc',folder: 'file',file: 'file',archive_bag: 'archive' }
const categoryFeature: Record<string,string> = { project: 'PLAN',doc: 'KNOWLEDGE',file: 'CLOUD_LIB',archive: 'ARCHIVE' }
function allowed(results: JsonObject) {
  const simple = asObject(results.user).isSimpleUiUser === true,permissions = asObject(results.authorities),accepted: string[] = []
  for (const category of categories.slice(1)) {
    if (simple && ['doc','file','archive'].includes(category)) continue
    try { validateFeatures(categoryFeature[category] ? [categoryFeature[category]] : [],results.functions,permissions);accepted.push(category) } catch (error) { if (!(error instanceof RsqError) || !['FEATURE_DISABLED','FEATURE_UPGRADE_REQUIRED','FEATURE_FORBIDDEN'].includes(error.code)) throw error }
  }
  return accepted
}
const rows = (value: unknown): JsonObject[] => { if (!Array.isArray(value)) throw new RsqError('INVALID_RESPONSE','搜索列表上下文无效。',5);return value.map(asObject) }
function categoryOf(row: JsonObject) { return row.isNotDisplay === 'archive' ? 'archive' : row.isNotDisplay === 'recycle_bin' ? 'recycle' : typeCategory[String(row.type)] }
function item(row: JsonObject) {
  const keys = ['selfId','type','name','description','pIsDone','isSubTask','isNotDisplay','corpusType','contentType'],output: JsonObject = Object.fromEntries(keys.filter(key => row[key] != null).map(key => [key,row[key]])),parent = asObject(row.parentIds),parents: JsonObject = {}
  for (const key of ['todo','kanban','child_kanban','kanban_card','kanban_item','corpus','summary']) if (parent[key] != null) {
    if (typeof parent[key] === 'number' && !Number.isSafeInteger(parent[key])) throw new RsqError('INVALID_RESPONSE','搜索父资源 ID 超出安全整数范围。',5)
    parents[key] = String(parent[key])
  }
  if (typeof row.selfId === 'number' && !Number.isSafeInteger(row.selfId) || !['string','number'].includes(typeof row.selfId) || !String(row.selfId)) throw new RsqError('INVALID_RESPONSE','搜索资源 ID 缺失或不精确。',5)
  output.selfId = String(row.selfId);output.parentIds = parents
  output.resource = row.type === 'todo' ? { command: 'task context inspect',input: { taskId: output.selfId } } : row.type === 'todo_comment' ? { command: 'task context inspect',input: { taskId: parents.todo } } : row.type === 'kanban_item' || row.type === 'kanban_item_comment' ? { command: 'task context inspect',input: { taskId: row.type === 'kanban_item' ? output.selfId : parents.kanban_item,projectId: parents.kanban } } : { type: row.type,id: output.selfId,...parents }
  return output
}
function visible(row: JsonObject,accepted: string[]) {
  const category = categoryOf(row),base = typeCategory[String(row.type)]
  return category != null && accepted.includes(category) && (base == null || accepted.includes(base)) && !['daily','week','monthly','month'].includes(String(row.corpusType))
}
export function prepareSearch(kind: string,input: JsonObject,results: JsonObject): JsonObject {
  const accepted = allowed(results),category = String(input.type ?? 'all')
  if (typeof input.keyword !== 'string' || !input.keyword.trim() || input.keyword.length > 512) throw new RsqError('INVALID_INPUT','搜索词须为非空文本，最多 512 字。',2)
  if (!categories.includes(category) || category !== 'all' && !accepted.includes(category)) throw new RsqError('FEATURE_FORBIDDEN','当前 UI 或公司功能不允许搜索这种业务。',4,{ type: category,available: accepted })
  if (kind === 'search-query') return { query: { keyword: input.keyword,from: input.offset ?? 0,size: input.limit ?? 20,...(['task','doc','file','archive','recycle'].includes(category) && { type: ({ task: 'todo',doc: 'corpus',file: 'file',archive: 'archive',recycle: 'recycleBin' } as Record<string,string>)[category] }) } }
  if (kind === 'search-suggest') return { query: { keyword: input.keyword } }
  if (kind === 'search-safe-project-suggestions') return { query: { keyword: input.keyword,from: 0,size: 100 } }
  throw new RsqError('INVALID_CONTRACT','未知搜索上下文。',6)
}
export function describeSearch(input: JsonObject,results: JsonObject) {
  const accepted = allowed(results),filter = (values: unknown) => rows(values).filter(row => visible(row,accepted)).map(item)
  if (results.suggestions) {
    const suggestions = asObject(results.suggestions),safe = new Map(filter(asObject(results.safeProjects).result).filter(row => categoryOf(row) === 'project').map(row => [String(row.type)+':'+row.selfId,row]))
    const groups = Object.fromEntries([['task','todo'],['project','kanban'],['doc','corpus'],['file','file'],['archive','archive'],['recycle','recycleBin']].map(([category,key]) => [category,category === 'project' ? rows(suggestions[key]).flatMap(row => safe.has(String(row.type)+':'+String(row.selfId)) ? [safe.get(String(row.type)+':'+String(row.selfId))] : []) : filter(suggestions[key])]))
    return { availableTypes: accepted,groups,previewOnly: true,projectVerificationWindow: { sourceOffset: 0,sourceLimit: 100,complete: rows(asObject(results.safeProjects).result).length < 100 },relatedCommand: 'search query' }
  }
  if (!results.page) return { availableTypes: accepted,filters: { keyword: '必填，非空，最多 512 字；按后端 multi_match 匹配',type: categories,offset: '底层 from，按原始返回条数推进；过滤后的空页不代表结束',limit: '1–100，缺省 20' },limits: ['当前搜索索引覆盖任务、项目、笔记、文件、档案和回收站；不宣称独立 OKR/绩效/流程/复盘索引','成员筛选被后端忽略，未暴露','项目分类通过带成员过滤的全类型查询后筛选；保留底层分页游标','每个目标资源的操作仍核对实时权限；搜索索引可能延迟'] }
  const page = asObject(results.page),offset = Number(input.offset ?? 0),limit = Number(input.limit ?? 20),raw = rows(page.result)
  if (page.from !== offset || page.size !== limit || raw.length > limit) throw new RsqError('INVALID_RESPONSE','搜索分页回执与请求不一致。',5)
  const selected = filter(raw).filter(row => input.type == null || input.type === 'all' || categoryOf(row) === input.type)
  if (raw.length === limit && offset+limit > 9900) throw new RsqError('PAGINATION_LIMIT','搜索达到当前显式结果窗口，结果尚未穷尽；请缩小搜索词或业务类型。',5,{ offset,limit,sourceCount: raw.length })
  return { items: selected,sourceCount: raw.length,offset,limit,hasMore: raw.length === limit,nextOffset: raw.length === limit ? offset+limit : null,availableTypes: accepted,filteredCount: raw.length-selected.length,exhausted: raw.length < limit }
}
