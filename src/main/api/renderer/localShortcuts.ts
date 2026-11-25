import { MainWindowClient, type MainWindowSource } from '../../common/mainWindowClient'
import { app, ipcMain, shell } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'
import { pinyin as getPinyin } from 'pinyin-pro'
import databaseAPI from '../shared/database'
import { openDialog } from '../../utils/windowUtils'
import { launchApp } from '../../core/commandLauncher'
import {
  createCommandAvailabilityChecker,
  isCommandPathAvailable,
  normalizeCommandPath
} from '../../core/commands/commandAvailability'
import type { Command } from '../../../shared/commandService'

/**
 * 本地启动项类型
 */
export interface LocalShortcut {
  id: string // 唯一标识
  name: string // 显示名称（文件名）
  alias?: string // 别名（用户自定义，优先用于搜索和显示）
  path: string // 完整路径
  type: 'file' | 'folder' | 'app' // 类型
  icon?: string // 图标路径（可选）
  keywords?: string[] // 搜索关键词
  pinyin?: string // 拼音（基于 alias || name）
  pinyinAbbr?: string // 拼音首字母（基于 alias || name）
  addedAt: number // 添加时间戳
}

const LOCAL_SHORTCUTS_KEY = 'local-shortcuts'

/**
 * 失效本地启动项清理结果。
 */
export interface PruneInvalidShortcutsResult {
  success: boolean
  removedShortcuts: number
  removedHistory: number
  error?: string
}

/**
 * 并发校验一批路径，并按规范化路径去重。
 * @param paths 待校验路径列表
 * @returns 规范化路径到可用状态的映射
 */
async function collectPathAvailability(paths: string[]): Promise<Map<string, boolean>> {
  const uniquePaths = new Map<string, string>()
  for (const item of paths) {
    if (typeof item !== 'string' || !item) continue
    const key = normalizeCommandPath(item)
    if (key && !uniquePaths.has(key)) uniquePaths.set(key, item)
  }

  const entries = await Promise.all(
    [...uniquePaths.entries()].map(async ([key, originalPath]) => {
      const available = await isCommandPathAvailable(originalPath)
      return [key, available] as const
    })
  )
  return new Map(entries)
}

/**
 * 本地启动 API - 主程序专用
 */
export class LocalShortcutsAPI extends MainWindowClient {
  private commandsCacheInvalidator: (() => void) | null = null
  private prunePromise: Promise<PruneInvalidShortcutsResult> | null = null
  private commandAvailability = createCommandAvailabilityChecker()

  /**
   * 绑定主窗口来源，初始化本模块的宿主服务。
   * @param mainWindow 主窗口实例或当前宿主提供器。
   * @returns 无返回值。
   */
  public init(mainWindow: MainWindowSource): void {
    this.mainWindow = mainWindow
    this.setupIPC()
  }

  /**
   * 设置本地启动项变化时使用的命令缓存失效回调。
   * @param invalidator 命令缓存失效函数
   * @returns 无返回值
   */
  public setCommandsCacheInvalidator(invalidator: () => void): void {
    this.commandsCacheInvalidator = invalidator
  }

  /**
   * 通知渲染进程本地启动项已变化，并使指令缓存失效。
   * 使指令缓存失效后，快捷键设置页重新获取 getCommands 时才能拿到最新的本地启动项。
   * @returns 无返回值
   */
  private notifyShortcutsChanged(): void {
    // 启动项发生变化后清除可用性缓存，重新添加的路径可立即参与搜索。
    this.commandAvailability.clear()
    this.mainWindow?.webContents.send('local-shortcuts-changed')
    this.commandsCacheInvalidator?.()
  }

  /**
   * 判断本地启动项路径是否仍然可用。
   * @param shortcutPath 本地启动项路径
   * @returns 路径可用时为 true
   */
  public async isShortcutAvailable(shortcutPath: string): Promise<boolean> {
    return this.commandAvailability.checkPath(shortcutPath)
  }

  /**
   * 判断任意指令（应用、插件、本地启动项等）是否仍然可用，供搜索结果过滤复用。
   * @param command 待检查指令
   * @returns 可用或无需检查时为 true
   */
  public async isCommandAvailable(command: Command): Promise<boolean> {
    return this.commandAvailability.check(command)
  }

