import test from 'node:test'
import assert from 'node:assert/strict'
import { readCopyForest, verifyCopiedForest } from '../dist/project-copy-proof.js'

const where = { projectId: '7001', moduleId: '7101' }
const node = (id, parent = null, name = id) => ({ id, taskId: parent, name, note: '', members: [], participants: [], labelList: [], hasSubTask: false, subTaskNum: 0, from: { projectId: where.projectId, planId: where.moduleId } })
const forest = async input => { const tasks = input.map(task => ({ ...task, subTaskNum: input.filter(row => row.taskId === task.id).length, hasSubTask: input.some(row => row.taskId === task.id) })); return readCopyForest(tasks.filter(task => task.taskId == null), { task: async id => tasks.find(task => task.id === id), comments: async () => [], children: async id => tasks.filter(task => task.taskId === id) }, where) }

test('root matching includes the whole child tree, even with indistinguishable root names and bodies', async () => {
  const source = await forest([node('first', null, 'same'), node('second', null, 'same'), node('child-1', 'first', 'alpha'), node('child-2', 'second', 'beta')])
  const copied = await forest([node('new-2', null, 'same'), node('new-1', null, 'same'), node('new-child-1', 'new-1', 'alpha'), node('new-child-2', 'new-2', 'beta')])
  const proof = verifyCopiedForest(source, copied, [])
  assert.equal(proof.find(row => row.sourceTaskId === 'first').taskId, 'new-1')
  assert.equal(proof.find(row => row.sourceTaskId === 'second').taskId, 'new-2')
})
test('copy context refuses hidden children, duplicate task IDs, inconsistent parents and excessive depth', async () => {
  await assert.rejects(readCopyForest([{ ...node('root'), hasSubTask: true }], { comments: async () => [], children: async () => [], task: async () => ({}) }, where), { code: 'CONTEXT_MISSING' })
  await assert.rejects(forest([node('duplicate'), node('duplicate')]), { code: 'CONTEXT_MISSING' })
  await assert.rejects(readCopyForest([node('root')], { comments: async () => [], children: async id => id === 'root' ? [{ id: 'child' }] : [], task: async () => node('child', 'foreign') }, where), { code: 'CONTEXT_MISSING' })
  await assert.rejects(forest(Array.from({ length: 21 }, (_, index) => node('level-' + index, index ? 'level-' + (index - 1) : null))), { code: 'CONTEXT_MISSING' })
})
test('copy context caps task and comment counts before unbounded traversal and preserves exact long IDs', async () => {
  await assert.rejects(forest(Array.from({ length: 1001 }, (_, index) => node('root-' + index))), { code: 'CONTEXT_MISSING' })
  await assert.rejects(readCopyForest([node('root')], { comments: async () => Array.from({ length: 1001 }, (_, index) => ({ id: String(index + 1) })), children: async () => [], task: async () => ({}) }, where), { code: 'CONTEXT_MISSING' })
  await assert.rejects(readCopyForest([node('root')], { comments: async () => [{ id: Number('9007199254740993') }], children: async () => [], task: async () => ({}) }, where), { code: 'CONTEXT_MISSING' })
})

test('copy refuses partially hidden children, missing counts and inconsistent task flags', async () => {
 const reader = { task: async () => node('visible-child', 'root'), comments: async () => [], children: async parent => parent === 'root' ? [{ id: 'visible-child' }] : [] }
 await assert.rejects(readCopyForest([{ ...node('root'), hasSubTask: true, subTaskNum: 2 }], reader, where), { code: 'CONTEXT_MISSING' })
 for (const patch of [{ subTaskNum: undefined }, { subTaskNum: -1 }, { subTaskNum: 0.5 }, { subTaskNum: 2, hasSubTask: false }, { subTaskNum: 0, hasSubTask: true }]) await assert.rejects(readCopyForest([{ ...node('root'), ...patch }], reader, where), { code: 'CONTEXT_MISSING' })
})
