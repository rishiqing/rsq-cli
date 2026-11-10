import { constants } from 'node:fs'
import { lstat, realpath, open, link, unlink } from 'node:fs/promises'
import { dirname, basename, resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RsqError } from './core.js'

// Stage on the destination filesystem before any server mutation. Hard-linking
// publishes complete bytes atomically and refuses existing files/symlinks.
export async function privateOutput(destination: string) {
  const file = resolve(destination), parent = await realpath(dirname(file)), info = await lstat(parent)
  if (!info.isDirectory() || process.getuid && info.uid !== process.getuid() || process.platform !== 'win32' && (info.mode & 0o022) !== 0) throw new RsqError('UNSAFE_OUTPUT', '密钥输出目录须属于当前用户，且不能允许其他用户写入。', 2)
  const target = join(parent, basename(file))
  try { await lstat(target); throw new RsqError('OUTPUT_EXISTS', '密钥输出文件已存在；请选择新文件，不覆盖已有文件或符号链接。', 2) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const staged = join(parent, '.rsq-secret-' + randomUUID()), handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600)
  let stored = false, closed = false, preserved = false
  return {
    path: target,
    async commit(secret: string) {
      try {
        await handle.writeFile(secret + '\n', 'utf8'); stored = true; await handle.sync()
        await handle.close(); closed = true
        await link(staged, target)
        // Publication has succeeded. A failure to remove the private staging
        // name must not claim that the only copy is missing.
        try { await unlink(staged) } catch { preserved = true }
        return { path: target, permissions: '0600', atomic: true, overwritten: false, ...(preserved && { recoveryFile: staged }) }
      } catch {
        // A key rotation may already have invalidated the previous key. Preserve
        // the private staged copy rather than losing the newly issued secret.
        if (stored) preserved = true
        throw new RsqError('SECRET_OUTPUT_FAILED', '密钥未发布到指定文件；不要重复轮换。', 5, { ...(stored && { recoveryFile: staged }), retry: 'read-private-recovery-file', automaticRetry: false })
      }
    },
    async close() { if (!closed) { await handle.close(); closed = true }; if (!preserved) await unlink(staged).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) },
  }
}
