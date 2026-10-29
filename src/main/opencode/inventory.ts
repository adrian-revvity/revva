/**
 * Live inventory: agents, models, skills come from the user's connected OpenCode service.
 * Nothing is hardcoded; selections are always IDs discovered here (REQ-SETUP-3).
 */
import { openCodeService } from './service'
import { scriptManager } from '../scripts'
import { favoriteModels } from '../db'
import type { AgentInfo, ModelInfo, SkillInfo } from '@shared/types'
import { performanceMeter } from './performance'

export async function listAgents(): Promise<AgentInfo[]> {
  const res = await openCodeService.api.agent.list({})
  return res.data
    .filter((a) => !a.hidden)
    .map((a) => ({ id: a.id, name: a.name, description: a.description, mode: a.mode }))
    .sort((x, y) => x.id.localeCompare(y.id))
}

export async function listModels(): Promise<ModelInfo[]> {
  const [res, gating, favorites] = await Promise.all([
    performanceMeter.request('picker.models', () => openCodeService.api.model.list({})),
    morningGate(),
    Promise.resolve(favoriteModels())
  ])
  const favSet = new Set(favorites)
  return res.data
    .filter((m) => m.enabled)
    .map((m) => {
      const model = {
        providerID: m.providerID,
        id: m.modelID ?? m.id,
        name: m.name,
        context: m.limit?.context,
        gated: gating.get(m.providerID)
      }
      return { ...model, favorite: favSet.has(`${model.providerID}::${model.id}`) || undefined }
    })
    .sort((x, y) => {
      if (!!y.favorite !== !!x.favorite) return x.favorite ? -1 : 1
      return `${x.providerID}/${x.id}`.localeCompare(`${y.providerID}/${y.id}`)
    })
}

/** Providers whose local endpoint (proxy) is down — models gray out until it's up. */
async function morningGate(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    for (const n of await scriptManager.providerNeeds()) {
      if (!n.up) map.set(n.providerID, `Needs the local endpoint at ${n.baseURL} — run its script in Scripts`)
    }
  } catch {
    /* providers not listable yet */
  }
  return map
}

export async function listSkills(): Promise<SkillInfo[]> {
  const res = await openCodeService.api.skill.list({})
  return res.data
    .map((s) => ({ id: s.id, name: s.name, description: s.description }))
    .sort((x, y) => x.id.localeCompare(y.id))
}