  private setupIPC(): void {
    // 打开本地启动项页面前先清理失效项，避免界面继续展示已删除的路径。
    ipcMain.handle('local-shortcuts:get-all', async () => {
      await this.pruneInvalidShortcuts()
      return this.getAllShortcuts()
    })
    ipcMain.handle('local-shortcuts:add', (_event, type: 'file' | 'folder') =>
      this.addShortcut(type)
    )
    ipcMain.handle('local-shortcuts:add-by-path', (_event, filePath: string) =>
      this.addShortcutByPath(filePath)
    )
    ipcMain.handle('local-shortcuts:delete', (_event, id: string) => this.deleteShortcut(id))
    ipcMain.handle('local-shortcuts:delete-when-not-exist', (_event) =>
      this.deleteNotExistShortcut()
    )
    ipcMain.handle('local-shortcuts:open', (_event, shortcutPath: string) =>
      this.openShortcut(shortcutPath)
    )
    ipcMain.handle('local-shortcuts:update-alias', (_event, id: string, alias: string) =>
      this.updateAlias(id, alias)
    )
  }

  /**
   * 获取所有本地启动项
   */
  public getAllShortcuts(): LocalShortcut[] {
    try {
      const shortcuts = databaseAPI.dbGet(LOCAL_SHORTCUTS_KEY)
      return shortcuts || []
    } catch (error) {
      console.error('[LocalShortcut] 获取本地启动项失败:', error)
      return []
    }
  }

  /**
   * 添加本地启动项（通过文件选择对话框）
   */
  private async addShortcut(
    type: 'file' | 'folder'
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 根据类型设置对话框属性
      let properties: Array<'openFile' | 'openDirectory'>
      if (type === 'folder') {
        // 只选择文件夹
        properties = ['openDirectory']
      } else {
        properties = ['openFile']
      }
      // 打开文件选择对话框
      const result = await openDialog(
        this.mainWindow,
        {
          title: type === 'folder' ? '选择文件夹' : '选择文件或应用',
          properties
        },
        '用户取消选择'
      )
      if (!result.success) {
        return result
      }
      const selectedPath = result.data!.filePaths[0]

      // 获取文件信息
      const stats = await fs.stat(selectedPath)
      const baseNameWithExt = path.basename(selectedPath)
      // 去掉后缀名
      const fileName = path.parse(baseNameWithExt).name

      // 判断类型
      let itemType: 'file' | 'folder' | 'app'
      if (stats.isDirectory()) {
        // 检查是否为 macOS 应用
        if (process.platform === 'darwin' && selectedPath.endsWith('.app')) {
          itemType = 'app'
        } else {
          itemType = 'folder'
        }
      } else {
        // Windows 可执行文件或快捷方式视为应用
        if (
          process.platform === 'win32' &&
          (selectedPath.toLowerCase().endsWith('.exe') ||
            selectedPath.toLowerCase().endsWith('.lnk'))
        ) {
          itemType = 'app'
        } else {
          itemType = 'file'
        }
      }

      // 获取文件图标
      let icon: string | undefined
      if (itemType === 'app') {
        // 应用程序使用 ztools-icon:// 协议（与系统应用扫描器一致）
        if (process.platform === 'darwin') {
          // macOS: 直接使用 .app 路径，由原生层提取图标
          icon = `ztools-icon://${encodeURIComponent(selectedPath)}`
        } else {
          // Windows: 直接使用 .exe 或 .lnk 路径
          icon = `ztools-icon://${encodeURIComponent(selectedPath)}`
        }
      } else if (itemType === 'folder' && process.platform === 'win32') {
        // Windows 文件夹：使用 ztools-icon:// 协议获取系统文件夹图标
        icon = `ztools-icon://${encodeURIComponent(selectedPath)}`
      } else {
        // 其他情况（macOS 文件夹、普通文件）使用 app.getFileIcon 获取系统图标
        try {
          const iconData = await app.getFileIcon(selectedPath, { size: 'normal' })
          icon = iconData.toDataURL()
        } catch (error) {
          console.warn('[LocalShortcut] 获取文件图标失败:', error)
        }
      }

      // 生成拼音
      const pinyinFull = getPinyin(fileName, { toneType: 'none', type: 'array' }).join('')
      const pinyinAbbr = getPinyin(fileName, { pattern: 'first', toneType: 'none' })
        .split(' ')
        .join('')

      // 创建本地启动项
      const shortcut: LocalShortcut = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        name: fileName,
        path: selectedPath,
        type: itemType,
        icon,
        keywords: [fileName],
        pinyin: pinyinFull,
        pinyinAbbr,
        addedAt: Date.now()
      }

