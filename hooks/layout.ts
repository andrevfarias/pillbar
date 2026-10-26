// Onde cada pílula fica, e o comando que muda isso: `/pillbar layout ...`.
// Puro: register.tsx guarda o layout no store do mod, comum a todas as sessões.

import type { Layout, RowSpec } from '../types'

export const LAYOUT_KEY = 'layout'
export const COMMAND = 'pillbar'

/** Cada pílula, pelo slug que o comando usa, e o que ela mostra. */
export const SLUGS = {
  cache: 'contagem do cache e custo do re-warm',
  ctx: 'uso do contexto',
  cost: 'custo da sessão',
  '5h': 'limite de 5 horas',
  '7d': 'limite de 7 dias',
  model: 'modelo',
  effort: 'effort',
  branch: 'branch, alterações, à frente e atrás',
  folder: 'pasta do projeto',
} as const

export type Slug = keyof typeof SLUGS
export type Area = 'banner' | 'statusLine'
type Side = keyof RowSpec

const AREAS: Readonly<Record<string, Area>> = { banner: 'banner', statusline: 'statusLine' }
const SIDES: Readonly<Record<string, Side>> = { left: 'left', right: 'right' }
const MAX_ROW = 9
// O autocomplete oferece as linhas até esta.
const OFFERED_ROWS = 4

// A numeração em que o `statusLine row(0)` é a primeira linha abaixo da de dicas do Claude Code.
const VERSION = 2

export const DEFAULT_LAYOUT: Layout = {
  version: VERSION,
  banner: {},
  statusLine: {
    '0': { left: ['cache', 'ctx', 'cost', '5h', '7d'], right: [] },
    '1': { left: ['model', 'effort', 'branch', 'folder'], right: [] },
  },
}

const EMPTY: Layout = { version: VERSION, banner: {}, statusLine: {} }

export const isSlug = (value: string): value is Slug => Object.hasOwn(SLUGS, value)

function asRows(value: unknown): Record<string, RowSpec> {
  if (typeof value !== 'object' || value === null) {
    return {}
  }

  const rows: Record<string, RowSpec> = {}

  for (const [key, spec] of Object.entries(value)) {
    if (!/^\d$/.test(key) || typeof spec !== 'object' || spec === null) {
      continue
    }

    const side = (list: unknown): string[] => (Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string' && isSlug(s)) : [])

    rows[key] = { left: side((spec as RowSpec).left), right: side((spec as RowSpec).right) }
  }

  return rows
}

/**
 * O que o store guarda, na forma certa; undefined quando nada foi guardado, e vale
 * o padrão. Um layout da numeração antiga, em que o `statusLine row(0)` era a
 * linha de dicas do Claude Code, perde essa linha, e as outras sobem uma.
 */
export function asLayout(value: unknown): Layout | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  const stored = value as Layout
  const statusLine = asRows(stored.statusLine)

  if (stored.version !== VERSION) {
    const moved: Record<string, RowSpec> = {}

    for (const [key, spec] of Object.entries(statusLine)) {
      if (key !== '0') {
        moved[String(Number(key) - 1)] = spec
      }
    }

    return { version: VERSION, banner: asRows(stored.banner), statusLine: moved }
  }

  return { version: VERSION, banner: asRows(stored.banner), statusLine }
}

/** As linhas de uma área, da primeira até a última configurada: as do meio sem configuração ficam em branco. */
export function rowsOf(layout: Layout, area: Area): (RowSpec | undefined)[] {
  const rows = layout[area]
  const numbers = Object.keys(rows).map(Number)
  const last = numbers.length === 0 ? -1 : Math.max(...numbers)
  const list: (RowSpec | undefined)[] = []

  for (let n = 0; n <= last; n++) {
    list.push(rows[String(n)])
  }

  return list
}

function parseRow(token: string): number | undefined {
  const found = /^row\(?(\d)\)?$/i.exec(token)

  return found === null ? undefined : Number(found[1])
}

const slugList = (slugs: readonly string[]): string => (slugs.length === 0 ? '—' : slugs.join(', '))

function describeRow(row: number, spec: RowSpec | undefined): string {
  if (spec === undefined) {
    return `- row(${row}): em branco`
  }

  return `- row(${row}): left ${slugList(spec.left)} · right ${slugList(spec.right)}`
}

