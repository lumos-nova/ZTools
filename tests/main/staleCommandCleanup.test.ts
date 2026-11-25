import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDbGet, mockDbPut, mockCheckPath } = vi.hoisted(() => ({
  mockDbGet: vi.fn(),
  mockDbPut: vi.fn(),
  mockCheckPath: vi.fn()
}))

vi.mock('../../src/main/api/shared/database', () => ({
  default: {
    dbGet: mockDbGet,
    dbPut: mockDbPut
  }
}))

vi.mock('../../src/main/core/commands/commandAvailability', () => ({
  createCommandAvailabilityChecker: vi.fn(() => ({
    check: vi.fn(async () => true),
    checkPath: mockCheckPath,
    clear: vi.fn()
  }))
}))

import { cleanupStaleCommandReferences } from '../../src/main/core/commands/staleCommandCleanup'

const validApp = { name: 'Still Here', path: 'C:\\Apps\\still.exe', type: 'direct', subType: 'app' }
const goneApp = {
  name: 'oil-git',
  path: 'C:\\Shortcuts\\oil-git.lnk',
  type: 'direct',
  subType: 'app'
}

describe('staleCommandCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDbPut.mockReturnValue({ ok: true })
    mockCheckPath.mockImplementation(async (target: string) => target === validApp.path)
  })

  it('从历史、固定、统计和偏好中移除已卸载软件引用', async () => {
    const stores: Record<string, any> = {
      'command-history': [validApp, goneApp],
      'pinned-commands': [goneApp],
      'super-panel-pinned': [
        {
          isFolder: true,
          name: 'Tools',
          items: [validApp, goneApp]
        }
      ],
      'command-usage-stats': [{ ...goneApp, useCount: 3 }],
      'search-preference': {
        ok: { path: validApp.path, name: validApp.name },
        gone: { path: goneApp.path, name: goneApp.name }
      }
    }
    mockDbGet.mockImplementation((key: string) => stores[key])

    const result = await cleanupStaleCommandReferences()

    expect(result.removedCount).toBe(5)
    expect(result.changedKeys).toContain('command-history')
    expect(result.changedKeys).toContain('pinned-commands')
    expect(result.changedKeys).toContain('super-panel-pinned')
    expect(result.changedKeys).toContain('command-usage-stats')
    expect(result.changedKeys).toContain('search-preference')

    expect(mockDbPut).toHaveBeenCalledWith('command-history', [validApp])
    expect(mockDbPut).toHaveBeenCalledWith('pinned-commands', [])
    expect(mockDbPut).toHaveBeenCalledWith('super-panel-pinned', [
      { isFolder: true, name: 'Tools', items: [validApp] }
    ])
    expect(mockDbPut).toHaveBeenCalledWith('command-usage-stats', [])
    expect(mockDbPut).toHaveBeenCalledWith('search-preference', {
      ok: { path: validApp.path, name: validApp.name }
    })
  })

  it('全部引用有效时不写入数据库', async () => {
    mockDbGet.mockImplementation((key: string) =>
      key === 'command-history' ? [validApp] : undefined
    )

    const result = await cleanupStaleCommandReferences()

    expect(result).toEqual({ changedKeys: [], removedCount: 0 })
    expect(mockDbPut).not.toHaveBeenCalled()
  })
})
