import { asObject, RsqError, type JsonObject } from './core.js'
import { companyDirectoryUnits, companyDirectoryUsers } from './contact.js'
import type { Session } from './session.js'
const invalid = (message: string): never => { throw new RsqError('INVALID_INPUT', message, 2) }
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const ids = (value: unknown) => value == null ? [] : Array.isArray(value) && value.length <= 100 && value.every(id => typeof id === 'string' && /^[1-9][0-9]*$/.test(id)) && new Set(value).size === value.length ? value as string[] : invalid('提及成员或部门必须是有界且不重复的精确 ID 列表。')
export function docCommentDirectory(value: unknown) {
  return { members: companyDirectoryUsers(value).map(user => ({ id: String(user.id), name: user.showName })), departments: companyDirectoryUnits(value) }
}
export function docCommentContent(input: JsonObject, directory: unknown, comments: JsonObject[], session: Session) {
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 20000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.text)) invalid('评论正文须为非空纯文本，不能含控制字符。')
  const available = docCommentDirectory(directory), mentionIds = new Set(ids(input.mentionIds)), departmentIds = ids(input.mentionDepartmentIds)
  if (input.replyTo != null) {
    const parent = comments.find(row => String(row.id) === input.replyTo), author = asObject(parent?.creator).id
    if (!parent || !/^[1-9][0-9]*$/.test(String(author))) invalid('回复目标须为当前文档实际评论及其作者。')
    mentionIds.add(String(author))
  }
  const wecom = session.method === 'wecom' || session.identity.userFrom?.startsWith('qywx')
  const tag = (id: string, category: 'people' | 'department', name: unknown) => {
    if (typeof name !== 'string' || !name.trim()) throw new RsqError('CONTEXT_MISSING', '提及对象缺少当前身份可用的显示名称。', 5)
    const attributes = ' data-user-id="' + id + '" data-at-category="' + category + '" data-' + (category === 'people' ? 'people' : 'department') + '-id="' + id + '"'
    if (wecom) return '<span class="toolbox-atSpan" contenteditable="false"' + attributes + '><input readonly="readonly" value="@" type="button" class="wx-toolbox-at-input"><ww-open-data type="' + (category === 'people' ? 'userName' : 'departmentName') + '" openid="' + escape(name) + '"></ww-open-data></span>'
    return '<input class="toolbox-atSpan" readonly="readonly" value="@' + escape(name) + '" type="button"' + attributes + '>'
  }
  const tags = [...mentionIds].map(id => {
    const member = available.members.find(row => row.id === id)
    if (!member) invalid('提及或回复的成员不在当前公司实际成员目录中。')
    return tag(id, 'people', member!.name)
  })
  for (const id of departmentIds) {
    const department = available.departments.find(row => row.id === id)
    if (!department) invalid('提及部门不在当前公司实际部门目录中。')
    tags.push(tag(id, 'department', department!.name))
  }
  return { content: '<p>' + tags.join('&nbsp;') + (tags.length ? '&nbsp;' : '') + escape(input.text).replace(/\r?\n/g, '<br>') + '</p>', atIds: [...mentionIds].join(','), atDeptIds: departmentIds.join(','), atType: '' }
}
