/**
 * Jira status badge palette: keyed on statusCategory first (To Do / In Progress / Done),
 * then specific status names for finer distinction (e.g. In Review vs In Progress).
 * Deterministic hash fallback keeps unknown statuses distinct but stable.
 */

const NAME_CLASSES: Array<{ re: RegExp; cls: string }> = [
  { re: /back\s?log|refined|ready|groom/i, cls: 'bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/30' },
  { re: /select|scoping|discover/i, cls: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/30' },
  { re: /analy[sz]|spec|design/i, cls: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30' },
  { re: /review|qa|test|verify|validation/i, cls: 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300 border-fuchsia-500/30' },
  { re: /blocked|hold|pause/i, cls: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30' },
  { re: /done|closed|shipped|resolved|accepted/i, cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30' },
  { re: /deploy|release|publish/i, cls: 'bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-500/30' }
]

const CATEGORY_CLASSES: Record<string, string> = {
  todo: 'bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/30',
  indeterminate: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',
  done: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
}

const HASH_POOL = Object.values(CATEGORY_CLASSES).concat(
  'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/30',
  'bg-pink-500/15 text-pink-700 dark:text-pink-300 border-pink-500/30',
  'bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30'
)

export function jiraStatusClasses(status: string, category?: string): string {
  for (const { re, cls } of NAME_CLASSES) if (re.test(status)) return cls
  const cat = (category ?? '').toLowerCase()
  if (CATEGORY_CLASSES[cat]) return CATEGORY_CLASSES[cat]!
  let h = 0
  for (const ch of status) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return HASH_POOL[h % HASH_POOL.length]!
}
