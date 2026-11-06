/**
 * Resolves a configured CLI to the executable and argv that actually run it.
 *
 * On Windows a configured CLI is often an npm `.cmd` shim. Neither `spawn` nor `execFile` can execute a `.cmd` without a
 * shell, and passing argv through `cmd.exe` would re-parse JSON and message text. npm shims name their Node entry as a
 * path relative to `%dp0%`, so resolve that entry and run it with this process's Node executable instead. The same
 * applies to a configured `.js` entry: run it with Node rather than relying on an executable bit Windows ignores.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface Launch { program: string; args: string[] }

/** The npm shim's Node entry: `%dp0%\..\pkg\scripts\run.js` (also written as `%~dp0`). */
const NODE_ENTRY = /(?:%~?dp0%?)[\\/]([^"'\r\n]+?\.(?:js|cjs|mjs))/i
const NODE_SCRIPT = /\.(?:js|cjs|mjs)$/i
const COMMAND_SCRIPT = /\.(?:cmd|bat)$/i

/**
 * Returns the program and arguments for `argv` on `platform`.
 * @throws when a Windows command script does not name a Node entry, because running it through a shell would corrupt arguments.
 */
export function launch(argv: readonly string[], platform: NodeJS.Platform = process.platform): Launch {
  const [program = '', ...args] = argv
  if (platform !== 'win32') return { program, args }
  if (NODE_SCRIPT.test(program)) return { program: process.execPath, args: [program, ...args] }
  if (!COMMAND_SCRIPT.test(program)) return { program, args }
  let text: string
  try { text = readFileSync(program, 'utf8') } catch (error) { throw new Error(`cannot read the Windows command script ${program}: ${(error as Error).message}`) }
  const entry = NODE_ENTRY.exec(text)?.[1]
  if (!entry) {
    throw new Error(`${program} is a Windows command script without a Node entry; point the CLI at its Node script or a native executable`)
  }
  return { program: process.execPath, args: [join(dirname(program), ...entry.split(/[\\/]+/)), ...args] }
}