/** O layout de uma área, de uma linha dela ou inteiro, em markdown. */
export function describe(layout: Layout, area?: Area, row?: number): string {
  const areas: Area[] = area === undefined ? ['statusLine', 'banner'] : [area]
  const blocks = areas.map(name => {
    if (row !== undefined) {
      return `**${name}**\n${describeRow(row, layout[name][String(row)])}`
    }

    const lines = rowsOf(layout, name).map((spec, n) => describeRow(n, spec))

    return `**${name}**${lines.length === 0 ? ': vazio' : `\n${lines.join('\n')}`}`
  })

  return [...blocks, `Slugs: ${Object.keys(SLUGS).join(', ')}`].join('\n\n')
}

const USAGE = [
  'Uso: `/pillbar layout [banner|statusLine] [row(N)] [left <slugs>|clear] [right <slugs>|clear]`',
  '- `layout`: mostra o layout · `layout clear`: tira todas as pílulas · `layout reset`: volta ao padrão',
  '- `layout <área>`, `layout <área> row(N)`: mostram a área ou a linha · `... clear`: limpa',
  '- `layout <área> row(N) left a,b right c,d`: define os lados informados; o lado que não vier fica como está',
  '- `banner` fica acima do prompt e `statusLine` abaixo da linha de dicas do Claude Code; as linhas contam de `row(0)`',
].join('\n')

function withRow(layout: Layout, area: Area, row: number, spec: RowSpec | undefined): Layout {
  const rows = { ...layout[area] }

  if (spec === undefined || (spec.left.length === 0 && spec.right.length === 0)) {
    delete rows[String(row)]
  } else {
    rows[String(row)] = spec
  }

  return { ...layout, [area]: rows }
}

