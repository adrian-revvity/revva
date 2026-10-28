/**
 * Live inventory: agents, models, skills come from the user's connected OpenCode service.
 * Nothing is hardcoded; selections are always IDs discovered here (REQ-SETUP-3).
 */
import { openCodeService } from './service'
import type { AgentInfo, ModelInfo, SkillInfo } from '@shared/types'

export async function listAgents(): Promise<AgentInfo[]> {
  const res = await openCodeService.api.agent.list({})
  return res.data
    .filter((a) => !a.hidden)
    .map((a) => ({ id: a.id, name: a.name, description: a.description, mode: a.mode }))
    .sort((x, y) => x.id.localeCompare(y.id))
}

export async function listModels(): Promise<ModelInfo[]> {
  const res = await openCodeService.api.model.list({})
  return res.data
    .filter((m) => m.enabled)
    .map((m) => ({ providerID: m.providerID, id: m.modelID ?? m.id, name: m.name, context: m.limit?.context }))
    .sort((x, y) => `${x.providerID}/${x.id}`.localeCompare(`${y.providerID}/${y.id}`))
}

export async function listSkills(): Promise<SkillInfo[]> {
  const res = await openCodeService.api.skill.list({})
  return res.data
    .map((s) => ({ id: s.id, name: s.name, description: s.description }))
    .sort((x, y) => x.id.localeCompare(y.id))
}
