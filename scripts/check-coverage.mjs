import { validateStatisticsDrilldownWorkflow } from '../dist/statistics-drilldown.js'
import { validateUsageWorkflow } from '../dist/usage-runtime.js'
import { validateWorkflowDatasheetWorkflow } from '../dist/workflow-datasheet.js'
import { validateTaskCreationVisibility } from '../dist/task-creation-readback.js'
import { validateTaskTypeTransitionWorkflow } from '../dist/task-type-transition.js'
import { validateReplayNavigationWorkflow } from '../dist/replay-navigation.js'
import { validateFileLibraryQuitWorkflow } from '../dist/file-library-quit.js'
import { validateReplayCollectionConfigWorkflow } from '../dist/replay-collection-config.js'
import { validateProjectExcelWorkflow } from '../dist/project-excel-import.js'
import { validateProjectImportWorkflow } from '../dist/project-import.js'
import { builtinCommands } from '../dist/builtins.js'
import { validateAiConfigWorkflow } from '../dist/ai-config.js'
import { validateOkrPerformanceWorkflow } from '../dist/okr-performance.js'
import { validateOkrIndicatorWorkflow } from '../dist/okr-indicators.js'
import { validateDeveloperWorkflow } from '../dist/developer.js'
import { validateAutomationWorkflow } from '../dist/automation.js'
import { validateWorkflowWait } from '../dist/workflows.js'
import { validateOkrActionWorkflow } from '../dist/okr-actions.js'
import { validateReplayTopicWorkflow } from '../dist/replay-topic.js'
import { validateAiMarketWorkflow } from '../dist/ai-market.js'
import { validateOkrStatisticsWorkflow } from '../dist/okr-statistics.js'
import { validateOkrAlignmentWorkflow } from '../dist/okr-alignment.js'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import Ajv from 'ajv'
import { validateMinderWorkflow } from '../dist/minder.js'
import { validateDocWorkflow } from '../dist/doc-context.js'
import { validateCloudFileWorkflow } from '../dist/cloud-file.js'
import { validateAppraisalWorkflow } from '../dist/appraisal-context.js'
import { validateSignatureWorkflow } from '../dist/signature.js'
import { validateProjectScheduleWorkflow } from '../dist/project-schedule.js'
import { validateTaskAuditWorkflow } from '../dist/task-audit.js'
import { validateDatasheetAdminWorkflow } from '../dist/datasheet-admin.js'
import { validateDatasheetRecordsWorkflow } from '../dist/datasheet-records.js'
import { validateDatasheetTargetWorkflow } from '../dist/datasheet-target.js'
import { validateWorkflowStepObservation } from '../dist/workflow-lifecycle.js'
import { validateWorkflowTaskWorkflow } from '../dist/workflow-tasks.js'
import { validateProjectCardBatchWorkflow } from '../dist/project-card-batch.js'

