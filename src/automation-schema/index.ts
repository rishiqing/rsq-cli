// Extracted by scripts/automation-schema.mjs from pinned current UI pure logic.
import { z } from 'zod'
import { TriggerSchema } from './triggers.js'
import { ActionsSchema } from './actions.js'
export { TriggerSchema, ActionsSchema }
export const AutomationRuleSchema = z.object({ trigger: TriggerSchema, actions: ActionsSchema })
const schema = (value: z.ZodType) => { const result = z.toJSONSchema(value, { target: 'draft-7', io: 'input', unrepresentable: 'any' }); delete result.$schema; return result }
export const automationInputSchema = { trigger: schema(TriggerSchema), actions: schema(ActionsSchema) }
