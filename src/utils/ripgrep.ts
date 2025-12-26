import { findActualExecutable } from 'spawn-rx'
import { memoize } from 'lodash-es'
import { fileURLToPath, resolve } from 'node:url'
import * as path from 'path'
import { logError } from './log'
import { execFileNoThrow } from './execFileNoThrow'
import { execFile } from 'child_process'
import debug from 'debug'

const __filename = fileURLToPath(import.meta.url)
const __dirname = resolve(
  __filename,
  process.env.NODE_ENV === 'test' ? '../..' : '.',
)

const d = debug('claude:ripgrep')

const useBuiltinRipgrep = !!process.env.USE_BUILTIN_RIPGREP
if (useBuiltinRipgrep) {
  d('Using builtin ripgrep because USE_BUILTIN_RIPGREP is set')
}

const ripgrepPath = memoize(() => {
  const { cmd } = findActualExecutable('rg', [])
  d(`ripgrep initially resolved as: ${cmd}`)

  if (cmd !== 'rg' && !useBuiltinRipgrep) {
    // NB: If we're able to find ripgrep in $PATH, cmd will be an absolute
    // path rather than just returning 'rg'
    return cmd
  } else {
    // Use the one we ship in-box
    const rgRoot = path.resolve(__dirname, 'vendor', 'ripgrep')
    if (process.platform === 'win32') {
      // NB: Ripgrep doesn't ship an aarch64 binary for Windows, boooooo
      return path.resolve(rgRoot, 'x64-win32', 'rg.exe')
    }

    const ret = path.resolve(
      rgRoot,
      `${process.arch}-${process.platform}`,
      'rg',
    )

    d('internal ripgrep resolved as: %s', ret)
    return ret
  }
})

export async function ripGrep(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<string[]> {
  await codesignRipgrepIfNecessary()
  const rg = ripgrepPath()
  d('ripgrep called: %s %o', rg, target, args)

  // NB: When running interactively, ripgrep does not require a path as its last
  // argument, but when run non-interactively, it will hang unless a path or file
  // pattern is provided
  return new Promise(resolve => {
    execFile(
      ripgrepPath(),
      [...args, target],
      {
        maxBuffer: 1_000_000,
        signal: abortSignal,
        timeout: 10_000,
      },
      (error, stdout) => {
        if (error) {
          // Exit code 1 from ripgrep means "no matches found" - this is normal
          if (error.code !== 1) {
            d('ripgrep error: %o', error)
            logError(error)
          }
          resolve([])
        } else {
          d('ripgrep succeeded with %s', stdout)
          resolve(stdout.trim().split('\n').filter(Boolean))
        }
      },
    )
  })
}

// NB: We do something tricky here. We know that ripgrep processes common
// ignore files for us, so we just ripgrep for any character, which matches
// all non-empty files
export async function listAllContentFiles(
  path: string,
  abortSignal: AbortSignal,
  limit: number,
): Promise<string[]> {
  try {
    d('listAllContentFiles called: %s', path)
    return (await ripGrep(['-l', '.', path], path, abortSignal)).slice(0, limit)
  } catch (e) {
    d('listAllContentFiles failed: %o', e)

    logError(e)
    return []
  }
}

let alreadyDoneSignCheck = false
async function codesignRipgrepIfNecessary() {
  if (process.platform !== 'darwin' || alreadyDoneSignCheck) {
    return
  }

  alreadyDoneSignCheck = true

  // First, check to see if ripgrep is already signed
  d('checking if ripgrep is already signed')
  const lines = (
    await execFileNoThrow(
      'codesign',
      ['-vv', '-d', ripgrepPath()],
      undefined,
      undefined,
      false,
    )
  ).stdout.split('\n')

  const needsSigned = lines.find(line => line.includes('linker-signed'))
  if (!needsSigned) {
    d('seems to be already signed')
    return
  }

  try {
    d('signing ripgrep')
    const signResult = await execFileNoThrow('codesign', [
      '--sign',
      '-',
      '--force',
      '--preserve-metadata=entitlements,requirements,flags,runtime',
      ripgrepPath(),
    ])

    if (signResult.code !== 0) {
      d('failed to sign ripgrep: %o', signResult)
      logError(
        `Failed to sign ripgrep: ${signResult.stdout} ${signResult.stderr}`,
      )
    }

    d('removing quarantine')
    const quarantineResult = await execFileNoThrow('xattr', [
      '-d',
      'com.apple.quarantine',
      ripgrepPath(),
    ])

    if (quarantineResult.code !== 0) {
      d('failed to remove quarantine: %o', quarantineResult)
      logError(
        `Failed to remove quarantine: ${quarantineResult.stdout} ${quarantineResult.stderr}`,
      )
    }
  } catch (e) {
    d('failed during sign: %o', e)
    logError(e)
  }
}