const read = file => JSON.parse(readFileSync(new URL('../contracts/' + file, import.meta.url), 'utf8'))
export function auditWorkflows(definition, catalog, businessScope) {
  const issues = [], ajv = new Ajv({ strict: false, allErrors: true }), ids = new Set()
  const commands = new Set(catalog.operations.map(o => o.command)), rank = { read: 0, write: 1, destructive: 2 }
  const discoverable = new Set([...builtinCommands.map(command => command.command), ...commands, ...(definition.workflows ?? []).map(flow => flow.command)])
  for (const domain of businessScope?.domains ?? []) for (const cap of domain.capabilities) for (const id of cap.builtinCommands ?? []) if (!builtinCommands.some(command => command.id === id)) issues.push('unknown builtin binding: ' + domain.id + '/' + cap.id + ' -> ' + id)
  for (const flow of definition.workflows ?? []) {
    try { validateWorkflowStepObservation(flow) } catch { issues.push('invalid workflow step observation binding: ' + flow.id) }
    try { validateDatasheetTargetWorkflow(flow) } catch { issues.push('invalid datasheet project binding: '+flow.id) }
    for (const step of flow.steps) try { validateTaskCreationVisibility(flow, step) } catch { issues.push('invalid new task visibility readback: '+flow.id) }
    for (const related of flow.relatedCommands ?? []) if (!discoverable.has(related) && !/^rsq coverage [a-z-]+(?: [a-z-]+)?$/.test(related)) issues.push('unknown related command: ' + flow.id + ' -> ' + related)
    if (!flow.id || ids.has(flow.id) || commands.has(flow.command)) issues.push('duplicate workflow: ' + flow.id)
    ids.add(flow.id)
    if (!/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)+$/.test(flow.command)) issues.push('invalid workflow command: ' + flow.id)
    for (const command of commands) if (command.startsWith(flow.command + ' ') || flow.command.startsWith(command + ' ')) issues.push('workflow command/group collision: ' + flow.id)
    commands.add(flow.command)
    try { ajv.compile(flow.inputSchema) } catch { issues.push('invalid workflow schema: ' + flow.id) }
    const parameters = flow.parameters ?? [], properties = flow.inputSchema?.properties ?? {}
    if (new Set(parameters.map(p => p.name)).size !== parameters.length || new Set(parameters.map(p => p.option)).size !== parameters.length) issues.push('duplicate workflow parameter: ' + flow.id)
    if (Object.keys(properties).some(name => !parameters.some(p => p.name === name))) issues.push('missing workflow flag: ' + flow.id)
    for (const param of parameters) if (JSON.stringify(param.schema) !== JSON.stringify(properties[param.name])) issues.push('workflow flag/schema mismatch: ' + flow.id + ' ' + param.name)
    if (!flow.examples?.length || !flow.methods?.length || !flow.capabilities?.length || !flow.steps?.length) issues.push('incomplete workflow metadata: ' + flow.id)
    for (let index = 0; index < flow.steps.length; index++) { try { validateWorkflowWait(flow, index) } catch { issues.push('invalid asynchronous creation wait: ' + flow.id) } }
    const steps = new Set()
    if (flow.executor === 'arms-usage') { try { validateUsageWorkflow(flow) } catch { issues.push('invalid ARMS usage workflow executor: '+flow.id) } }
    else if (flow.executor === 'document') { try { validateDocWorkflow(flow) } catch { issues.push('invalid document workflow executor: '+flow.id) } }
    else if (flow.executor === 'cloud-file') { try { validateCloudFileWorkflow(flow) } catch { issues.push('invalid cloud file workflow executor: '+flow.id) } }
    else if (flow.executor === 'datasheet-records') { try { validateDatasheetRecordsWorkflow(flow) } catch { issues.push('invalid datasheet records workflow executor: '+flow.id) } }
    else if (flow.executor === 'datasheet-admin') { try { validateDatasheetAdminWorkflow(flow) } catch { issues.push('invalid datasheet management workflow executor: '+flow.id) } }
    else if (flow.executor === 'minder') { try { validateMinderWorkflow(flow) } catch { issues.push('invalid minder workflow executor: '+flow.id) } }
    else if (flow.executor === 'appraisal') { try { validateAppraisalWorkflow(flow) } catch { issues.push('invalid appraisal workflow executor: '+flow.id) } }
    else if (flow.executor === 'signature') { try { validateSignatureWorkflow(flow) } catch { issues.push('invalid signature executor: '+flow.id) } }
    else if (flow.executor === 'project-schedule') { try { validateProjectScheduleWorkflow(flow) } catch { issues.push('invalid project schedule executor: '+flow.id) } }
    else if (flow.executor === 'okr-actions') { try { validateOkrActionWorkflow(flow) } catch { issues.push('invalid okr action executor: '+flow.id) } }
    else if (flow.executor === 'replay-topic') { try { validateReplayTopicWorkflow(flow) } catch { issues.push('invalid replay topic executor: '+flow.id) } }
    else if (flow.executor === 'ai-market') { try { validateAiMarketWorkflow(flow) } catch { issues.push('invalid AI market executor: '+flow.id) } }
    else if (flow.executor === 'okr-performance') { try { validateOkrPerformanceWorkflow(flow) } catch { issues.push('invalid OKR performance executor: '+flow.id) } }
    else if (flow.executor === 'okr-indicators') { try { validateOkrIndicatorWorkflow(flow) } catch { issues.push('invalid OKR indicator executor: '+flow.id) } }
    else if (flow.executor === 'replay-navigation') { try { validateReplayNavigationWorkflow(flow) } catch { issues.push('invalid replay navigation executor: '+flow.id) } }
    else if (flow.executor === 'file-library-quit') { try { validateFileLibraryQuitWorkflow(flow) } catch { issues.push('invalid library quit executor: '+flow.id) } }
    else if (flow.executor === 'statistics-drilldown') { try { validateStatisticsDrilldownWorkflow(flow) } catch { issues.push('invalid statistics drilldown executor: '+flow.id) } }
    else if (flow.executor === 'workflow-tasks') { try { validateWorkflowTaskWorkflow(flow) } catch { issues.push('invalid workflow task field executor: '+flow.id) } }
    else if (flow.executor === 'workflow-datasheet') { try { validateWorkflowDatasheetWorkflow(flow) } catch { issues.push('invalid workflow datasheet executor: '+flow.id) } }
    else if (flow.executor === 'task-type-transition') { try { validateTaskTypeTransitionWorkflow(flow) } catch { issues.push('invalid task type transition executor: '+flow.id) } }
    else if (flow.executor === 'project-card-batch') { try { validateProjectCardBatchWorkflow(flow) } catch { issues.push('invalid project card batch executor: '+flow.id) } }
    else if (flow.executor === 'replay-collection-config') { try { validateReplayCollectionConfigWorkflow(flow) } catch { issues.push('invalid replay collection configuration executor: '+flow.id) } }
    else if (flow.executor === 'project-excel') { try { validateProjectExcelWorkflow(flow) } catch { issues.push('invalid project Excel import executor: '+flow.id) } }
    else if (flow.executor === 'project-import') { try { validateProjectImportWorkflow(flow) } catch { issues.push('invalid project import executor: '+flow.id) } }
    else if (flow.executor === 'ai-config') { try { validateAiConfigWorkflow(flow) } catch { issues.push('invalid AI config executor: '+flow.id) } }
    else if (flow.executor === 'developer') { try { validateDeveloperWorkflow(flow) } catch { issues.push('invalid developer executor: '+flow.id) } }
    else if (flow.executor === 'automation') { try { validateAutomationWorkflow(flow) } catch { issues.push('invalid automation executor: '+flow.id) } }
    else if (flow.executor === 'okr-statistics') { try { validateOkrStatisticsWorkflow(flow) } catch { issues.push('invalid OKR statistics executor: '+flow.id) } }
    else if (flow.executor === 'okr-alignment') { try { validateOkrAlignmentWorkflow(flow) } catch { issues.push('invalid okr alignment executor: '+flow.id) } }
    else if (flow.executor === 'task-audit') { try { validateTaskAuditWorkflow(flow) } catch { issues.push('invalid task audit workflow executor: '+flow.id) } }
    else if (flow.executor && (flow.executor !== 'organization' || !['list', 'context', 'create', 'switch', 'update', 'lifecycle-context', 'transfer', 'remove'].includes(flow.organizationAction))) issues.push('invalid workflow executor: ' + flow.id)
    const checkReferences = value => {
      if (!value || typeof value !== 'object') return
      if (value.$result && !steps.has(value.$result.split('/')[1])) issues.push('workflow result referenced before availability: ' + flow.id + ' ' + value.$result)
      if (value.$input && !Object.hasOwn(properties, value.$input.split('/')[1])) issues.push('unknown workflow input reference: ' + flow.id + ' ' + value.$input)
      for (const child of Object.values(value)) checkReferences(child)
    }
    for (const step of flow.steps ?? []) {
      const op = catalog.operations.find(o => o.id === step.operationId)
      if (!op) issues.push('missing workflow operation: ' + flow.id + ' ' + step.operationId)
      else {
        if (!(flow.effect in rank) || rank[flow.effect] < rank[op.effect]) issues.push('workflow understates side effects: ' + flow.id)
        if (flow.methods?.some(m => !op.methods.includes(m))) issues.push('workflow identity mismatch: ' + flow.id)
      }
      checkReferences(step.input)
      if (step.readback && (op?.effect !== 'read' || op?.idempotency !== 'idempotent' || !step.verify && !step.assertions?.length || step.forEach || step.transfer || step.resources || !Number.isInteger(step.readback.attempts) || step.readback.attempts < 1 || step.readback.attempts > 5 || !Number.isInteger(step.readback.delayMs) || step.readback.delayMs < 50 || step.readback.delayMs > 2000)) issues.push('invalid bounded readback: ' + flow.id + ' ' + step.id)
      if (step.collectPages) {
        const pages = step.collectPages, query = op?.inputSchema?.properties?.query?.properties
        if (op?.method !== 'GET' || op?.effect !== 'read' || op?.idempotency !== 'idempotent' || op?.response !== 'json' || step.forEach || step.transfer || step.resources || step.readback || !Number.isInteger(pages.limit) || pages.limit < 1 || pages.limit > 100 || !['frontId','lastDataId','lastId','cursor'].includes(pages.cursorParameter) || pages.cursorField !== 'id' || pages.pageSizeParameter !== 'max' || !query?.max || !query[pages.cursorParameter]) issues.push('invalid bounded pagination: ' + flow.id + ' ' + step.id)
      }
      if (step.expectAbsent) {
        const index = flow.steps.indexOf(step), previous = flow.steps[index-1], removed = catalog.operations.find(operation => operation.id === previous?.operationId)
        if (op?.method !== 'GET' || op.effect !== 'read' || op.route !== '/task/v3/kanban/risk/{id}' || removed?.method !== 'DELETE' || removed.route !== op.route || previous.prepare || step.prepare || JSON.stringify(previous.input) !== JSON.stringify(step.input) || step.forEach || step.collectPages || step.transfer || step.readback || step.resources) issues.push('invalid independent absence assertion: '+flow.id)
      }
      if (step.authentication && (step.authentication !== 'cookie' || flow.executor !== 'organization' || step.id !== 'exchanged' || op?.route !== '/task/login/authAjax' || op?.method !== 'GET' || !steps.has('changed'))) issues.push('invalid workflow session exchange: ' + flow.id)
      if (step.transfer && (step.transfer !== 'storage-upload' || op?.route !== '/task/sts/token/oss' || op?.method !== 'GET' || !steps.has('certificate') || (!steps.has('secondPass') && !(flow.executor === 'signature' && flow.signatureAction === 'upload')) || step.prepare || step.forEach || flow.effect === 'read')) issues.push('invalid storage transfer context: ' + flow.id)
      if (step.forEach) {
        checkReferences({ $result: step.forEach.path })
        if (step.prepare || !Number.isInteger(step.forEach.limit) || step.forEach.limit < 1 || step.forEach.limit > 1000) issues.push('invalid workflow iteration: ' + flow.id)
      } else if (JSON.stringify(step.input).includes('"$item"')) issues.push('workflow item referenced outside iteration: ' + flow.id)
      if (step.prepare) {
        const datasheet = ['record-create', 'record-update', 'record-delete', 'view-update', 'view-create', 'view-copy', 'view-delete', 'field-create', 'field-update', 'field-convert', 'field-delete'].includes(step.prepare) && steps.has('context') && op?.route === '/task/mt/resource/apply/changesets'
          || step.prepare === 'datasheet-context-bound' && ['targetIdentity', 'targetProject', 'targetModules'].every(id => steps.has(id)) && op?.method === 'GET' && op?.route === '/task/mt/datasheet/{datasheetId}/dataPack'
          || step.prepare === 'datasheet-related-project' && steps.has('context') && op?.method === 'GET' && op?.route === '/task/v1/kanbanCrud'
          || step.prepare === 'datasheet-related-modules' && ['context', 'relatedProject'].every(id => steps.has(id)) && op?.method === 'GET' && op?.route === '/task/v1/kanbanChildCrud/list'
          || step.prepare === 'datasheet-related-context' && ['context', 'relatedProject', 'relatedModules'].every(id => steps.has(id)) && op?.method === 'GET' && op?.route === '/task/mt/datasheet/{datasheetId}/dataPack'
          || step.prepare === 'datasheet-project-context' && steps.has('context') && op?.method === 'GET' && op?.route === '/task/v1/kanbanCrud'
          || step.prepare === 'datasheet-project-modules' && steps.has('context') && op?.method === 'GET' && op?.route === '/task/v1/kanbanChildCrud/list'
          || step.prepare === 'datasheet-import-verify' && steps.has('write') && op?.method === 'GET' && op?.route === '/task/v1/kanbanChildCrud/list'
        const archiveRoutes = {
          'okr-views-preferences-update': ['PUT', '/task/okr/config', ['user', 'config', 'preflightConfig']],
          'okr-views-publicity-inspect': ['GET', '/task/okr/kanban', ['user', 'directory']],
          'okr-views-publicity-readback': ['GET', '/task/okr/kanban', ['user', 'directory', 'preflightDirectory']],
          ...Object.fromEntries([
            ['create', 'POST', '/kanban'], ['rename', 'PUT', '/kanban'], ['key-results', 'PUT', '/kanban'], ['move', 'PUT', '/kanban/sort'], ['remove', 'DELETE', '/kanban'],
            ['card-create', 'POST', '/kanbanCard'], ['card-configure', 'PUT', '/kanbanCard'], ['card-move', 'PUT', '/kanbanCard/sort'], ['card-remove', 'DELETE', '/kanbanCard'],
          ].map(([action, method, route]) => ['okr-views-publicity-' + action, [method, '/task/okr' + route, ['user', 'directory', 'preflightDirectory', ...(action === 'create' ? [] : ['before', 'preflight']), ...(['card-create', 'card-configure'].includes(action) ? ['cycles', 'tree'] : [])]]])),
          ...Object.fromEntries([
            ['open', 'POST', '/plan/item'], ['close', 'DELETE', '/plan/item'], ['move', 'PUT', '/plan/item/sort'],
          ].map(([action, method, route]) => ['okr-views-plan-' + action, [method, '/task/okr' + route, ['user', 'tree', 'items', 'preflightItems']]])),
          'okr-views-plan-list': ['GET', '/task/okr/objective/list', ['user', 'tree', 'cycles']],
          'okr-views-plan-superiors': ['GET', '/task/okr/objective/superior/list', ['user', 'tree', 'cycles']],
          ...Object.fromEntries(['company', 'kanban', 'corpus', 'lib', 'archive'].flatMap(module => [
            ['list', 'GET', '/task/authority/v3/role/' + module, ['user', 'permissions', 'state', 'features']],
            ['permissions', 'GET', '/task/authority/v3/authorities/' + module, ['user', 'permissions', 'state', 'features', 'roles']],
            ...['create', 'rename', 'remove'].filter(() => ['company', 'kanban', 'corpus'].includes(module)).map(action => [action, action === 'create' ? 'POST' : action === 'remove' ? 'DELETE' : 'PUT', '/task/authority/v3/role/' + module, ['roles', 'preflightRoles', 'preflightPermissions']]),
            ...['set', 'batch-set'].map(action => [action, 'PUT', '/task/authority/v3/authorities/' + module + (action === 'batch-set' ? '/batch' : ''), ['roles', 'authorities', 'preflightRoles', 'preflightPermissions', 'preflightAuthorities']]),
          ].map(([action, method, route, required]) => ['company-roles-' + module + '-' + action, [method, route, required]]))),
          'identity-settings-profile-update': ['POST', '/task/v1/userSetting/changeUserInfo', ['current', 'preflight']],
          'identity-settings-preferences-update': ['POST', '/task/v1/userSetting/changeUserVariable', ['current', 'preflight']],
          'identity-settings-contact-display-update': ['POST', '/task/v1/userSetting/changeUserVariable', ['current', 'preflight']],
          'archive-resource-items': ['GET', '/task/v1/archiveFile/list', ['bags']],
          'archive-resource-target-items': ['GET', '/task/v1/archiveFile/list', ['bags']],
          'archive-resource-task-detail': ['GET', '/task/api/v3/task', ['bags']],
          'archive-resource-task-project': ['GET', '/task/v1/kanbanCrud', ['bags', 'task']],
          'archive-resource-task-permissions': ['GET', '/task/api/v3/task/editcontrol', ['bags', 'task', 'preflight', 'preflightTask']],
          'archive-resource-task-before-restore': ['GET', '/task/api/v3/task', ['bags', 'items']],
          'archive-resource-task-source': ['GET', '/task/api/v3/task', ['task', 'changed']],
          'archive-resource-task-archive': ['POST', '/task/api/v3/task/archive', ['bags', 'task', 'project', 'items', 'preflight', 'preflightTask', 'permissions']],
          'archive-resource-items-move': ['POST', '/task/v1/archiveFile/batchMove', ['bags', 'items', 'targetItems', 'preflight', 'preflightItems']],
          'archive-resource-items-remove': ['DELETE', '/task/v1/archiveFile', ['bags', 'items', 'preflight', 'preflightItems']],
          'archive-resource-task-restore': ['POST', '/task/v1/archiveFile', ['bags', 'items', 'task', 'preflight', 'preflightItems', 'preflightTask']],
          'archive-group-children': ['GET', '/task/v1/archiveGroup/list', ['groups']],
          'archive-group-create': ['POST', '/task/v1/archiveGroup', ['groups']],
          'archive-group-create-parent': ['GET', '/task/v1/archiveGroup/list', ['created', 'verifiedGroups', 'verifiedRoot']],
          'archive-group-rename': ['PUT', '/task/v1/archiveGroup', ['groups', 'preflightGroups']],
          'archive-group-remove': ['DELETE', '/task/v1/archiveGroup', ['groups', 'bags', 'children', 'preflightGroups', 'preflightChildren']],
          'archive-bag-create': ['POST', '/task/v1/archiveBag', ['groups', 'bags']],
          'archive-items': ['GET', '/task/v1/archiveFile/list', ['bags']],
          'archive-items-context': ['GET', '/task/v1/department/list', ['bags']],
          'archive-items-filter-directory': ['GET', '/task/v1/department/list', ['bags']],
          'archive-bag-items-before': ['GET', '/task/v1/archiveFile/list', ['bags']],
          'archive-bag-rename': ['PUT', '/task/v1/archiveBag', ['bags', 'preflight']],
          'archive-bag-move': ['POST', '/task/v1/archiveBag/move', ['groups', 'bags', 'preflight']],
          'archive-bag-members': ['PUT', '/task/v1/archiveBag', ['bags', 'roles', 'directory', 'preflight']],
          'archive-bag-role': ['POST', '/task/v1/archiveBag/updateUserRole', ['bags', 'roles', 'preflight']],
          'archive-bag-leave': ['POST', '/task/v1/archiveBag/quit', ['bags', 'preflight']],
          'archive-bag-remove': ['DELETE', '/task/v1/archiveBag', ['bags', 'items', 'preflight', 'preflightItems']],
        }
        const archiveRoute = archiveRoutes[step.prepare], archive = archiveRoute?.[0] === op?.method && archiveRoute?.[1] === op?.route && archiveRoute[2].every(id => steps.has(id))
        const cooperationRoutes = {
          'cooperation-tasks-members': ['GET', '/task/api/v3/cooperation/members', []],
          'cooperation-tasks-participants': ['GET', '/task/api/v3/cooperation/participants', []],
          'cooperation-tasks-creator': ['GET', '/task/api/v3/cooperation/creator', []],
          'cooperation-tasks-approvals': ['GET', '/task/api/v3/cooperation/approvals', []],
          'cooperation-workflow-discover': ['POST', '/task/workflow/process/info/task/list', ['state', 'features', 'authorities', 'directory']],
          'cooperation-workflow-list': ['POST', '/task/workflow/process/info/task/list', ['state', 'features', 'authorities', 'directory', 'available']],
        }
        const cooperationRoute = cooperationRoutes[step.prepare], cooperation = cooperationRoute?.[0] === op?.method && cooperationRoute?.[1] === op?.route && cooperationRoute[2].every(id => steps.has(id))
        const companyStatisticsRoutes = {
          'company-usage-list': ['/task/v1/team/useStatistical', ['user', 'directory']],
          'statistics-company-workflow-analyze': ['/task/workflow/teamStatistics/execute', ['directory', 'groups', 'applications']],
          'statistics-company-workflow-detail': ['/task/workflow/teamStatistics/executeDetail', ['analysis']],
          'statistics-company-okr-analyze-person': ['/task/okr/statistics/reportForms', ['cycles', 'directory']],
          'statistics-company-okr-analyze-dept': ['/task/okr/statistics/reportForms', ['cycles', 'directory']],
          'statistics-company-okr-detail-person': ['/task/okr/statistics/reportForms/item', ['cycles', 'directory', 'analysis']],
          'statistics-company-okr-detail-dept': ['/task/okr/statistics/reportForms/item', ['cycles', 'directory', 'analysis']],
        }
        const companyStatisticsRoute = companyStatisticsRoutes[step.prepare]
        const statistics = companyStatisticsRoute && op?.method === 'GET' && op?.route === companyStatisticsRoute[0] && companyStatisticsRoute[1].every(id => steps.has(id))
          || step.prepare === 'statistics-chart-create' && op?.method === 'POST' && op?.route === '/task/v5/kanban/stats/chart'
          || steps.has('before') && (step.prepare === 'statistics-chart-update' && op?.method === 'PUT' && op?.route === '/task/v5/kanban/stats/chart'
          || step.prepare === 'statistics-chart-layout' && op?.method === 'PUT' && op?.route === '/task/v5/kanban/stats/chart/position')
        const workspaceTask = ['workspace-task-action', 'workspace-task-execution'].includes(step.prepare) && op?.method === 'POST' && op?.route === '/task/api/v3/task' && ['views', 'groups', 'memberScope'].every(id => steps.has(id)) && (step.prepare === 'workspace-task-action' || ['mode', 'selectedFilters'].every(id => steps.has(id)))
        const actionRoutes = { 'action-context': ['GET', '/task/okr/action/group/list'], 'action-filters': ['GET', '/task/okr/action/view/filter'], 'action-group-add': ['POST', '/task/okr/action/group'],
          'action-group-rename': ['PUT', '/task/okr/action/group'], 'action-group-remove': ['DELETE', '/task/okr/action/group'], 'action-group-reorder': ['PUT', '/task/okr/action/group/sort'],
          'action-groups-verify': ['GET', '/task/okr/action/group/list'], 'action-view-update': ['PUT', '/task/okr/action/view'], 'action-group-count': ['GET', '/task/okr/action/group/taskCount/list'], 'action-group-tasks': ['GET', '/task/okr/action/group/task/list'] }
        const actionRoute = actionRoutes[step.prepare], action = steps.has('views') && actionRoute?.[0] === op?.method && actionRoute?.[1] === op?.route
        if (action && ['action-context', 'action-filters'].includes(step.prepare)) steps.add('actionQuery')
        const collectionRoutes = {
          'collection-fields-create': ['POST', '/task/project/collection/field/projectListHeader', ['visible', 'collection', 'headers', 'preflight']],
          'collection-fields-update': ['POST', '/task/project/collection/field/projectListHeader', ['visible', 'collection', 'headers', 'preflight']],
          'collection-fields-remove': ['POST', '/task/project/collection/field/projectListHeader', ['visible', 'collection', 'headers', 'preflight']],
          'collection-fields-visibility': ['POST', '/task/project/collection/field/projectListHeader', ['visible', 'collection', 'headers', 'preflight']],
          'collection-fields-move': ['POST', '/task/project/collection/field/projectListHeader', ['visible', 'collection', 'headers', 'preflight']],
          'collection-fields-readback': ['GET', '/task/project/collection/field/projectListHeader', ['visible', 'collection', 'headers', 'changed']],
          'collection-fields-value': ['PUT', '/task/project/collection/field/value', ['visible', 'collection', 'headers', 'beforeProjects', 'directory', 'preflight', 'projects']],
          'collection-create': ['POST', '/task/v3/kanbanCollection', ['directory']], 'collection-update': ['PUT', '/task/v3/kanbanCollection', ['before', 'preflight']],
          'collection-members': ['PUT', '/task/v3/kanbanCollection', ['before', 'directory', 'preflight']], 'collection-delete': ['DELETE', '/task/v3/kanbanCollection', ['before']],
          'collection-project-add': ['POST', '/task/v3/kanbanCollectionKanban/addKanban', ['projects', 'available']],
          'collection-project-remove': ['DELETE', '/task/v3/kanbanCollectionKanban/removeKanban', ['projects']],
          'collection-project-context': ['GET', '/task/v1/kanbanChildCrud/list', ['projects']],
          'collection-roadmap-plans-card': ['GET', '/task/project/collection/roadMap/planList', ['projects']],
          'collection-roadmap-plans-milestone': ['GET', '/task/project/collection/roadMap/planList', ['projects']],
          'collection-roadmap-items': ['GET', '/task/api/projectCollection/roadmap/' + (flow.command.includes('milestones') ? 'milestoneTasks' : 'cards'), ['projects', 'modules', 'plans']],
          'collection-stage-context': ['GET', '/task/v3/kanbanCollection', ['modules']],
          'collection-workload': ['GET', '/task/api/projectCollection/workload', ['before', 'directory']],
          'collection-workload-statistics': ['GET', '/task/api/projectCollection/workload/statisticsList', ['workload', 'directory']],
          'collection-workload-tasks': ['GET', '/task/api/projectCollection/workload/tasks', ['visible', 'directory']],
          'collection-settings-roadmap': ['PUT', '/task/v3/kanbanCollection/roadMap/updateSetting', ['visible', 'before']],
          'collection-settings-schedule': ['PUT', '/task/v3/kanbanCollection/progress/updateSetting', ['visible', 'before']],
          'collection-settings-workload': ['PUT', '/task/v3/kanbanCollection/person/updateSetting', ['visible', 'before', 'collection', 'directory']],
          'collection-baseline-membership': ['GET', '/task/v3/kanbanCollection/progress/baseLine', ['baselines']],
          'collection-workflow-progress': ['GET', '/task/workflow/process/info/listByProjectCollectionId', ['visible', 'headers']],
          'collection-move': ['POST', '/task/v3/kanbanCollection/sort', ['visible']],
        }
        const collectionRoute = collectionRoutes[step.prepare], collection = collectionRoute?.[0] === op?.method && collectionRoute?.[1] === op?.route && collectionRoute[2].every(id => steps.has(id))
        const workflowRoutes = {
          'replay-push-rule-company-permissions': ['GET', '/task/authority/v3/authorities/company/current', ['identity']],
          'replay-push-rule-okr-permissions': ['GET', '/task/okr/role/replay/permission/current', ['identity']],
          'replay-push-rule-intelligence': ['GET', '/task/replay-intelligence/replay/intelligence/whitelist', ['identity']],
          'replay-push-rule-collections': ['GET', '/task/review/replay/config/collect/list', ['identity', 'companyPermissions', 'okrPermissions', 'intelligence']],
          'replay-push-rule-list': ['GET', '/task/replay-intelligence/replay/push/rule/list', ['identity', 'intelligence', 'collections']],
          'replay-push-rule-detail': ['GET', '/task/replay-intelligence/replay/push/rule', ['identity', 'intelligence', 'collections', 'rules']],
          'replay-push-rule-created-readback': ['GET', '/task/replay-intelligence/replay/push/rule', ['identity', 'changed']],
          'replay-push-rule-readback': ['GET', '/task/replay-intelligence/replay/push/rule', ['identity', 'before', 'changed']],
          'replay-push-rule-create': ['POST', '/task/replay-intelligence/replay/push/rule', ['identity', 'intelligence', 'collections', 'rules']],
          'replay-push-rule-update': ['PUT', '/task/replay-intelligence/replay/push/rule', ['identity', 'intelligence', 'collections', 'rules', 'before']],
          'replay-push-rule-remove': ['DELETE', '/task/replay-intelligence/replay/push/rule', ['identity', 'intelligence', 'collections', 'rules', 'before']],
          'replay-push-rule-preview': ['POST', '/task/replay-intelligence/replay/push/rule/preview', ['identity', 'intelligence', 'collections', 'rules', 'before']],
          'replay-push-rule-test-send': ['POST', '/task/replay-intelligence/replay/push/rule/test-send', ['identity', 'intelligence', 'collections', 'rules', 'before']],
          'workflow-statistics-applications': ['GET', '/task/workflow/application/list', ['user']],
          'workflow-statistics-source': ['GET', '/task/workflow/application', ['user', 'applications']],
          'workflow-statistics-steps': ['GET', '/task/workflow/step/info/names', ['source']],
          'workflow-statistics-indicator': ['GET', '/task/workflow/statistics/indicator', ['user', 'source', 'steps', 'directory', 'range']],
          'workflow-statistics-efficiency': ['GET', '/task/workflow/statistics/efficiency', ['user', 'source', 'steps', 'directory', 'range']],
          'workflow-statistics-execute': ['GET', '/task/workflow/statistics/execute', ['user', 'source', 'steps', 'directory', 'range']],
          'workflow-template-apply': ['POST', '/task/workflow/application', ['templates', 'groups', 'covers']],
          'workflow-application-clone': ['POST', '/task/workflow/application/copy', ['source', 'groups']],
          'workflow-application-rename': ['PUT', '/task/workflow/application', ['source']],
          'workflow-application-remove': ['DELETE', '/task/workflow/application', ['source']],
          'workflow-form-describe': ['GET', '/task/workflow/form', ['source', 'forms']],
          'workflow-form-clone': ['GET', '/task/workflow/form/form/copy', ['source', 'forms', 'original']],
          'workflow-lifecycle-form-context': ['GET', '/task/workflow/form', ['source', 'forms']],
          'workflow-lifecycle-form-create': ['POST', '/task/workflow/form', ['source']],
          'workflow-lifecycle-form-replace': ['PUT', '/task/workflow/form', ['source', 'forms', 'original']],
          'workflow-lifecycle-field-add': ['PUT', '/task/workflow/form', ['source', 'forms', 'original']],
          'workflow-lifecycle-field-edit': ['PUT', '/task/workflow/form', ['source', 'forms', 'original']],
          'workflow-lifecycle-field-remove': ['PUT', '/task/workflow/form', ['source', 'forms', 'original']],
          'workflow-lifecycle-form-remove': ['DELETE', '/task/workflow/form', ['source', 'forms', 'steps']],
          'workflow-lifecycle-step-create': ['POST', '/task/workflow/step/info', ['source', 'steps']],
          'workflow-lifecycle-step-edit': ['PUT', '/task/workflow/step/info', ['source', 'forms', 'steps']],
          'workflow-lifecycle-step-remove': ['DELETE', '/task/workflow/step/info', ['source', 'steps']],
          'workflow-lifecycle-deploy': ['POST', '/task/workflow/step/info/adjust/close', ['source', 'steps']],
          'workflow-lifecycle-graph-apply': ['POST', '/task/workflow/step/info/adjust/save', ['source', 'steps', 'arrangement']],
          'workflow-lifecycle-start': ['POST', '/task/workflow/process/info/start', ['source', 'steps']],
          'workflow-lifecycle-instance-form': ['GET', '/task/workflow/process/info/step/list/auditsAndForms', ['process', 'instanceStep']],
          'workflow-lifecycle-step-timing': ['POST', '/task/workflow/process/info/sheet/stepUseTimeList', ['process', 'instanceStep']],
          'workflow-lifecycle-step-tasks': ['POST', '/task/workflow/process/info/sheet/taskList', ['process', 'instanceStep']],
          'workflow-lifecycle-fill': ['PUT', '/task/workflow/process/info/form', ['process', 'instanceStep', 'instanceForm']],
          'workflow-lifecycle-validate': ['PUT', '/task/workflow/formulaValidate', ['process', 'instanceStep', 'instanceForm', 'actions']],
          'workflow-lifecycle-signature': ['GET', '/task/file/signature/getFront', ['process', 'instanceStep', 'actions']],
          'workflow-lifecycle-signature-file': ['GET', '/task/v1/folder/file', ['process', 'instanceStep', 'actions', 'signature']],
          'workflow-lifecycle-act': ['PUT', '/task/workflow/process/info/step/operate/status', ['process', 'instanceStep', 'instanceForm', 'actions', 'validated', 'reverse']],
          'workflow-lifecycle-close': ['POST', '/task/workflow/process/info/close', ['process']],
          'workflow-lifecycle-reopen': ['GET', '/task/workflow/process/info/activate', ['process']],
          'workflow-lifecycle-transfer': ['POST', '/task/workflow/process/info/step/transfer/user', ['process', 'instanceStep']],
        }
        const workflowRoute = workflowRoutes[step.prepare], workflow = workflowRoute?.[0] === op?.method && workflowRoute?.[1] === op?.route && workflowRoute[2].every(id => steps.has(id))
        if (workflow && ['workflow-lifecycle-step-timing', 'workflow-lifecycle-step-tasks'].includes(step.prepare)) steps.add('lifecycle')
        const okrRoutes = {
          'okr-cycle-create': ['POST', '/task/okr/cycle', ['cycleAuthority', 'cycles', 'archived']],
          'okr-cycle-change': ['PUT', '/task/okr/cycle', ['cycleAuthority', 'cycles', 'archived']],
          'okr-cycle-impact': ['GET', '/task/okr/objective/count', ['cycleAuthority', 'cycles', 'archived']],
          'okr-cycle-remove': ['DELETE', '/task/okr/cycle', ['cycleAuthority', 'cycles', 'archived', 'cycleImpact']],
          'okr-cycle-archive': ['PUT', '/task/okr/cycle/archive', ['cycleAuthority', 'cycles', 'archived']],
          'okr-cycle-restore': ['PUT', '/task/okr/cycle/archive/revert', ['cycleAuthority', 'cycles', 'archived']],
          'okr-cycle-default-set': ['PUT', '/task/okr/cycle/default', ['cycles', 'archived']],
          'okr-objective-create': ['POST', '/task/okr/objective', ['cycles', 'scopes']],
          'okr-objective-list': ['GET', '/task/okr/objective/list', ['cycles']],
          'okr-planning-superiors': ['GET', '/task/okr/objective/superior/list', ['cycles']],
          'okr-objective-rename': ['PUT', '/task/okr/objective', ['before']],
          'okr-objective-description': ['PUT', '/task/okr/objective', ['before']],
          'okr-objective-progress': ['PUT', '/task/okr/objective', ['before']],
          'okr-objective-remove': ['DELETE', '/task/okr/objective', ['before', 'selectable']],
          'okr-result-add': ['POST', '/task/okr/keyResult', ['before']],
          'okr-result-readback': ['GET', '/task/okr/objective', ['before', 'changed']],
          'okr-result-rename': ['PUT', '/task/okr/keyResult', ['before']],
          'okr-result-progress': ['PUT', '/task/okr/keyResult', ['before']],
          'okr-result-remove': ['DELETE', '/task/okr/keyResult', ['before']],
        }
        const okrRoute = okrRoutes[step.prepare], okr = okrRoute?.[0] === op?.method && okrRoute?.[1] === op?.route && okrRoute[2].every(id => steps.has(id))
        const delivery = '/task/files/deliverable', deliverableRoutes = {
          'deliverable-task-context': ['GET', '/task/api/deliverable/files', ['project', 'modules', 'task']],
          'deliverable-task-link': ['POST', '/task/api/deliverable/file/association', ['project', 'modules', 'task', 'taskFiles', 'latestTaskFiles', 'file']],
          'deliverable-task-unlink': ['DELETE', '/task/api/deliverable/file/association', ['project', 'modules', 'task', 'taskFiles', 'latestTaskFiles', 'file']],
          'deliverable-module-enable': ['POST', '/task/project/plan/deliverable/open', ['modules']],
          'deliverable-module-disable': ['POST', '/task/project/plan/deliverable/close', ['modules']],
          'deliverable-tree': ['GET', delivery + '/category/tree', ['modules']],
          'deliverable-category-list': ['GET', delivery + '/category/list', ['modules', 'tree', 'baselines']],
          'deliverable-category-create': ['POST', delivery + '/category', ['modules', 'tree']],
          'deliverable-category-rename': ['PUT', delivery + '/category', ['modules', 'tree']],
          'deliverable-category-remove': ['DELETE', delivery + '/category', ['modules', 'tree']],
          'deliverable-category-move': ['POST', delivery + '/category/move', ['modules', 'tree']],
          'deliverable-category-users': ['GET', delivery + '/category/users', ['modules', 'tree', 'baselines']],
          'deliverable-baseline-list': ['GET', delivery + '/baseline/list', ['modules']],
          'deliverable-baseline-create': ['POST', delivery + '/baseline', ['modules']],
          'deliverable-baseline-rename': ['PUT', delivery + '/baseline', ['modules', 'baselines']],
          'deliverable-baseline-remove': ['DELETE', delivery + '/baseline', ['modules', 'baselines']],
          'deliverable-files-list': ['GET', delivery + '/file/list', ['modules', 'tree', 'baselines']],
          'deliverable-file-verify': ['GET', delivery + '/file', ['modules', 'file']],
          'deliverable-file-number': ['PUT', delivery + '/file/basicInfo', ['modules', 'file']],
          'deliverable-file-move': ['POST', delivery + '/file/category', ['modules', 'tree', 'file']],
          'deliverable-file-membership-list': ['GET', delivery + '/file/list', ['modules', 'tree', 'file']],
          'deliverable-file-removal-list': ['GET', delivery + '/file/list', ['modules', 'tree', 'file']],
          'deliverable-file-remove': ['DELETE', delivery + '/file', ['modules', 'tree', 'file', 'membership']],
          'deliverable-version-snapshot': ['POST', delivery + '/file/version/create', ['modules', 'file']],
          'deliverable-version-update': ['PUT', delivery + '/file/version', ['modules', 'file']],
          'deliverable-upload-second-pass': ['POST', delivery + '/file/upload/secondPass', ['modules', flow.command.endsWith('file replace') ? 'file' : 'tree']],
          'deliverable-upload-certificate': ['GET', '/task/sts/token/oss', ['modules', 'secondPass']],
          'deliverable-upload-register': ['POST', delivery + '/file/upload', ['modules', 'tree', 'secondPass', 'stored']],
          'deliverable-upload-replace': ['PUT', delivery + '/file', ['modules', 'file', 'secondPass', 'stored']],
          'deliverable-upload-readback': ['GET', delivery + '/file', ['modules', 'secondPass', 'changed']],
        }
        const deliverableRoute = deliverableRoutes[step.prepare], deliverable = deliverableRoute?.[0] === op?.method && deliverableRoute?.[1] === op?.route && deliverableRoute[2].every(id => steps.has(id))
        const libraryRoutes = {
          'library-create': ['POST', '/task/v1/folder', ['roles']],
          'library-created-readback': ['GET', '/task/v1/folder', ['changed']],
          'library-update': ['PUT', '/task/v1/folder/{id}', ['before']],
          'library-members-add': ['PUT', '/task/v1/folder/{id}', ['before']],
          'library-members-remove': ['PUT', '/task/v1/folder/{id}', ['before']],
          'library-member-role': ['POST', '/task/v1/folder/updateUserRole', ['before', 'roles']],
          'library-owner-transfer': ['POST', '/task/v1/folder/updateUserRole', ['before', 'roles']],
          'library-join': ['PUT', '/task/v1/folder/join', ['before']],
          'library-reorder': ['PUT', '/task/v1/folder/sort', ['before', 'libraries']],
          'library-remove': ['DELETE', '/task/v1/folder/{id}', ['before', 'libraries']],
        }
        const libraryRoute = libraryRoutes[step.prepare], library = libraryRoute?.[0] === op?.method && libraryRoute?.[1] === op?.route && libraryRoute[2].every(id => steps.has(id))
        const replayStatisticsRoutes = {
          'replay-stat-cards': ['GET', '/task/review/stat/list', ['companyPermissions', 'okrPermissions']],
          'replay-stat-collection': ['GET', '/task/review/replay/collect', ['cards']],
          'replay-stat-members': ['GET', '/task/review/replay/collect/member/list', ['collection']],
          'replay-stat-members-filtered': ['GET', '/task/review/replay/collect/member/list', ['collection', 'members']],
          'replay-stat-report': ['GET', '/task/review/stat/report', ['collection', 'members', 'filteredMembers']],
          'replay-stat-reminder-report': ['GET', '/task/review/stat/report', ['collection', 'members', 'filteredMembers']],
          'replay-stat-verified-report': ['GET', '/task/review/stat/report', ['report', 'reminded']],
          'replay-stat-totals': ['GET', '/task/review/stat/report/other', ['collection', 'members', 'filteredMembers', 'report']],
          'replay-stat-commit-rank': ['GET', '/task/review/stat/commit/rank', ['collection', 'members', 'filteredMembers']],
          'replay-stat-like-rank': ['GET', '/task/review/stat/like/rank', ['collection', 'members', 'filteredMembers']],
          'replay-stat-remind': ['POST', '/task/review/remind/uncommitted', ['collection', 'members', 'filteredMembers', 'report']],
        }
        const replayStatisticsRoute = replayStatisticsRoutes[step.prepare], replayStatistics = replayStatisticsRoute?.[0] === op?.method && replayStatisticsRoute?.[1] === op?.route && replayStatisticsRoute[2].every(id => steps.has(id))
        const replayCreatedTaskRoutes = {
          'replay-created-tasks-list': ['GET', '/task/review/replay/component/task/create/list', ['report', 'collection']],
          'replay-created-tasks-preflight-list': ['GET', '/task/review/replay/component/task/create/list', ['report', 'collection', 'before', 'preflight']],
          'replay-created-tasks-create': ['POST', '/task/review/replay/component/task/create', ['report', 'collection', 'before', 'templates', 'directory', 'preflight', 'preflightTasks']],
          'replay-created-tasks-readback': ['GET', '/task/review/replay/component/task/create/list', ['report', 'collection', 'before', 'changed']],
          'replay-created-tasks-task': ['GET', '/task/api/v3/task', ['report', 'collection', 'before', 'changed', 'verified']],
        }
        const replayCreatedTaskRoute = replayCreatedTaskRoutes[step.prepare], replayCreatedTask = replayCreatedTaskRoute?.[0] === op?.method && replayCreatedTaskRoute?.[1] === op?.route && replayCreatedTaskRoute[2].every(id => steps.has(id))
        const replayOkrRoutes = {
          'replay-okr-relations-list': ['GET', '/task/review/replay/component/okr/list', ['report', 'collection']],
          'replay-okr-relations-preflight-list': ['GET', '/task/review/replay/component/okr/list', ['report', 'collection', 'before', 'preflight']],
          'replay-okr-relations-source': ['GET', '/task/okr/objective', ['report', 'collection', 'before']],
          'replay-okr-relations-retained-source': ['GET', '/task/okr/objective', ['report', 'collection', 'before', 'changed', 'verified']],
          'replay-okr-relations-link': ['POST', '/task/review/replay/component/okr', ['report', 'collection', 'before', 'source', 'sourcePreflight', 'preflight', 'preflightRelations']],
          'replay-okr-relations-text': ['PUT', '/task/review/replay/component/okr/text', ['report', 'collection', 'before', 'preflight', 'preflightRelations']],
          'replay-okr-relations-unlink': ['DELETE', '/task/review/replay/component/okr', ['report', 'collection', 'before', 'source', 'preflight', 'preflightRelations']],
          'replay-okr-relations-progress': ['PUT', '/task/review/replay/component/okr', ['report', 'collection', 'before', 'source', 'sourcePreflight', 'preflight', 'preflightRelations']],
          'replay-okr-relations-refresh': ['GET', '/task/review/replay/component/okr/list/latest', ['report', 'collection', 'before', 'sourceRoots', 'preflight', 'preflightRelations']],
          'replay-okr-relations-readback': ['GET', '/task/review/replay/component/okr/list', ['report', 'collection', 'before', 'changed']],
        }
        const replayOkrRoute = replayOkrRoutes[step.prepare], replayOkr = replayOkrRoute?.[0] === op?.method && replayOkrRoute?.[1] === op?.route && replayOkrRoute[2].every(id => steps.has(id))
        const replayRelationsRoutes = {
          'replay-relations-list': ['GET', '/task/review/replay/component/task/import/list', ['report', 'collection']],
          'replay-relations-preflight-list': ['GET', '/task/review/replay/component/task/import/list', ['report', 'collection', 'before', 'preflight']],
          'replay-relations-link': ['POST', '/task/review/replay/component/task/import', ['report', 'collection', 'before', 'task', 'preflight', 'preflightTasks']],
          'replay-relations-unlink': ['DELETE', '/task/review/replay/component/task/import', ['report', 'collection', 'before', 'preflight', 'preflightTasks']],
          'replay-relations-text': ['PUT', '/task/review/replay/component/task/import/text', ['report', 'collection', 'before', 'preflight', 'preflightTasks']],
          'replay-relations-refresh': ['GET', '/task/review/replay/component/task/import/list/latest', ['report', 'collection', 'before', 'sourceTasks', 'preflight', 'preflightTasks']],
          'replay-relations-readback': ['GET', '/task/review/replay/component/task/import/list', ['report', 'collection', 'before', 'changed']],
          'replay-relations-retained-task': ['GET', '/task/api/v3/task', ['report', 'collection', 'before', 'changed', 'verified']],
        }
        const replayRelationsRoute = replayRelationsRoutes[step.prepare], replayRelations = replayRelationsRoute?.[0] === op?.method && replayRelationsRoute?.[1] === op?.route && replayRelationsRoute[2].every(id => steps.has(id))
        const replayRoutes = {
          'replay-created-template': ['GET', '/task/review/replay/collect/template', ['changed']],
          'replay-company-permissions': ['GET', '/task/authority/v3/authorities/company/current', []],
          'replay-okr-permissions': ['GET', '/task/okr/role/replay/permission/current', []],
          'replay-created-collection': ['GET', '/task/review/replay/collect', ['changed']],
          'replay-template-component-add': ['PUT', '/task/review/replay/collect/template', ['template']],
          'replay-template-component-configure': ['PUT', '/task/review/replay/collect/template', ['template']],
          'replay-template-rename': ['PUT', '/task/review/replay/collect/template', ['template']],
          'replay-template-question-add': ['PUT', '/task/review/replay/collect/template', ['template']],
          'replay-template-question-update': ['PUT', '/task/review/replay/collect/template', ['template']],
          'replay-template-component-remove': ['PUT', '/task/review/replay/collect/template', ['template']],
          'replay-template-reorder': ['PUT', '/task/review/replay/collect/template', ['template']],
          'replay-template-remove': ['DELETE', '/task/review/replay/collect/template', ['template', 'collections', 'collectionDetails']],
          'replay-collection-create': ['POST', '/task/review/replay/collect', ['template']],
          'replay-collection-rename': ['PUT', '/task/review/replay/collect', ['collection']],
          'replay-collection-remove': ['DELETE', '/task/review/replay/collect', ['collection']],
          'replay-report-collection': ['GET', '/task/review/replay/collect', ['report']],
          'replay-period-context': ['GET', '/task/review/replay', ['collection']],
          'replay-report-create': ['PUT', '/task/review/replay', ['collection', 'report']],
          'replay-changed-readback': ['GET', '/task/review/replay', ['collection', 'changed']],
          'replay-question-set': ['PUT', '/task/review/replay/component/question', ['collection', 'report']],
          'replay-submit': ['PUT', '/task/review/replay/status', ['collection', 'report', 'records', 'intelligence']],
          'replay-score-evaluate': ['POST', '/task/replay-intelligence/replay/ai-score/evaluate', ['collection', 'report', 'intelligence']],
          'replay-score-context': ['GET', '/task/replay-intelligence/replay/ai-score', ['collection', 'report', 'intelligence']],
          'replay-withdraw': ['PUT', '/task/review/replay/status', ['collection', 'report', 'records']],
          'replay-approve': ['PUT', '/task/review/replay/status', ['collection', 'report', 'records']],
          'replay-reject': ['PUT', '/task/review/replay/status', ['collection', 'report', 'records']],
          'replay-reopen': ['PUT', '/task/review/replay/status', ['collection', 'report', 'records']],
          'replay-like-set': ['PUT', '/task/review/replay/like', ['collection', 'report']],
        }
        const replayRoute = replayRoutes[step.prepare], replay = replayRoute?.[0] === op?.method && replayRoute?.[1] === op?.route && replayRoute[2].every(id => steps.has(id))
        const applicationRoutes = {
          'application-identity': ['GET', '/task/ordercenter/v2/member/state/independent', ['identity']],
          'application-sync': ['GET', '/task/v1/' + (flow.command.startsWith('appraisal ') ? 'performance' : 'okr') + '/list', ['identity']],
          'application-visible': ['GET', '/task/performance/init', ['identity', 'synchronized', 'departments']],
          'application-performance-init': ['POST', '/task/performance/init', ['before', 'synchronized', 'departments']],
          'application-okr-init': ['GET', '/task/okr/objective/sidebar', ['members', 'synchronized']],
        }
        const applicationRoute = applicationRoutes[step.prepare], application = applicationRoute?.[0] === op?.method && applicationRoute?.[1] === op?.route && applicationRoute[2].every(id => steps.has(id))
        const taskRoutes = {
          'deliverable-task-read': ['GET', '/task/api/v3/task', ['project', 'modules']],
          'task-context-template-cover': ['GET', '/task/v4/template', ['project']],
          'task-context-project-definition': ['GET', '/task/api/v3/template', ['project', 'modules', 'available']],
          'task-context-project-create': ['POST', '/task/api/v3/task', ['project', 'modules', 'moduleDetail', 'cards', 'available', 'cardPermissions', 'memberScope', 'creationTemplate', 'creationLabels']],
          'task-context-list': ['GET', '/task/api/v3/template/settingList', []],
          'task-context-get': ['GET', '/task/api/v3/template', ['available']],
          'task-context-permissions': ['GET', '/task/api/v3/task/editcontrol', ['project', 'task']],
          'task-context-values': ['GET', '/task/api/v3/task/template', ['project', 'task']],
          'task-context-create': ['POST', '/task/api/v3/template', ['company', 'available']],
          'task-context-configure': ['PUT', '/task/api/v3/template', ['company', 'available', 'original']],
          'task-context-default-label-catalogue': ['GET', '/task/v1/kanbanLabel/list', ['project', 'available', 'original']],
          'task-context-default-label-catalogue-if-needed': ['GET', '/task/v1/kanbanLabel/list', ['available', 'original']],
          'task-context-default-label-cover-fresh': ['GET', '/task/v4/template', ['defaultLabelProjectFresh']],
          'task-context-default-labels': ['PUT', '/task/api/v3/template', ['company', 'available', 'original', 'defaultLabels', 'defaultLabelIdentityFresh', 'defaultLabelProjectFresh', 'defaultLabelCoverFresh', 'defaultLabelCompanyFresh', 'defaultLabelAvailableFresh', 'defaultLabelDefinitionFresh', 'defaultLabelsFresh']],
          'task-context-field-add': ['PUT', '/task/api/v3/template', ['company', 'available', 'original']],
          'task-context-field-edit': ['PUT', '/task/api/v3/template', ['company', 'available', 'original']],
          'task-context-field-remove': ['PUT', '/task/api/v3/template', ['company', 'available', 'original']],
          'task-context-remove': ['DELETE', '/task/api/v3/template', ['company', 'available', 'original']],
          'task-context-default': ['PUT', '/task/api/v3/template', ['project', 'available', 'original']],
          'task-context-availability': ['PUT', '/task/v3/taskTemplate/updateStatus', ['project', 'company', 'available', 'original']],
          'task-context-field-set': ['PUT', '/task/api/v3/task/template/field', ['project', 'task', 'values']],
          'task-context-attachment-check': ['GET', '/task/files/file/upload/check', ['project', 'task', 'values']],
          'task-context-attachment-second-pass': ['POST', '/task/v1/folder/file/secondPass', ['uploadCheck', 'task', 'values']],
          'task-context-attachment-certificate': ['GET', '/task/sts/token/oss', ['secondPass']],
          'task-context-attachment-register': ['POST', '/task/v1/folder/file/getAliFile', ['secondPass', 'stored']],
          'task-context-attachment-file': ['GET', '/task/v1/folder/file', ['secondPass', 'changed']],
          'task-context-attachment-latest': ['GET', '/task/api/v3/task/template', ['file', 'values']],
          'task-context-attachment-bind': ['PUT', '/task/api/v3/task/template/field', ['file', 'latestValues', 'values']],
          'task-context-attachment-remove': ['PUT', '/task/api/v3/task/template/field', ['task', 'values']],
          'file-item-recycle-list': ['GET', '/task/v1/recycleBin/list', []],
          'file-item-remove': ['DELETE', '/task/v1/folder/file', ['file']],
          'file-item-purge': ['DELETE', '/task/v1/recycleBin', ['entries']],
          'personal-favorite-add-link': ['POST', '/task/v3/myCollection', ['items']],
          'personal-favorite-add-file': ['POST', '/task/v3/myCollection', ['items','file']],
          'personal-favorite-add-doc': ['POST', '/task/v3/myCollection', ['items']],
          'personal-favorite-remove': ['DELETE', '/task/v3/myCollection', ['items']],
          'personal-favorite-move': ['PUT', '/task/v3/myCollection/sort', ['items']],
          'personal-inspiration-create': ['POST', '/task/v1/inspiration', ['items']],
          'personal-inspiration-update': ['PUT', '/task/v1/inspiration', ['items']],
          'personal-inspiration-move': ['PUT', '/task/v1/inspiration', ['items']],
          'personal-inspiration-remove': ['DELETE', '/task/v1/inspiration', ['items']],
          'notice-company': ['PUT', '/task/v3/notification/saveForEveryone', ['user','order','authorities','settings']],
          ...Object.fromEntries([
            ['detail', 'GET', '/task/api/v3/task', []],
            ['project', 'GET', '/task/v1/kanbanCrud', ['task']],
            ['template-cover', 'GET', '/task/v4/template', ['task','project']],
            ['permissions', 'GET', '/task/api/v3/task/editcontrol', ['task','project','templateCover']],
            ['values', 'GET', '/task/api/v3/task/template', ['task','permissions']],
            ['label-project-catalogue', 'GET', '/task/v1/kanbanLabel/list', ['task','permissions']],
            ['label-personal-catalogue', 'GET', '/task/v1/todoLabel/list', ['task','permissions']],
            ['children', 'GET', '/task/api/v3/task/subs', ['task','permissions']],
            ['create-personal', 'POST', '/task/api/v3/task', ['memberScope']],
            ['update', 'PUT', '/task/api/v3/task', ['task','permissions','values']],
            ['members', 'PUT', '/task/api/v3/task', ['task','permissions','memberScope']],
            ['dates', 'PUT', '/task/api/v3/task', ['task','permissions']],
            ['child-create', 'POST', '/task/api/v3/task', ['task','permissions','memberScope']],
            ['remove', 'DELETE', '/task/api/v3/task', ['task','permissions']],
            ['recycle', 'GET', '/task/v1/recycleBin/list', ['changed']],
            ['comment-list', 'GET', '/task/api/v3/comment/list', ['task','permissions']],
            ['comment-data', 'GET', '/task/api/v3/comment/data', ['task','permissions']],
            ['comment-add', 'POST', '/task/api/v3/comment', ['task','permissions','commentContext']],
            ['comment-remove', 'DELETE', '/task/api/v3/comment', ['task','permissions','comments']],
            ['comment-notification', 'POST', '/task/api/v3/comment/data', ['task','permissions']],
            ['labels', 'PUT', '/task/api/v3/task', ['task','permissions','labels']],
            ['label-create', 'POST', '/task/v1/kanbanLabel', ['task','permissions','labels']],
            ['label-configure', 'PUT', '/task/v1/kanbanLabel', ['task','permissions','labels']],
            ['label-remove', 'DELETE', '/task/v1/kanbanLabel', ['task','permissions','labels']],
            ['reminders', 'PUT', '/task/api/v3/task', ['task','permissions','values']],
            ['repeat-set', 'PUT', '/task/api/v3/task', ['task','permissions']],
            ['repeat-clear', 'PUT', '/task/api/v3/task', ['task','permissions']],
          ].map(([action, method, route, required]) => ['task-business-' + action, [method, route, ['GET','HEAD','OPTIONS'].includes(method) || action === 'create-personal' ? required : [...required, 'templateCoverFresh']]])),
          'task-business-personal-library-list': ['GET', '/task/v1/todoLabel/userLabels', ['identity']],
          'task-business-personal-library-create': ['POST', '/task/v1/todoLabel', ['identity','labels','identityFresh','labelsFresh']],
          'task-business-personal-library-update': ['PUT', '/task/v1/todoLabel', ['identity','labels','identityFresh','labelsFresh']],
          'task-business-personal-library-remove': ['DELETE', '/task/v1/todoLabel', ['identity','labels','identityFresh','labelsFresh']],
          'task-context-apply': ['PUT', '/task/api/v3/task', ['project', 'task', 'taskPermissions', 'taskTemplates']],
          'task-context-milestones': ['GET', '/task/api/project/overview/mileStoneInfo', ['project', 'available']],
          'task-context-card-permissions': ['GET', '/task/api/v3/projectTask/cardEditControl', ['project', 'modules']],
          'task-context-module-detail': ['GET', '/task/v1/kanbanChildCrud', ['project', 'modules']],
          'task-context-milestone-create': ['POST', '/task/api/v3/task', ['project', 'available', 'modules', 'moduleDetail', 'cards', 'cardPermissions']],
          'task-context-milestone-update': ['PUT', '/task/api/v3/task', ['project', 'task', 'taskPermissions']],
          'task-context-milestone-complete': ['PUT', '/task/api/v3/task', ['project', 'task', 'taskPermissions', 'values']],
          'task-context-milestone-remove': ['DELETE', '/task/api/v3/task', ['project', 'task', 'taskPermissions']],
          ...Object.fromEntries(['', 'template-'].flatMap(prefix => [
            ['module', 'GET', '/task/v1/kanbanChildCrud', ['project', 'modules']],
            ['list', 'GET', '/task/v1/kanbanCardCrud/list', ['project', 'modules']],
            ['get', 'GET', '/task/v1/kanbanCardCrud', ['project', 'modules', 'moduleDetail', 'cards']],
            ['create', 'POST', '/task/v1/kanbanCardCrud', ['project', 'modules', 'moduleDetail', 'cards']],
            ['rename', 'PUT', '/task/v1/kanbanCardCrud', ['project', 'modules', 'moduleDetail', 'cards']],
            ['remove', 'DELETE', '/task/v1/kanbanCardCrud', ['project', 'modules', 'moduleDetail', 'cards']],
          ].map(([action, method, route, required]) => ['task-context-card-' + prefix + action, [method, route, required]]))),
        }
        const taskRoute = taskRoutes[step.prepare], task = taskRoute?.[0] === op?.method && taskRoute?.[1] === op?.route && taskRoute[2].every(id => steps.has(id))
        const noticeRoutes = ['', 'objective/', 'workflow/', 'plan/'].flatMap(app => {
          const prefix = app ? '/task/v3/' + app + 'notification' : '/task/v1/notification'
          return [
            ['notice-read', 'PUT', prefix + '/setToRead', ['items']],
            ['notice-bulk', 'POST', prefix + '/setAllToRead', []],
            ['notice-bulk', 'PUT', prefix + '/clear', []],
            ['notice-setting-' + ({ '': 'common', 'objective/': 'okr', 'workflow/': 'workflow', 'plan/': 'project' })[app], 'PUT', prefix + '/updateOptionModule', ['user','settings']],
            ...['list','unReadList', ...(app ? ['atList'] : [])].flatMap(endpoint => [['notice-page', 'GET', prefix + '/' + endpoint, []], ...['normal','at','confirm'].map(type => ['notice-filter-page-' + type, 'GET', prefix + '/' + endpoint, []])]),
          ]
        }).concat(['atList','confirmList'].flatMap(endpoint => [['notice-page', 'GET','/task/v3/notification/' + endpoint, []], ...['normal','at','confirm'].map(type => ['notice-filter-page-' + type, 'GET','/task/v3/notification/' + endpoint, []])]))
        const notice = noticeRoutes.some(([action, method, route, required]) => action === step.prepare && method === op?.method && route === op?.route && required.every(id => steps.has(id)))
        const executionActions = {
          scope: ['GET', ['/task/execution/v2/view/list'], ['departments', 'staffGroups']],
          filters: ['GET', ['/task/execution/v2/view/filter', '/task/execution/v2/view/filter/selected', '/task/execution/v2/view/field/list'], ['mode', 'views', 'departments', 'staffGroups']],
          'selected-fields': ['GET', ['/task/execution/v2/view/field/selectedList'], ['mode', 'views', 'departments', 'staffGroups']],
          groups: ['PUT', ['/task/execution/v2/group/list'], ['mode', 'views', 'selectedFilters']],
          counts: ['PUT', ['/task/execution/v2/item/count'], ['mode', 'views', 'selectedFilters', 'groups']],
          ...Object.fromEntries(['items', 'source-items', 'target-items', 'verify-items'].map(action => [action, ['PUT', ['/task/execution/v2/item/list'], ['mode', 'views', 'selectedFilters', 'groups']]])),
          'view-update': ['PUT', ['/task/execution/v2/view'], ['mode', 'views', 'filters', 'selectedFilters']],
          ...Object.fromEntries([['create', 'POST'], ['rename', 'PUT'], ['remove', 'DELETE'], ['order', 'PUT']].map(([action, method]) => ['group-' + action, [method, ['/task/execution/v2/group' + (action === 'order' ? '/sort' : '')], ['mode', 'views', 'groups', 'selectedFilters']]])),
          'fields-set': ['PUT', ['/task/execution/v2/view/field'], ['mode', 'views', 'fields', 'selectedFilters']],
          'fields-order': ['PUT', ['/task/execution/v2/view/field/sort'], ['mode', 'views', 'selectedFields', 'selectedFilters']],
          'item-move': ['PUT', ['/task/execution/v2/item/move'], ['mode', 'views', 'groups', 'sourceItems', 'targetItems', 'selectedFilters']],
          'mode-set': ['PUT', ['/task/execution/v2/company/displayMode'], ['mode']],
        }
        const executionRoute = step.prepare.startsWith('execution-') && executionActions[step.prepare.slice('execution-'.length)]
        const execution = executionRoute && executionRoute[0] === op?.method && executionRoute[1].includes(op?.route) && executionRoute[2].every(id => steps.has(id))
        const contactRoutes = {
          'contact-department-create': ['POST', '/task/v1/department'], 'contact-department-update': ['PUT', '/task/v1/department/{id}'],
          'contact-department-remove': ['DELETE', '/task/v1/department/{id}'], 'contact-department-move': ['POST', '/task/v1/department/sort'],
          'contact-departments-set': ['PUT', '/task/v1/department/batchChangeDepartment'], 'contact-group-create': ['POST', '/task/v1/staffGroupCrud'],
          'contact-group-rename': ['PUT', '/task/v1/staffGroupCrud'], 'contact-group-remove': ['DELETE', '/task/v1/staffGroupCrud/{id}'],
          'contact-group-move': ['PUT', '/task/v1/staffGroup/sort'], 'contact-group-member-add': ['POST', '/task/v1/staffGroup/addStaffs'],
          'contact-group-member-remove': ['DELETE', '/task/v1/staffGroup/removeStaffs'],
          'contact-group-context': ['GET', '/task/v1/staffGroupCrud/{id}'],
        }
        const contactRoute = contactRoutes[step.prepare], contact = contactRoute?.[0] === op?.method && contactRoute?.[1] === op?.route && (step.prepare === 'contact-group-context' ? steps.has('groups') : ['user','authorities','tree'].every(key => steps.has(key))) && (!step.prepare.startsWith('contact-group-') || steps.has('groups'))
        const taskHours = ['task-hours-add','task-hours-remove','task-hours-clear'].includes(step.prepare) && op?.method === 'PUT' && op?.route === '/task/api/v3/task/template/field' && ['task','values','templateCoverFresh'].every(key => steps.has(key))
        const efficiencyRoutes = { 'efficiency-settings': ['PUT','/task/api/v3/userTodoSetting',['before']], 'efficiency-productivity': ['GET','/task/mainCommon/taskStatistics',[]], 'efficiency-task-detail': ['GET','/task/api/v3/task',[]], 'efficiency-task-project': ['GET','/task/v1/kanbanCrud',['task']], 'efficiency-count': ['GET','/task/v1/tomato/count',['task','project']], 'efficiency-complete': ['POST','/task/v1/tomato/add',['task','project','before','beforeCount']], 'efficiency-abandon': ['POST','/task/v1/tomato/abandon',['task','project','before']] }
        const efficiencyRoute = efficiencyRoutes[step.prepare], efficiency = efficiencyRoute?.[0] === op?.method && efficiencyRoute?.[1] === op?.route && efficiencyRoute[2].every(id => steps.has(id))
        const search = ['search-query','search-suggest','search-safe-project-suggestions'].includes(step.prepare) && ['user','order','functions','authorities'].every(id => steps.has(id)) && op?.method === 'GET' && op?.route === (step.prepare === 'search-suggest' ? '/task/v1/search/preSearch' : '/task/v1/search/searchAll')
        const projectContextRoutes = {
          'project-context-risk-module-open': ['POST','/task/v3/kanban/risk/open',['identity','project','modules']],
          'project-context-risk-module-close': ['POST','/task/v3/kanban/risk/close',['identity','project','modules']],
          'project-context-risk-matrix': ['GET','/task/v3/kanban/risk/matrix',['identity','project','modules']],
          'project-context-risk-list': ['GET','/task/v3/kanban/risk/list',['identity','project','modules']],
          'project-context-risk-target': ['GET','/task/v3/kanban/risk/{id}',['identity','project','modules']],
          'project-context-risk-verify-created': ['GET','/task/v3/kanban/risk/{id}',['identity','project','modules','created']],
          'project-context-risk-task-list': ['PUT','/task/api/v3/projectTask/taskList',['identity','project','modules','before']],
          'project-context-risk-task-permissions': ['GET','/task/api/v3/projectTask/cardEditControl',['identity','project','modules','before']],
          'project-context-risk-task-templates': ['GET','/task/api/v3/template/settingList',['identity','project','modules','before']],
          'project-context-risk-task-create': ['POST','/task/api/v3/task',['identity','project','modules','before','directory','templates','cardPermissions','company','functions']],
          'project-context-risk-task-readback': ['GET','/task/api/v3/task',['identity','project','modules','before','createdTask']],
          'project-context-risk-create': ['POST','/task/v3/kanban/risk',['identity','project','modules','matrix','directory']],
          'project-context-risk-update': ['PUT','/task/v3/kanban/risk/{id}',['identity','project','modules','before','matrix','directory']],
          'project-context-risk-actions': ['GET','/task/v3/kanban/risk/actions',['identity','project','modules','before']],
          'project-context-risk-progress-current': ['GET','/task/v3/kanban/risk/progress/current',['identity','project','modules','before','verifiedRisk']],
          'project-context-risk-progress-list': ['GET','/task/v3/kanban/risk/progress/list',['identity','project','modules','before']],
          'project-context-risk-progress-create': ['POST','/task/v3/kanban/risk/progress',['identity','project','modules','before']],
          'project-context-risk-progress-remove': ['DELETE','/task/v3/kanban/risk/progress',['identity','project','modules','before']],
          'project-context-alteration-module-detail': ["GET", "/task/v1/kanbanChildCrud", ["identity", "project", "modules"]],
          'project-context-alteration-context': ["GET", "/task/workflow/alteration/config/list", ["identity", "project", "modules"]],
          'project-context-alteration-applications': ["GET", "/task/workflow/alteration/flowApplicationList", ["identity", "project", "modules"]],
          'project-context-alteration-module-open': ["POST", "/task/v3/kanban/alteration/open", ["identity", "project", "modules"]],
          'project-context-alteration-module-close': ["POST", "/task/v3/kanban/alteration/close", ["identity", "project", "modules", "module"]],
          'project-context-alteration-templates': ["GET", "/task/v4/template/alterationWorkflowList", ["identity", "project", "modules"]],
          'project-context-alteration-configuration': ["GET", "/task/workflow/alteration/config/list", ["identity", "project", "modules", "module"]],
          'project-context-alteration-configuration-readback': ["GET", "/task/workflow/alteration/config/list", ["identity", "project", "modules", "module"]],
          'project-context-alteration-manual-set': ["PUT", "/task/workflow/alteration/config/manual", ["identity", "project", "modules", "module", "configuration", "applications"]],
          'project-context-alteration-config-create': ["POST", "/task/workflow/alteration/config", ["identity", "project", "modules", "module", "configuration", "applications", "directory"]],
          'project-context-alteration-config-create-members': ["PUT", "/task/workflow/alteration/config", ["identity", "project", "modules", "module", "configuration", "applications", "directory", "created", "postCreateConfiguration"]],
          'project-context-alteration-config-update': ["PUT", "/task/workflow/alteration/config", ["identity", "project", "modules", "module", "configuration", "applications", "directory"]],
          'project-context-alteration-config-remove': ["DELETE", "/task/workflow/alteration/config", ["identity", "project", "modules", "module", "configuration"]],
          'project-context-alteration-headers': ["GET", "/task/workflow/alteration/table/view/header/selectedList", ["identity", "project", "modules", "module"]],
          'project-context-alteration-list': ["POST", "/task/workflow/alteration/table/view", ["identity", "project", "modules", "module", "headers"]],
          'project-context-alteration-flow-create': ["POST", "/task/v1/kanbanChildCrud", ["identity", "project", "modules", "module"]],
          'project-context-alteration-flow-copy': ["POST", "/task/v4/kanbanChild/copy", ["identity", "project", "modules", "module", "templates"]],
          'project-context-alteration-created-flow-detail': ["GET", "/task/v1/kanbanChildCrud", ["identity", "project", "modules", "module", "created", "verifiedModules"]],
          'project-context-alteration-launch-application': ["GET", "/task/workflow/application", ["identity", "project", "modules", "module", "configuration", "applications"]],
          'project-context-alteration-launch': ["POST", "/task/workflow/process/info/start", ["identity", "project", "modules", "module", "configuration", "applications", "application"]],
          'project-context-alteration-verify-instance': ["GET", "/task/workflow/process/info/details", ["identity", "project", "modules", "module", "configuration", "applications", "application", "started", "verifiedInstances"]],
          'project-context-member-inspect': ['GET','/task/v1/kanban/listKanbanRole',['identity','company','directory','project']],
          'project-context-member-department': ['GET','/task/v1/kanban/getDepartmentUserRoles',['identity','company','directory','project','roles']],
          'project-context-member-verify-department': ['GET','/task/v1/kanban/getDepartmentUserRoles',['identity','company','directory','project','roles','changed','verifiedProject']],
          'project-context-member-set': ['PUT','/task/v1/kanban/updateMember',['identity','company','directory','project','roles']],
          'project-context-member-role': ['PUT','/task/v1/kanban/updateUserRole',['identity','company','directory','project','roles']],
          'project-context-member-owner': ['PUT','/task/v1/kanban/updateUserRole',['identity','company','directory','project','roles']],
          'project-context-member-default-role': ['PUT','/task/v1/kanbanCrud',['identity','company','directory','project','roles']],
          'project-context-list': ['GET','/task/v3/kanbanGroup/kanbanList',['identity','groups']],
          'project-context-group-create': ['POST','/task/v1/kanbanGroup',['identity','company','groups']],
          'project-context-group-rename': ['PUT','/task/v1/kanbanGroup',['identity','company','groups']],
          'project-context-group-remove': ['DELETE','/task/v1/kanbanGroup',['identity','company','groups']],
          'project-context-group-move': ['PUT','/task/v1/kanbanGroup/sort',['identity','company','groups']],
          'project-context-catalogue': ['GET','/task/v4/template/detailList',['identity','categories']],
          'project-context-cover': ['GET','/task/v4/template',['identity','templates']],
          'project-context-create': ['POST','/task/v1/kanbanCrud',['identity','groups','cover']],
          'project-context-update': ['PUT','/task/v1/kanbanCrud',['identity','groups','project']],
          'project-context-view': ['PUT','/task/v1/kanbanCrud',['identity','project']],
          'project-context-remove': ['DELETE','/task/v1/kanbanCrud',['identity','project']],
          'project-context-recycle-restore': ['POST','/task/v1/recycleBin',['identity','groups','entries']],
          'project-context-recycle-purge': ['DELETE','/task/v1/recycleBin',['identity','groups','entries']],
          'project-context-template-create': ['POST','/task/v1/kanbanCrud',['identity','company']],
          'project-context-template-update': ['PUT','/task/v1/kanbanCrud',['identity','before']],
          'project-context-template-remove': ['DELETE','/task/v1/kanbanCrud',['identity','before']],
          'project-context-template-save': ['POST','/task/v3/templateCover/generate',['identity','company','project']],
          'project-context-template-apply': ['POST','/task/v1/kanbanCrud',['identity','groups','directory','before']],
          'project-context-template-verify-catalogue': ['GET','/task/v4/template/detailList',['identity','created','template']],
        }
        const projectContextRoute = projectContextRoutes[step.prepare],projectContext = projectContextRoute?.[0] === op?.method && projectContextRoute?.[1] === op?.route && projectContextRoute[2].every(id => steps.has(id))
        if (!workspaceTask && !archive && !datasheet && !statistics && !cooperation && !action && !collection && !workflow && !okr && !deliverable && !library && !replay && !replayStatistics && !replayCreatedTask && !replayOkr && !replayRelations && !application && !task && !execution && !notice && !contact && !taskHours && !efficiency && !search && !projectContext) issues.push('invalid workflow adapter: ' + flow.id)
        steps.add('prepared')
      }
      if (!step.id || steps.has(step.id)) issues.push('duplicate workflow step: ' + flow.id)
      steps.add(step.id)
      checkReferences(step.assertions)
    }
    checkReferences(flow.output)
    if (businessScope) for (const binding of flow.capabilities ?? []) {
      const [domainId, capabilityId] = binding.split('/'), cap = businessScope.domains.find(d => d.id === domainId)?.capabilities.find(c => c.id === capabilityId)
      if (!cap || !cap.workflows?.includes(flow.id) || flow.steps.some(s => !cap.bindings.some(b => b.operationId === s.operationId))) issues.push('workflow capability binding mismatch: ' + flow.id + ' ' + binding)
    }
  }
  return issues
}

