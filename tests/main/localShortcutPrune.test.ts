import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ipcHandlers, mockAccess, mockDbGet, mockDbPut, mockReadShortcutLink, mockSend } =
  vi.hoisted(() => ({
    ipcHandlers: new Map<string, (...args: any[]) => any>(),
    mockAccess: vi.fn(),
    mockDbGet: vi.fn(),
    mockDbPut: vi.fn(),
    mockReadShortcutLink: vi.fn(),
    mockSend: vi.fn()
  }))

vi.mock('electron', () => ({
  app: {
    getFileIcon: vi.fn()
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      ipcHandlers.set(channel, handler)
    })
  },
  shell: {
    readShortcutLink: mockReadShortcutLink,
    openPath: vi.fn()
  }
}))

vi.mock('fs', () => ({
  promises: {
    access: mockAccess,
    stat: vi.fn()
  }
}))

vi.mock('pinyin-pro', () => ({
  pinyin: vi.fn(() => [])
}))

vi.mock('../../src/main/api/shared/database', () => ({
  default: {
    dbGet: mockDbGet,
    dbPut: mockDbPut
  }
}))

vi.mock('../../src/main/utils/windowUtils', () => ({
  openDialog: vi.fn()
}))

vi.mock('../../src/main/core/commandLauncher', () => ({
  launchApp: vi.fn()
}))

import { LocalShortcutsAPI } from '../../src/main/api/renderer/localShortcuts'

const VALID_PATH = 'C:\\Tools\\valid.exe'
const INVALID_PATH = 'C:\\Tools\\missing.exe'

/**
 * 创建带有主窗口桩的 API 实例，便于断言渲染进程通知。
 * @returns 初始化后的本地启动项 API
 */
function createApi(): LocalShortcutsAPI {
  const api = new LocalShortcutsAPI()
  api.init({ webContents: { send: mockSend } } as any)
  return api
}