      // 读取现有列表
      const shortcuts = this.getAllShortcuts()

      // 检查是否已存在
      const exists = shortcuts.some((s) => s.path === selectedPath)
      if (exists) {
        return { success: false, error: '该项目已存在' }
      }

      // 添加到列表
      shortcuts.push(shortcut)

      // 保存到数据库
      databaseAPI.dbPut(LOCAL_SHORTCUTS_KEY, shortcuts)

      console.log('[LocalShortcut] 添加本地启动项成功:', shortcut.name)

      // 通知渲染进程刷新本地启动项
      this.notifyShortcutsChanged()

      return { success: true }
    } catch (error) {
      console.error('[LocalShortcut] 添加本地启动项失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  /**
   * 添加本地启动项（通过文件路径）
   */
  private async addShortcutByPath(
    selectedPath: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 获取文件信息
      const stats = await fs.stat(selectedPath)
      const baseNameWithExt = path.basename(selectedPath)
      // 去掉后缀名
      const fileName = path.parse(baseNameWithExt).name

      // 判断类型
      let itemType: 'file' | 'folder' | 'app'
      if (stats.isDirectory()) {
        // 检查是否为 macOS 应用
        if (process.platform === 'darwin' && selectedPath.endsWith('.app')) {
          itemType = 'app'
        } else {
          itemType = 'folder'
        }
      } else {
        // Windows 可执行文件或快捷方式视为应用
        if (
          process.platform === 'win32' &&
          (selectedPath.toLowerCase().endsWith('.exe') ||
            selectedPath.toLowerCase().endsWith('.lnk'))
        ) {
          itemType = 'app'
        } else {
          itemType = 'file'
        }
      }

      // 获取文件图标
      let icon: string | undefined
      if (itemType === 'app') {
        // 应用程序使用 ztools-icon:// 协议（与系统应用扫描器一致）
        if (process.platform === 'darwin') {
          // macOS: 直接使用 .app 路径，由原生层提取图标
          icon = `ztools-icon://${encodeURIComponent(selectedPath)}`
        } else {
          // Windows: 直接使用 .exe 或 .lnk 路径
          icon = `ztools-icon://${encodeURIComponent(selectedPath)}`
        }
      } else if (itemType === 'folder' && process.platform === 'win32') {
        // Windows 文件夹：使用 ztools-icon:// 协议获取系统文件夹图标
        icon = `ztools-icon://${encodeURIComponent(selectedPath)}`
      } else {
        // 其他情况（macOS 文件夹、普通文件）使用 app.getFileIcon 获取系统图标
        try {
          const iconData = await app.getFileIcon(selectedPath, { size: 'normal' })
          icon = iconData.toDataURL()
        } catch (error) {
          console.warn('[LocalShortcut] 获取文件图标失败:', error)
        }
      }

      // 生成拼音
      const pinyinFull = getPinyin(fileName, { toneType: 'none', type: 'array' }).join('')
      const pinyinAbbr = getPinyin(fileName, { pattern: 'first', toneType: 'none' })
        .split(' ')
        .join('')

      // 创建本地启动项
      const shortcut: LocalShortcut = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        name: fileName,
        path: selectedPath,
        type: itemType,
        icon,
        keywords: [fileName],
        pinyin: pinyinFull,
        pinyinAbbr,
        addedAt: Date.now()
      }

      // 读取现有列表
      const shortcuts = this.getAllShortcuts()

      // 检查是否已存在
      const exists = shortcuts.some((s) => s.path === selectedPath)
      if (exists) {
        return { success: false, error: '该项目已存在' }
      }

      // 添加到列表
      shortcuts.push(shortcut)

      // 保存到数据库
      databaseAPI.dbPut(LOCAL_SHORTCUTS_KEY, shortcuts)

      console.log('[LocalShortcut] 添加本地启动项成功:', shortcut.name)

      // 通知渲染进程刷新本地启动项
      this.notifyShortcutsChanged()

      return { success: true }
    } catch (error) {
      console.error('[LocalShortcut] 添加本地启动项失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  /**
   * 删除本地启动项
   */
  private async deleteShortcut(id: string): Promise<{ success: boolean; error?: string }> {
    try {
      const shortcuts = this.getAllShortcuts()
      const target = shortcuts.find((s) => s.id === id)
      const filtered = shortcuts.filter((s) => s.id !== id)

      if (filtered.length === shortcuts.length) {
        return { success: false, error: '未找到该项目' }
      }

      databaseAPI.dbPut(LOCAL_SHORTCUTS_KEY, filtered)

      // 手动删除后同步清理历史引用，避免已删除的项目继续出现在搜索结果中。
      if (target) this.removeHistoryReferences([target])

      console.log('[LocalShortcut] 删除本地启动项成功:', id)

      // 通知渲染进程刷新本地启动项
      this.notifyShortcutsChanged()

      return { success: true }
    } catch (error) {
      console.error('[LocalShortcut] 删除本地启动项失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  /**
   * 更新本地启动项别名
   */
  private async updateAlias(
    id: string,
    alias: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const shortcuts = this.getAllShortcuts()
      const shortcut = shortcuts.find((s) => s.id === id)

      if (!shortcut) {
        return { success: false, error: '未找到该项目' }
      }

      // 设置别名（空字符串则清除别名）
      const trimmedAlias = alias.trim()
      shortcut.alias = trimmedAlias || undefined

      // 重新生成拼音（基于 alias || name）
      const displayName = shortcut.alias || shortcut.name
      shortcut.pinyin = getPinyin(displayName, { toneType: 'none', type: 'array' }).join('')
      shortcut.pinyinAbbr = getPinyin(displayName, { pattern: 'first', toneType: 'none' })
        .split(' ')
        .join('')

      // 保存到数据库
      databaseAPI.dbPut(LOCAL_SHORTCUTS_KEY, shortcuts)

      console.log(
        '[LocalShortcut] 更新本地启动项别名成功:',
        shortcut.name,
        '->',
        shortcut.alias || '(无别名)'
      )

      // 通知渲染进程刷新本地启动项
      this.notifyShortcutsChanged()

      return { success: true }
    } catch (error) {
      console.error('[LocalShortcut] 更新本地启动项别名失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  /**
   * 打开本地启动项
   */
  private async openShortcut(shortcutPath: string): Promise<{ success: boolean; error?: string }> {
    try {
      const shortcut = this.getAllShortcuts().find((item) => item.path === shortcutPath)

      // 打开前发现路径已失效时立即清理，避免用户反复点击同一个坏项目。
      if (shortcut && !(await this.isShortcutAvailable(shortcut.path))) {
        await this.pruneInvalidShortcuts()
        return { success: false, error: '该项目已失效，已自动移除' }
      }

      if (process.platform === 'win32' && shortcut?.type === 'app') {
        await launchApp(shortcutPath)
        return { success: true }
      }

      // 文件和文件夹保持系统默认打开行为。
      const result = await shell.openPath(shortcutPath)

      if (result) {
        // 如果返回非空字符串，表示有错误
        console.error('[LocalShortcut] 打开失败:', result)
        return { success: false, error: result }
      }

      return { success: true }
    } catch (error) {
      console.error('[LocalShortcut] 打开本地启动项失败:', error)
      return { success: false, error: error instanceof Error ? error.message : '未知错误' }
    }
  }

  /**
   * 自动清理失效的本地启动项，并同步清理搜索历史中的引用。
   * 启动、打开本地启动项页面和手动清理共用同一任务，避免并发写入。
   * @returns 清理结果
   */
  public pruneInvalidShortcuts(): Promise<PruneInvalidShortcutsResult> {
    if (!this.prunePromise) {
      this.prunePromise = this.performPruneInvalidShortcuts().finally(() => {
        this.prunePromise = null
      })
    }
    return this.prunePromise
  }

  /**
   * 执行失效本地启动项的检测、写回与通知。
   * @returns 清理结果
   */
  private async performPruneInvalidShortcuts(): Promise<PruneInvalidShortcutsResult> {
    try {
      const shortcuts = this.getAllShortcuts()
      const history = databaseAPI.dbGet('command-history')
      const historyList: any[] = Array.isArray(history) ? history : []
      // 历史中可能残留已从列表删除的本地启动项引用，一并纳入校验。
      const localShortcutHistory = historyList.filter(
        (item: any) => item?.subType === 'local-shortcut'
      )

      const candidatePaths = [
        ...shortcuts.map((shortcut) => shortcut.path),
        ...localShortcutHistory.map((item: any) => item.path)
      ]
      if (candidatePaths.length === 0) {
        return { success: true, removedShortcuts: 0, removedHistory: 0 }
      }

      // 并发校验路径，避免多个失效项串行等待文件系统。
      const availability = await collectPathAvailability(candidatePaths)
      const invalidShortcuts = shortcuts.filter((shortcut) => {
        const key = normalizeCommandPath(shortcut.path)
        return key ? availability.get(key) === false : false
      })

      // 重新读取列表，避免清理期间新增的启动项被旧快照覆盖。
      // 新加入的路径不在校验映射中，会被保留。
      const currentShortcuts = this.getAllShortcuts()
      const nextShortcuts = currentShortcuts.filter((shortcut) => {
        const key = normalizeCommandPath(shortcut.path)
        return !(key && availability.get(key) === false)
      })
      const removedShortcuts = currentShortcuts.length - nextShortcuts.length
      if (removedShortcuts > 0) {
        databaseAPI.dbPut(LOCAL_SHORTCUTS_KEY, nextShortcuts)
      }

      const removedHistory = this.removeInvalidHistoryReferences(availability)

      if (removedShortcuts === 0 && removedHistory === 0) {
        return { success: true, removedShortcuts: 0, removedHistory: 0 }
      }

      console.log(
        '[LocalShortcut] 自动清理失效本地启动项:',
        invalidShortcuts.map((shortcut) => shortcut.name).join(', ') || '(仅历史记录)'
      )

      // 通知渲染进程刷新本地启动项并失效指令缓存。
      this.notifyShortcutsChanged()

      return { success: true, removedShortcuts, removedHistory }
    } catch (error) {
      console.error('[LocalShortcut] 自动清理失效本地启动项失败:', error)
      return {
        success: false,
        removedShortcuts: 0,
        removedHistory: 0,
        error: error instanceof Error ? error.message : '未知错误'
      }
    }
  }

  /**
   * 手动触发失效本地启动项清理。
   * @returns 清理结果
   */
  private deleteNotExistShortcut(): Promise<PruneInvalidShortcutsResult> {
    return this.pruneInvalidShortcuts()
  }

  /**
   * 从搜索历史中移除失效的本地启动项引用。
   * 仅匹配 subType=local-shortcut 的记录，避免误删同路径的系统应用历史。
   * @param availability 已校验的路径可用状态
   * @returns 实际移除的历史记录数量
   */
  private removeInvalidHistoryReferences(availability: Map<string, boolean>): number {
    // 重新读取历史，避免校验期间新增的记录被旧快照覆盖。
    const history = databaseAPI.dbGet('command-history')
    if (!Array.isArray(history) || history.length === 0) return 0

    const nextHistory = history.filter((item: any) => {
      if (item?.subType !== 'local-shortcut') return true
      const key = normalizeCommandPath(item.path)
      return key ? availability.get(key) !== false : true
    })
    if (nextHistory.length === history.length) return 0

    databaseAPI.dbPut('command-history', nextHistory)
    this.mainWindow?.webContents.send('history-changed')

    return history.length - nextHistory.length
  }

  /**
   * 从搜索历史中移除指定本地启动项的引用。
   * 仅匹配 subType=local-shortcut 的记录，避免误删同路径的系统应用历史。
   * @param shortcuts 已失效或被删除的本地启动项
   * @returns 实际移除的历史记录数量
   */
  private removeHistoryReferences(shortcuts: LocalShortcut[]): number {
    if (shortcuts.length === 0) return 0

    const paths = new Set(shortcuts.map((shortcut) => normalizeCommandPath(shortcut.path)))
    const history = databaseAPI.dbGet('command-history')
    if (!Array.isArray(history) || history.length === 0) return 0

    const nextHistory = history.filter(
      (item: any) =>
        !(item?.subType === 'local-shortcut' && paths.has(normalizeCommandPath(item.path)))
    )
    if (nextHistory.length === history.length) return 0

    databaseAPI.dbPut('command-history', nextHistory)
    this.mainWindow?.webContents.send('history-changed')

    return history.length - nextHistory.length
  }
}

export default new LocalShortcutsAPI()