export function auditContracts(catalog, definition) {
  const issues = [], ids = new Set(), commands = new Set(), ajv = new Ajv({ strict: false })
  for (const op of catalog.operations) {
    if (!op.id || ids.has(op.id) || !op.command || commands.has(op.command)) issues.push('duplicate operation identity: ' + op.id)
    ids.add(op.id); commands.add(op.command)
    if (!/^\/(?!\/)[\w/{}.-]+$/.test(op.route) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(op.method)) issues.push('invalid request target: ' + op.id)
    if (!['read', 'write', 'destructive'].includes(op.effect) || !['idempotent', 'unknown', 'safe', 'unsafe', 'non-idempotent'].includes(op.idempotency) || !op.methods?.length || !op.examples?.length) issues.push('incomplete operation metadata: ' + op.id)
    try { ajv.compile(op.inputSchema); ajv.compile(op.responseSchema) } catch { issues.push('invalid operation schema: ' + op.id) }
    for (const field of op.fields ?? []) if (!op.inputSchema.properties?.[field.in]?.properties?.[field.name]) issues.push('option missing from input schema: ' + op.id + ' ' + field.option)
  }
  return [...issues, ...auditWorkflows(definition, catalog)]
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const issues = auditContracts(read('operations.json'), read('workflows.json'))
  if (issues.length) { console.error(JSON.stringify({ issues }, null, 2)); process.exitCode = 1 }
  else console.log('Business request schemas and workflow bindings are consistent.')
}