describe('LocalShortcutsAPI 失效项自动清理', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAccess.mockReset()
    mockDbGet.mockReset()
    mockDbPut.mockReset()
    mockReadShortcutLink.mockReset()
    mockSend.mockReset()
    ipcHandlers.clear()
    mockDbPut.mockReturnValue({ ok: true })
  })

  it('移除失效启动项，并清理对应的本地启动项历史记录', async () => {
    const validShortcut = { id: 'valid', name: 'Valid', path: VALID_PATH, type: 'app' }
    const invalidShortcut = { id: 'invalid', name: 'Missing', path: INVALID_PATH, type: 'app' }
    const history = [
      { path: VALID_PATH, type: 'direct', subType: 'local-shortcut', name: 'Valid' },
      { path: INVALID_PATH, type: 'direct', subType: 'local-shortcut', name: 'Missing' },
      // 同路径的系统应用历史不应被本地启动项清理逻辑误删。
      { path: INVALID_PATH, type: 'direct', subType: 'app', name: 'Same Path App' }
    ]
    mockDbGet.mockImplementation((key: string) => {
      if (key === 'local-shortcuts') return [validShortcut, invalidShortcut]
      if (key === 'command-history') return history
      return undefined
    })
    mockAccess.mockImplementation(async (target: string) => {
      if (target === INVALID_PATH) throw new Error('ENOENT')
    })

    const result = await createApi().pruneInvalidShortcuts()

    expect(result).toEqual({ success: true, removedShortcuts: 1, removedHistory: 1 })
    expect(mockDbPut).toHaveBeenCalledWith('local-shortcuts', [validShortcut])
    expect(mockDbPut).toHaveBeenCalledWith('command-history', [history[0], history[2]])
    expect(mockSend).toHaveBeenCalledWith('history-changed')
    expect(mockSend).toHaveBeenCalledWith('local-shortcuts-changed')
  })

  it('清理启动项列表已不存在但路径失效的孤立历史记录', async () => {
    const history = [
      { path: INVALID_PATH, type: 'direct', subType: 'local-shortcut', name: 'Missing' },
      { path: 'C:\\Plugins\\demo', type: 'plugin', name: 'Demo' }
    ]
    mockDbGet.mockImplementation((key: string) => {
      if (key === 'local-shortcuts') return []
      if (key === 'command-history') return history
      return undefined
    })
    mockAccess.mockImplementation(async (target: string) => {
      if (target === INVALID_PATH) throw new Error('ENOENT')
    })

    const result = await createApi().pruneInvalidShortcuts()

    expect(result).toEqual({ success: true, removedShortcuts: 0, removedHistory: 1 })
    expect(mockDbPut).toHaveBeenCalledWith('command-history', [history[1]])
    expect(mockDbPut).not.toHaveBeenCalledWith('local-shortcuts', expect.anything())
  })

  it('路径全部有效时不写入数据库', async () => {
    const shortcut = { id: 'valid', name: 'Valid', path: VALID_PATH, type: 'app' }
    mockDbGet.mockImplementation((key: string) => {
      if (key === 'local-shortcuts') return [shortcut]
      if (key === 'command-history') {
        return [{ path: VALID_PATH, type: 'direct', subType: 'local-shortcut' }]
      }
      return undefined
    })
    mockAccess.mockResolvedValue(undefined)

    const result = await createApi().pruneInvalidShortcuts()

    expect(result).toEqual({ success: true, removedShortcuts: 0, removedHistory: 0 })
    expect(mockDbPut).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('打开本地启动项列表时自动执行清理', async () => {
    const validShortcut = { id: 'valid', name: 'Valid', path: VALID_PATH, type: 'app' }
    const invalidShortcut = { id: 'invalid', name: 'Missing', path: INVALID_PATH, type: 'app' }
    let shortcuts = [validShortcut, invalidShortcut]
    mockDbGet.mockImplementation((key: string) => {
      if (key === 'local-shortcuts') return shortcuts
      if (key === 'command-history') return []
      return undefined
    })
    mockDbPut.mockImplementation((key: string, value: any) => {
      if (key === 'local-shortcuts') shortcuts = value
      return { ok: true }
    })
    mockAccess.mockImplementation(async (target: string) => {
      if (target === INVALID_PATH) throw new Error('ENOENT')
    })

    createApi()
    const getAll = ipcHandlers.get('local-shortcuts:get-all')!
    const result = await getAll()

    expect(result).toEqual([validShortcut])
  })

  it('手动删除启动项时同步清理历史引用', async () => {
    const shortcut = { id: 'target', name: 'Target', path: VALID_PATH, type: 'app' }
    mockDbGet.mockImplementation((key: string) => {
      if (key === 'local-shortcuts') return [shortcut]
      if (key === 'command-history') {
        return [{ path: VALID_PATH, type: 'direct', subType: 'local-shortcut' }]
      }
      return undefined
    })

    createApi()
    const remove = ipcHandlers.get('local-shortcuts:delete')!
    const result = await remove({}, shortcut.id)

    expect(result).toEqual({ success: true })
    expect(mockDbPut).toHaveBeenCalledWith('local-shortcuts', [])
    expect(mockDbPut).toHaveBeenCalledWith('command-history', [])
  })

  it.skipIf(process.platform !== 'win32')('Windows 快捷方式目标缺失时视为失效', async () => {
    const systemRoot = `${process.env.SystemDrive || 'C:'}\\`
    const shortcutPath = `${systemRoot}Tools\\broken.lnk`
    const targetPath = `${systemRoot}Tools\\gone.exe`
    const shortcut = { id: 'lnk', name: 'Broken', path: shortcutPath, type: 'app' }
    mockDbGet.mockImplementation((key: string) => {
      if (key === 'local-shortcuts') return [shortcut]
      if (key === 'command-history') return []
      return undefined
    })
    // .lnk 文件本身存在，但其指向的目标已被删除。
    mockAccess.mockImplementation(async (target: string) => {
      if (target === shortcutPath || target === systemRoot) return
      throw new Error('ENOENT')
    })
    mockReadShortcutLink.mockReturnValue({ target: targetPath })

    const result = await createApi().pruneInvalidShortcuts()

    expect(result).toEqual({ success: true, removedShortcuts: 1, removedHistory: 0 })
    expect(mockReadShortcutLink).toHaveBeenCalledWith(shortcutPath)
    expect(mockDbPut).toHaveBeenCalledWith('local-shortcuts', [])
  })

  it.skipIf(process.platform !== 'win32')('外接磁盘或网络共享离线时保留快捷方式', async () => {
    const systemDrive = (process.env.SystemDrive || 'C:').toUpperCase()
    const offlineDrive = systemDrive === 'Z:' ? 'Y:' : 'Z:'
    const offlinePath = `${offlineDrive}\\Tools\\missing.exe`
    const shortcut = { id: 'offline', name: 'Offline', path: offlinePath, type: 'app' }
    mockDbGet.mockImplementation((key: string) => {
      if (key === 'local-shortcuts') return [shortcut]
      if (key === 'command-history') return []
      return undefined
    })
    // 文件与卷根目录都无法访问，说明驱动器或共享暂时离线。
    mockAccess.mockRejectedValue(new Error('ENOENT'))

    const result = await createApi().pruneInvalidShortcuts()

    expect(result).toEqual({ success: true, removedShortcuts: 0, removedHistory: 0 })
    expect(mockDbPut).not.toHaveBeenCalled()
  })
})
