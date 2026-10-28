import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Discover checkouts without following symlinks or traversing dependency directories. */
export async function discoverRepositories(root: string): Promise<{ paths: string[]; incomplete: boolean }> {
  const paths: string[] = []
  let incomplete = false
  let visited = 0
  const skipped = new Set(['node_modules', 'vendor', 'dist', 'build', 'target'])

  async function visit(dir: string, depth: number): Promise<void> {
    if (visited++ >= 5000) {
      incomplete = true
      return
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      incomplete = true
      return
    }
    const git = entries.find((entry) => entry.name === '.git')
    if (git && (git.isDirectory() || git.isFile())) {
      paths.push(dir)
      return
    }
    if (depth >= 3) return
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !skipped.has(entry.name)) {
        await visit(join(dir, entry.name), depth + 1)
      }
    }
  }

  if (!(await stat(root)).isDirectory()) throw new Error(`Not a directory: ${root}`)
  await visit(root, 0)
  return { paths: paths.sort((a, b) => a.localeCompare(b)), incomplete }
}