/** O comando, sobre o layout atual: o layout novo, quando ele muda, e o que responder. */
export function run(layout: Layout, args: string): { layout?: Layout; text: string } {
  const tokens = args.trim().split(/\s+/).filter(token => token !== '')
  const [verb, areaWord, rowWord, ...rest] = tokens

  if (verb === undefined) {
    return { text: `${describe(layout)}\n\n${USAGE}` }
  }

  if (verb.toLowerCase() !== 'layout') {
    return { text: `Comando desconhecido: \`${verb}\`.\n\n${USAGE}` }
  }

  if (areaWord === undefined) {
    return { text: describe(layout) }
  }

  if (areaWord.toLowerCase() === 'clear') {
    return { layout: EMPTY, text: `Layout limpo: nenhuma pílula.\n\n${describe(EMPTY)}` }
  }

  if (areaWord.toLowerCase() === 'reset') {
    return { layout: DEFAULT_LAYOUT, text: `Layout padrão.\n\n${describe(DEFAULT_LAYOUT)}` }
  }

  const area = AREAS[areaWord.toLowerCase()]

  if (area === undefined) {
    return { text: `Área desconhecida: \`${areaWord}\`. As áreas são \`banner\` e \`statusLine\`.` }
  }

  if (rowWord === undefined) {
    return { text: describe(layout, area) }
  }

  if (rowWord.toLowerCase() === 'clear') {
    const next = { ...layout, [area]: {} }

    return { layout: next, text: describe(next, area) }
  }

  const row = parseRow(rowWord)

  if (row === undefined || row > MAX_ROW) {
    return { text: `Linha inválida: \`${rowWord}\`. Use \`row(0)\` a \`row(${MAX_ROW})\`.` }
  }

  if (rest.length === 0) {
    return { text: describe(layout, area, row) }
  }

  if (rest.length === 1 && rest[0]?.toLowerCase() === 'clear') {
    const next = withRow(layout, area, row, undefined)

    return { layout: next, text: describe(next, area) }
  }

  const current = layout[area][String(row)]
  const spec: RowSpec = { left: [...(current?.left ?? [])], right: [...(current?.right ?? [])] }

  for (let index = 0; index < rest.length; ) {
    const side = SIDES[rest[index]?.toLowerCase() ?? '']

    if (side === undefined) {
      return { text: `Esperava \`left\` ou \`right\`, veio \`${rest[index]}\`.\n\n${USAGE}` }
    }

    const words: string[] = []

    for (index++; index < rest.length && SIDES[rest[index]?.toLowerCase() ?? ''] === undefined; index++) {
      words.push(rest[index] ?? '')
    }

    if (words.length === 1 && words[0]?.toLowerCase() === 'clear') {
      spec[side] = []
      continue
    }

    const slugs = words
      .join(',')
      .split(',')
      .map(word => word.trim().toLowerCase())
      .filter(word => word !== '')

    if (slugs.length === 0) {
      return { text: `Informe os slugs de \`${side}\`, separados por vírgula, ou \`clear\`.` }
    }

    const unknown = slugs.filter(slug => !isSlug(slug))

    if (unknown.length > 0) {
      return { text: `Slug desconhecido: ${unknown.map(slug => `\`${slug}\``).join(', ')}. Os slugs são ${Object.keys(SLUGS).join(', ')}.` }
    }

    spec[side] = slugs
  }

  const next = withRow(layout, area, row, spec)

  return { layout: next, text: describe(next, area) }
}

export type Suggestion = { text: string; label?: string; description?: string }

/** As palavras que podem vir depois das já digitadas, com o que cada uma faz. */
function nextWords(before: readonly string[]): { words: Suggestion[]; slugs: boolean } {
  const [verb, areaWord, rowWord, ...rest] = before.map(word => word.toLowerCase())
  const none = { words: [], slugs: false }

  if (verb === undefined) {
    return { words: [{ text: 'layout', description: 'mostra ou muda onde cada pílula fica' }], slugs: false }
  }

  if (verb !== 'layout') {
    return none
  }

  if (areaWord === undefined) {
    return {
      words: [
        { text: 'statusLine', description: 'as linhas abaixo do prompt' },
        { text: 'banner', description: 'as linhas acima do prompt' },
        { text: 'clear', description: 'tira todas as pílulas' },
        { text: 'reset', description: 'volta ao layout padrão' },
      ],
      slugs: false,
    }
  }

  const area = AREAS[areaWord]

  if (area === undefined) {
    return none
  }

  if (rowWord === undefined) {
    const rows = Array.from({ length: OFFERED_ROWS }, (_unused, n): Suggestion => ({
      text: `row(${n})`,
      description: `${n + 1}ª linha ${area === 'banner' ? 'acima do prompt' : 'abaixo da linha de dicas'}`,
    }))

    return { words: [...rows, { text: 'clear', description: `limpa ${area}` }], slugs: false }
  }

  const row = parseRow(rowWord)

  if (row === undefined) {
    return none
  }

  const sides: Suggestion[] = [
    { text: 'left', description: 'pílulas alinhadas à esquerda' },
    { text: 'right', description: 'pílulas alinhadas à direita' },
  ]
  const last = rest[rest.length - 1]

  if (last === undefined) {
    return { words: [...sides, { text: 'clear', description: 'limpa a linha' }], slugs: false }
  }

  if (SIDES[last] !== undefined) {
    return { words: [{ text: 'clear', description: `limpa o lado ${last}` }], slugs: true }
  }

  const used = new Set(rest.filter(word => SIDES[word] !== undefined))

  return { words: sides.filter(side => !used.has(side.text)), slugs: false }
}

/**
 * As sugestões do autocomplete para o token sob o cursor de `/pillbar ...`:
 * a próxima palavra do comando ou, numa lista de slugs, o slug depois da última vírgula.
 */
export function suggest(text: string, start: number, token: string): Suggestion[] {
  const prefix = `/${COMMAND} `

  if (!text.startsWith(prefix) || start < prefix.length) {
    return []
  }

  const before = text.slice(prefix.length, start).trim().split(/\s+/).filter(word => word !== '')
  const { words, slugs } = nextWords(before)
  const typed = token.toLowerCase()
  const matching = words.filter(word => word.text.toLowerCase().startsWith(typed))

  if (!slugs) {
    return matching
  }

  const parts = token.split(',')
  const head = parts.slice(0, -1).join(',')
  const tail = (parts[parts.length - 1] ?? '').toLowerCase()
  const listed = (Object.keys(SLUGS) as Slug[])
    .filter(slug => slug.startsWith(tail))
    .map(slug => ({ text: head === '' ? slug : `${head},${slug}`, label: slug, description: SLUGS[slug] }))

  return head === '' ? [...listed, ...matching] : listed
}
