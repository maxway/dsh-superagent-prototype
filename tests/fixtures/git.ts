/** The environment of the git processes the tests start. */
/** Ignore inherited Git settings while allowing a test to explicitly supply its own. */
const allowedEnvironment = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'PROCESSOR_ARCHITECTURE'])
export const gitEnv = (extra: Record<string, string> = {}): Record<string, string | undefined> => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => allowedEnvironment.has(name.toUpperCase()))),
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ALLOW_PROTOCOL: 'file',
  GIT_TEMPLATE_DIR: '',
  ...extra,
})
