import databaseAPI from '../../api/shared/database'
import { createCommandAvailabilityChecker } from './commandAvailability'

const COMMAND_ARRAY_KEYS = [
  'cached-commands',
  'command-history',
  'pinned-commands',
  'super-panel-pinned',
  'command-usage-stats',
  'recommendation-pinned'
] as const

/**
 * 失效指令引用清理结果。
 */
export interface StaleCommandCleanupResult {
  changedKeys: string[]
  removedCount: number
}

/**
 * 判断持久化记录的路径是否仍然可用。无路径的记录保持原样。
 * @param record 持久化记录
 * @param isAvailable 路径可用性检查
 * @returns 可用或无需检查时为 true
 */
async function isRecordAvailable(
  record: any,
  isAvailable: (path: string) => Promise<boolean>
): Promise<boolean> {
  if (!record || typeof record !== 'object') return true
  if (typeof record.path !== 'string' || !record.path) return true
  return isAvailable(record.path)
}

/**
 * 过滤指令数组，并递归处理超级面板文件夹中的子项。
 * @param records 原始记录
 * @param isAvailable 路径可用性检查
 * @returns 保留下来的记录及移除数量
 */
async function filterRecords(
  records: any[],
  isAvailable: (path: string) => Promise<boolean>
): Promise<{ kept: any[]; removed: number }> {
  let removed = 0
  const filtered = await Promise.all(
    records.map(async (record) => {
      if (Array.isArray(record?.items)) {
        // 文件夹记录本身没有单条路径，按子项是否仍可用决定是否保留。
        const nested = await filterRecords(record.items, isAvailable)
        removed += nested.removed
        return nested.kept.length ? { ...record, items: nested.kept } : null
      }
      if (await isRecordAvailable(record, isAvailable)) return record
      removed++
      return null
    })
  )
  return { kept: filtered.filter(Boolean), removed }
}

/**
 * 清理各持久化状态中已经失效的指令引用。
 * 主要用于应用卸载、快捷方式删除等数据库未变更的场景。
 * @returns 清理结果
 */
export async function cleanupStaleCommandReferences(): Promise<StaleCommandCleanupResult> {
  const checker = createCommandAvailabilityChecker(0)
  const isAvailable = (commandPath: string): Promise<boolean> => checker.checkPath(commandPath)
  const changedKeys: string[] = []
  let removedCount = 0

  for (const key of COMMAND_ARRAY_KEYS) {
    const records = databaseAPI.dbGet(key)
    if (!Array.isArray(records) || records.length === 0) continue

    const { kept, removed } = await filterRecords(records, isAvailable)
    if (removed === 0) continue

    databaseAPI.dbPut(key, kept)
    changedKeys.push(key)
    removedCount += removed
  }

  const preference = databaseAPI.dbGet('search-preference')
  if (preference && typeof preference === 'object' && !Array.isArray(preference)) {
    const next: Record<string, any> = {}
    let removed = 0
    for (const [query, value] of Object.entries(preference)) {
      if (await isRecordAvailable(value, isAvailable)) next[query] = value
      else removed++
    }
    if (removed > 0) {
      databaseAPI.dbPut('search-preference', next)
      changedKeys.push('search-preference')
      removedCount += removed
    }
  }

  return { changedKeys, removedCount }
}
