import { shell } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import type { Command } from '../../../shared/commandService'

const AVAILABILITY_CACHE_TTL = 2000

/**
 * 规范化指令路径，供跨平台比较使用。
 * @param value 原始路径
 * @returns 统一使用正斜杠的路径；Windows 下同时转为小写
 */
export function normalizeCommandPath(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * 展开 Windows 快捷方式目标中的环境变量。
 * @param value 可能包含 %VAR% 的路径
 * @returns 展开后的路径；无法识别的变量保持原样
 */
function expandWindowsEnvironmentVariables(value: string): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match)
}

/**
 * 判断路径是否位于可能临时离线的卷（外接磁盘或网络共享）。
 * @param targetPath 目标路径
 * @returns 需要额外校验卷可用性时为 true
 */
function isRemovableOrNetworkPath(targetPath: string): boolean {
  const root = path.parse(targetPath).root
  if (!root) return false

  if (process.platform === 'win32') {
    // 系统盘常驻；其它盘符与 UNC 共享可能因设备拔出或网络断开而暂时不可用。
    const systemRoot = `${process.env.SystemDrive || 'C:'}\\`.toLowerCase()
    return root.toLowerCase() !== systemRoot
  }

  if (process.platform === 'darwin') {
    return targetPath.startsWith('/Volumes/')
  }

  return false
}

/**
 * 判断路径当前是否存在。
 * 外接磁盘或网络共享整体离线时视为仍可用，避免自动清理误删用户项目。
 * @param targetPath 目标路径
 * @returns 路径存在或所在卷暂时离线时为 true
 */
async function isPathAvailable(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    if (!isRemovableOrNetworkPath(targetPath)) return false

    // 卷根目录同样不可访问，说明设备或共享暂时离线，保留该项目。
    try {
      await fs.access(path.parse(targetPath).root)
      return false
    } catch {
      return true
    }
  }
}

/**
 * 判断路径是否仍然可用。
 * Windows 的 .lnk 会额外校验目标路径，避免快捷方式文件存在但目标已被删除。
 * @param targetPath 指令路径
 * @returns 路径可用时为 true
 */
export async function isCommandPathAvailable(targetPath: string): Promise<boolean> {
  if (!(await isPathAvailable(targetPath))) {
    return false
  }

  if (process.platform !== 'win32' || !targetPath.toLowerCase().endsWith('.lnk')) {
    return true
  }

  let target = ''
  try {
    target = shell.readShortcutLink(targetPath).target || ''
  } catch {
    // 无法解析 .lnk 时以文件本身存在为准，避免误删。
    return true
  }

  const expandedTarget = expandWindowsEnvironmentVariables(target)
  // URL、Shell 命名空间等非文件系统目标不参与存在性校验。
  if (!expandedTarget || !path.isAbsolute(expandedTarget) || /^[a-z]+:\/\//i.test(expandedTarget)) {
    return true
  }

  return isPathAvailable(expandedTarget)
}

/**
 * 判断指令是否需要按路径校验可用性。
 * 匹配型规则没有可启动路径，无需参与文件系统检查。
 * @param command 待判断指令
 * @returns 具备可校验路径时为 true
 */
function hasCheckablePath(command: Command): boolean {
  return (
    typeof command.path === 'string' &&
    !!command.path &&
    (command.type === 'direct' || command.type === 'plugin') &&
    (!command.cmdType || command.cmdType === 'text') &&
    !command.matchCmd
  )
}

/**
 * 带短时缓存的指令可用性检查器。
 */
export interface CommandAvailabilityChecker {
  /**
   * 检查整条指令是否可用。
   * @param command 待检查指令
   * @returns 可用或不适用时为 true
   */
  check(command: Command): Promise<boolean>
  /**
   * 检查路径是否可用。
   * @param commandPath 指令路径
   * @returns 路径可用时为 true
   */
  checkPath(commandPath: string): Promise<boolean>
  /**
   * 清除缓存，使下一次检查立即反映最新状态。
   * @returns 无返回值
   */
  clear(): void
}

/**
 * 创建指令可用性检查器。
 * @param ttlMs 缓存有效期（毫秒）
 * @returns 可用性检查器
 */
export function createCommandAvailabilityChecker(
  ttlMs = AVAILABILITY_CACHE_TTL
): CommandAvailabilityChecker {
  const cache = new Map<string, { available: boolean; at: number }>()

  const checkPath = async (commandPath: string): Promise<boolean> => {
    const key = normalizeCommandPath(commandPath)
    if (!key) return true

    const cached = cache.get(key)
    if (cached && Date.now() - cached.at < ttlMs) return cached.available

    const available = await isCommandPathAvailable(commandPath)
    cache.set(key, { available, at: Date.now() })
    return available
  }

  return {
    check: (command) =>
      hasCheckablePath(command) ? checkPath(command.path) : Promise.resolve(true),
    checkPath,
    clear: () => cache.clear()
  }
}
