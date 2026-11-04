import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NUMBERED = /^(\d{3})-[a-z0-9-]+\.md$/
const files = (directory: string): string[] => readdirSync(join(ROOT, directory), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => relative(ROOT, join(entry.parentPath, entry.name)))
const numbered = readdirSync(join(ROOT, 'docs')).filter(name => NUMBERED.test(name)).sort()
const entries = ['README.md', 'SETUP.md']
const docs = files('docs').filter(path => path.endsWith('.md') && !path.startsWith('docs/zh/'))
const prompts = files('prompts').filter(path => path.endsWith('.md') && !path.startsWith('prompts/zh-CN/'))
const skills = files('skills').filter(path => path.endsWith('.md') && !path.endsWith('.zh-CN.md'))
const documents = [...entries, ...docs, ...prompts, ...skills]
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
function links(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]!.split('#')[0]!).filter(target => target && !/^[a-z]+:/.test(target))
}
const translation = (path: string): string => path.startsWith('docs/') ? path.replace(/^docs\//, 'docs/zh/')
  : path.startsWith('prompts/') ? path.replace(/^prompts\//, 'prompts/zh-CN/')
    : path.endsWith('/SKILL.md') ? path.replace(/\/SKILL\.md$/, '/SKILL.zh-CN.md') : path.replace(/\.md$/, '.zh-CN.md')
const translations = documents.map(path => [path, translation(path)] as const)
/** Removes fenced code so structural checks compare prose, not code samples. */
const withoutCode = (text: string): string => text.replace(/^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gm, '')
const shape = (text: string) => {
  const body = withoutCode(text)
  return {
    headings: [...body.matchAll(/^(#{1,6}) /gm)].map(match => match[1]!.length),
    tableRows: body.split('\n').filter(line => line.startsWith('|')).length,
  }
}
const codeBlockShapes = (text: string): string[] => [...text.matchAll(/^[ \t]*```([^\n]*)\n([\s\S]*?)^[ \t]*```[ \t]*$/gm)]
  .map(match => `${match[1]!.trim()}:${match[2]!.split('\n').length}`)
/**
 * Extract repo-relative file paths from the first column of a table under `## <heading>` in `docs/007-architecture.md`.
 * Bare filenames inherit the directory of the preceding path in the same cell.
 */
function listed(heading: string): string[] {
  const lines = read('docs/007-architecture.md').split('\n')
  const start = lines.indexOf(`## ${heading}`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  // The first two rows are the header and its separator.
  const rows = lines.slice(start, end < 0 ? undefined : end).filter(line => line.startsWith('| ')).slice(2)
  return rows.flatMap(row => {
    let directory = ''
    return [...row.split('|')[1]!.matchAll(/`([^`]+)`/g)].map(([, name]) => {
      if (!name!.includes('/')) return join(directory, name!)
      directory = dirname(name!)
      return name!
    })
  })
}

describe('documentation', () => {
  it('numbers documents consecutively from 000', () => {
    expect(numbered.map(name => name.slice(0, 3))).toEqual(numbered.map((_, index) => String(index).padStart(3, '0')))
  })
  it('links numbered documents only to earlier numbered documents', () => {
    const violations = numbered.flatMap(name => links(join(ROOT, 'docs', name)).flatMap(target => {
      const linked = resolve(ROOT, 'docs', target)
      if (!linked.endsWith('.md')) return []
      const number = NUMBERED.exec(linked.slice(linked.lastIndexOf('/') + 1))?.[1]
      return dirname(linked) === join(ROOT, 'docs') && number !== undefined && number < name.slice(0, 3) ? [] : [`${name} → ${target}`]
    }))
    expect(violations).toEqual([])
  })
  it('resolves every local link', () => {
    const files = documents.map(path => join(ROOT, path))
    const missing = files.flatMap(file => links(file).filter(target => !existsSync(resolve(dirname(file), target))).map(target => `${file.slice(ROOT.length + 1)} → ${target}`))
    expect(missing).toEqual([])
  })
  it('leaves no merge conflict markers in any document', () => {
    expect(documents.filter(path => /^(<{7}|>{7}) /m.test(read(path)))).toEqual([])
  })
  it('lists every module of src in the module table of 007 Architecture, and only files that exist', () => {
    const modules = listed('Modules')
    expect(files('src').filter(path => !modules.includes(path))).toEqual([])
    expect(modules.filter(path => !existsSync(join(ROOT, path)))).toEqual([])
  })
  it('lists every test in the test table of 007 Architecture, and only files that exist', () => {
    const tests = listed('Tests')
    expect(files('tests').filter(path => /\.spec\.tsx?$/.test(path) && !tests.includes(path))).toEqual([])
    expect(tests.filter(path => !existsSync(join(ROOT, path)))).toEqual([])
  })
})

describe('Chinese translations', () => {
  it('exists for every document', () => {
    expect(translations.filter(([, path]) => !existsSync(join(ROOT, path))).map(([, path]) => path)).toEqual([])
  })
  it('resolves every local link', () => {
    const present = translations.filter(([, path]) => existsSync(join(ROOT, path)))
    const missing = present.flatMap(([, path]) => links(join(ROOT, path))
      .filter(target => !existsSync(resolve(ROOT, dirname(path), target)))
      .map(target => `${path} → ${target}`))
    expect(missing).toEqual([])
  })
  it('keeps the headings and table rows of its original', () => {
    const diverged = translations
      .filter(([source, path]) => existsSync(join(ROOT, path)))
      .filter(([source, path]) => JSON.stringify(shape(read(source))) !== JSON.stringify(shape(read(path))))
      .map(([source]) => source)
    expect(diverged).toEqual([])
  })
  it('preserves fenced code block count, language, and line shape', () => {
    const diverged = translations
      .filter(([, path]) => existsSync(join(ROOT, path)))
      .filter(([source, path]) => JSON.stringify(codeBlockShapes(read(source))) !== JSON.stringify(codeBlockShapes(read(path))))
      .map(([source]) => source)
    expect(diverged).toEqual([])
  })
  it('leaves no merge conflict markers in any translation', () => {
    const present = translations.filter(([, path]) => existsSync(join(ROOT, path)))
    expect(present.filter(([, path]) => /^(<{7}|>{7}) /m.test(read(path))).map(([, path]) => path)).toEqual([])
  })
})
