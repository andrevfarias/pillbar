// As linhas de pílulas, desenhadas: funções puras do que register.tsx lê. Cada
// pílula tem um slug, e o layout diz em que linha e de que lado ela fica. Uma
// linha perde detalhe em vez de quebrar quando a largura aperta.

import type { ElementTable, RenderElement } from 'claude-code'

import type { Cache, Limit, Look, RowSpec, Snapshot, Workspace } from '../types'
import { MINUTE_MS, TTL_MS, leftMs, reWarmUsd } from './cache'
import { isSlug } from './layout'
import type { Slug } from './layout'

export type LineInput = {
  surface: string
  isWorking: boolean
  now: number
  snapshot: Snapshot | null
  cache: Cache | null
  workspace: Workspace
  look: Look
}

type Run = { text: string; color?: string; bold?: boolean }
type Pill = { key: string; bg: string; runs: Run[] }
type Item = { kind: 'pill'; pill: Pill } | { kind: 'sep' }
type Tint = { bg: string; fg: string; accent: string }

type Palette = {
  filled: boolean
  label: string
  track: string
  good: string
  warn: string
  bad: string
  surface: Tint
  amber: Tint
  ctx: Tint
  cost: Tint
  five: Tint
  week: Tint
  effort: Tint
  branch: Tint
}

const WARN_AT = 70
const HOT_AT = 90

const DARK: Palette = {
  filled: true,
  label: '#9a9aa4',
  track: '#55555f',
  good: '#7fcf8a',
  warn: '#f0c969',
  bad: '#f07a7a',
  surface: { bg: '#2b2b33', fg: '#ececf2', accent: '#9a9aa4' },
  amber: { bg: '#3a2f17', fg: '#f0c969', accent: '#f0c969' },
  ctx: { bg: '#33281e', fg: '#f2e2cf', accent: '#e0a46a' },
  cost: { bg: '#3a3217', fg: '#f5e6b8', accent: '#e8c25a' },
  five: { bg: '#1e3324', fg: '#cfe8d3', accent: '#7fcf8a' },
  week: { bg: '#2a2540', fg: '#d9d3f5', accent: '#a99cf0' },
  effort: { bg: '#3d1f3a', fg: '#f5c8ef', accent: '#e07ad6' },
  branch: { bg: '#1c2b44', fg: '#c9dcff', accent: '#7aa2f7' },
}

const LIGHT: Palette = {
  filled: true,
  label: '#63636e',
  track: '#c4c4cc',
  good: '#2f8a45',
  warn: '#a86a00',
  bad: '#c0392b',
  surface: { bg: '#ededf2', fg: '#1d1d22', accent: '#63636e' },
  amber: { bg: '#fbeccd', fg: '#7a4e06', accent: '#a86a00' },
  ctx: { bg: '#f6e9dc', fg: '#5a3a1a', accent: '#b86a2a' },
  cost: { bg: '#f7efd2', fg: '#5c4708', accent: '#9a7414' },
  five: { bg: '#dff0e0', fg: '#1f5c2e', accent: '#2f8a45' },
  week: { bg: '#e8e4fa', fg: '#3c3489', accent: '#6b5fd3' },
  effort: { bg: '#f7e1f4', fg: '#6b1f60', accent: '#b23aa3' },
  branch: { bg: '#dfe8fa', fg: '#1f3d73', accent: '#3b6fd1' },
}

// Sem fundo nenhum: toda cor é chave do tema, então segue o tema de quem usa.
const plainTint = (accent: string, fg = 'text'): Tint => ({ bg: '', fg, accent })

const PLAIN: Palette = {
  filled: false,
  label: 'subtle',
  track: 'subtle',
  good: 'success',
  warn: 'warning',
  bad: 'error',
  surface: plainTint('subtle'),
  amber: plainTint('warning', 'warning'),
  ctx: plainTint('claude'),
  cost: plainTint('warning'),
  five: plainTint('success'),
  week: plainTint('merged'),
  effort: plainTint('claude'),
  branch: plainTint('suggestion'),
}

const PALETTES: Record<Look['appearance'], Palette> = { dark: DARK, light: LIGHT, plain: PLAIN }

type Icons = {
  caps?: [string, string]
  battery: readonly string[]
  ctx: string
  cost: string
  five: string
  week: string
  reset: string
  warn: string
  model: string
  effort: string
  folder: string
  branch: string
}

const nf = (code: number): string => String.fromCharCode(code)

// Nerd Font (a fonte do terminal precisa tê-los): as pontas arredondadas da
// pílula (Powerline) e os ícones de Font Awesome e Devicons, de uma célula cada.
const NERD: Icons = {
  caps: [nf(0xe0b6), nf(0xe0b4)], // left_half_circle_thick, right_half_circle_thick
  battery: [nf(0xf244), nf(0xf243), nf(0xf242), nf(0xf241), nf(0xf240)], // battery_empty … battery_full
  ctx: nf(0xf042), // adjust: o círculo meio cheio
  cost: nf(0xf155), // usd
  five: nf(0xf0e4), // tachometer
  week: nf(0xf073), // calendar
  reset: nf(0xf017), // clock_o
  warn: nf(0xf071), // exclamation_triangle
  model: nf(0xf2db), // microchip
  effort: nf(0xf012), // signal
  folder: nf(0xf114), // folder_o
  branch: nf(0xe725), // dev git_branch
}

const UNICODE: Icons = {
  battery: ['▱▱▱', '▰▱▱', '▰▰▱', '▰▰▰'],
  ctx: '◐',
  cost: '⊙',
  five: '◠',
  week: '▦',
  reset: '↻',
  warn: '▲',
  model: '◆',
  effort: '▂▄▆',
  folder: '□',
  branch: '⎇',
}

const LIMIT_KINDS: Record<'5h' | '7d', string> = { '5h': 'five_hour', '7d': 'seven_day' }

/**
 * Os degraus de detalhe, do mais rico ao mais enxuto, os mesmos para toda
 * pílula: uma linha que não cabe desce um degrau inteiro, e cada pílula lê dele
 * o que lhe toca (as barras, os tokens, a renovação, o texto longo, o estado da
 * branch, o quanto um nome pode ter, o caminho ou só o nome da pasta).
 */
type Step = {
  bar: number
  tokens: boolean
  resets: boolean
  words: boolean
  stats: boolean
  clip: number
  folder: 'path' | 'name' | 'none'
}

const STEPS: Step[] = [
  { bar: 8, tokens: true, resets: true, words: true, stats: true, clip: 40, folder: 'path' },
  { bar: 8, tokens: true, resets: true, words: true, stats: true, clip: 40, folder: 'name' },
  { bar: 6, tokens: true, resets: true, words: true, stats: true, clip: 24, folder: 'name' },
  { bar: 6, tokens: false, resets: true, words: true, stats: true, clip: 24, folder: 'name' },
  { bar: 4, tokens: false, resets: true, words: false, stats: false, clip: 16, folder: 'name' },
  { bar: 0, tokens: false, resets: true, words: false, stats: false, clip: 16, folder: 'name' },
  { bar: 0, tokens: false, resets: false, words: false, stats: false, clip: 12, folder: 'none' },
]
export function tokens(count: number): string {
  if (count < 1000) {
    return String(count)
  }

  if (count < 1_000_000) {
    return `${Math.round(count / 1000)}k`
  }

  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

function usd(value: number): string {
  return value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`
}

/** O tempo que falta no cache: `1h 05m`, `47m`, e `4:09` nos últimos dez minutos. */
export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))

  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`
  }

  if (seconds >= 600) {
    return `${Math.floor(seconds / 60)}m`
  }

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** O tempo até um limite renovar: `1d 7h`, `2h 40m`, `45m`. */
export function span(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE_MS))
  const hours = Math.floor(minutes / 60)

  if (hours >= 24) {
    return `${Math.floor(hours / 24)}d ${hours % 24}h`
  }

  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

/** `claude-opus-5-5[1m]` como `/model` o nomeia, curto: `opus-5-5 1M`. */
export function modelLabel(model: string): string {
  const name = model.replace(/\[[^\]]*\]$/, '').replace(/^claude-/, '')

  return /\[1m\]$/i.test(model) ? `${name} 1M` : name
}

function clip(text: string, max: number): string {
  const chars = [...text]

  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(part => part !== '').pop() ?? path
}

function tone(palette: Palette, percent: number): string {
  if (percent < WARN_AT) {
    return palette.good
  }

  return percent < HOT_AT ? palette.warn : palette.bad
}

/** Uma barra fina: a parte cheia na cor do uso e o trilho apagado. */
function bar(palette: Palette, cells: number, frac: number, color: string): Run[] {
  const filled = Math.max(0, Math.min(cells, Math.round(frac * cells)))
  const runs: Run[] = []

  if (filled > 0) {
    runs.push({ text: '━'.repeat(filled), color })
  }

  if (filled < cells) {
    runs.push({ text: '─'.repeat(cells - filled), color: palette.track })
  }

  return runs
}

function joined(parts: Run[][], palette: Palette): Run[] {
  return parts.flatMap((part, index) => (index === 0 ? part : [{ text: ' · ', color: palette.label }, ...part]))
}

function lead(icon: string, tint: Tint): Run[] {
  return icon === '' ? [] : [{ text: `${icon} `, color: tint.accent }]
}

type Draw = { palette: Palette; icons: Icons; input: LineInput }

function cachePill({ palette, icons, input }: Draw, step: Step): Pill {
  const { cache, now } = input
  const left = leftMs(cache, now)
  const ttlMs = TTL_MS[cache?.ttl ?? '1h']
  const soon = cache?.ttl === '5m' ? MINUTE_MS : 5 * MINUTE_MS
  const price = (() => {
    if (cache === null) {
      return ''
    }

    const cost = reWarmUsd(cache, input.snapshot?.usd)

    return cost === undefined ? `~${tokens(cache.window)} tok` : `~${usd(cost)}`
  })()

  let tint = palette.surface
  let charge = 0
  let ink = palette.label
  let parts: string[]

  if (left === undefined) {
    parts = ['cache –']
  } else if (left > 0 && input.isWorking) {
    // Durante o turno cada passo renova o TTL: a contagem só pularia.
    charge = 1
    ink = palette.good
    parts = ['cache warm']
  } else if (left <= 0) {
    parts = step.words ? ['cache cold', `next ${price}`] : ['cold', price]
  } else if (left <= soon) {
    tint = palette.amber
    charge = left / ttlMs
    ink = palette.warn
    parts = step.words ? [`${countdown(left)} left`, `re-warm ${price}`] : [countdown(left), price]
  } else {
    charge = left / ttlMs
    ink = palette.good
    parts = step.words ? [`cache ${countdown(left)}`, `re-warm ${price}`] : [countdown(left), price]
  }

  const levels = icons.battery.length - 1
  const battery = icons.battery[charge <= 0 ? 0 : Math.max(1, Math.min(levels, Math.ceil(charge * levels)))] ?? ''

  return {
    key: 'cache',
    bg: tint.bg,
    runs: [{ text: `${battery} `, color: ink }, ...joined(parts.map(text => [{ text, color: tint.fg }]), palette)],
  }
}

function contextPill({ palette, icons }: Draw, snap: Snapshot, step: Step): Pill {
  const tint = palette.ctx
  const runs: Run[] = [...lead(icons.ctx, tint), { text: 'ctx', color: tint.fg }]

  if (snap.percent === undefined) {
    runs.push({ text: ' –', color: palette.label })
  } else {
    const color = tone(palette, snap.percent)

    if (step.bar > 0) {
      runs.push({ text: ' ' }, ...bar(palette, step.bar, snap.percent / 100, color))
    }

    runs.push({ text: ` ${Math.round(snap.percent)}%`, color: step.bar > 0 ? tint.fg : color, bold: true })
  }

  if (step.tokens) {
    const used = snap.tokens === undefined ? '–' : tokens(snap.tokens)
    runs.push({ text: ' · ', color: palette.label }, { text: `${used}/${tokens(snap.window)}`, color: palette.label })
  }

  return { key: 'ctx', bg: tint.bg, runs }
}

function costPill({ palette, icons }: Draw, value: number): Pill {
  const tint = palette.cost

  return { key: 'cost', bg: tint.bg, runs: [...lead(icons.cost, tint), { text: usd(value), color: tint.fg, bold: true }] }
}

function limitPill({ palette, icons, input }: Draw, slug: '5h' | '7d', limit: Limit, step: Step): Pill {
  const tint = slug === '5h' ? palette.five : palette.week
  const color = tone(palette, limit.percent)
  const resetsIn = limit.resetsAt !== undefined && input.now > 0 ? limit.resetsAt - input.now : undefined
  const runs: Run[] = [...lead(slug === '5h' ? icons.five : icons.week, tint), { text: slug, color: tint.fg }]

  if (step.bar > 0) {
    runs.push({ text: ' ' }, ...bar(palette, step.bar, limit.percent / 100, color))
  }

  runs.push({ text: ` ${Math.round(limit.percent)}%`, color: step.bar > 0 ? tint.fg : color, bold: true })

  if (limit.percent >= WARN_AT) {
    runs.push({ text: ` ${icons.warn}`, color })
  }

  if (step.resets && resetsIn !== undefined && resetsIn > 0) {
    runs.push(
      { text: ' · ', color: palette.label },
      { text: `${icons.reset} `, color: tint.accent },
      { text: span(resetsIn), color: tint.fg },
    )
  }

  return { key: slug, bg: tint.bg, runs }
}

function branchPill({ palette, icons }: Draw, ws: Workspace, branch: string, step: Step): Pill {
  const tint = palette.branch
  const runs: Run[] = [...lead(icons.branch, tint), { text: clip(branch, step.clip), color: tint.fg }]

  if (step.stats) {
    const stats = [ws.dirty > 0 ? `±${ws.dirty}` : '', ws.ahead > 0 ? `↑${ws.ahead}` : '', ws.behind > 0 ? `↓${ws.behind}` : '']
      .filter(stat => stat !== '')
      .join(' ')

    if (stats !== '') {
      runs.push({ text: ` ${stats}`, color: tint.fg })
    }
  }

  return { key: 'branch', bg: tint.bg, runs }
}

/** Uma pílula simples: ícone e texto, na cor da sua faixa. */
function plainPill(key: string, tint: Tint, icon: string, text: string): Pill {
  return { key, bg: tint.bg, runs: [...lead(icon, tint), { text, color: tint.fg }] }
}

/** A pílula de um slug no degrau; nenhuma enquanto não há o que ela mostre. */
function pillOf(draw: Draw, slug: Slug, step: Step): Pill | undefined {
  const { palette, icons, input } = draw
  const snap = input.snapshot
  const ws = input.workspace

  switch (slug) {
    case 'cache':
      return cachePill(draw, step)
    case 'ctx':
      return snap === null ? undefined : contextPill(draw, snap, step)
    case 'cost':
      return snap?.usd === undefined ? undefined : costPill(draw, snap.usd)
    case '5h':
    case '7d': {
      const limit = snap?.limits.find(found => found.kind === LIMIT_KINDS[slug])

      return limit === undefined ? undefined : limitPill(draw, slug, limit, step)
    }
    case 'model':
      return ws.model === undefined ? undefined : plainPill('model', palette.surface, icons.model, clip(modelLabel(ws.model), step.clip))
    case 'effort':
      return ws.effort === undefined ? undefined : plainPill('effort', palette.effort, icons.effort, ws.effort)
    case 'branch':
      return ws.branch === undefined ? undefined : branchPill(draw, ws, ws.branch, step)
    case 'folder':
      if (ws.project === undefined || step.folder === 'none') {
        return undefined
      }

      return plainPill('folder', palette.surface, icons.folder, step.folder === 'path' ? ws.project : clip(folderName(ws.project), step.clip))
  }
}

/** As pílulas de um lado da linha, no degrau, cada uma com a sua chave: um slug repetido aparece duas vezes. */
function pillsOf(draw: Draw, slugs: readonly string[], side: string, step: Step): Pill[] {
  return slugs.flatMap((slug, index) => {
    const pill = isSlug(slug) ? pillOf(draw, slug, step) : undefined

    return pill === undefined ? [] : [{ ...pill, key: `${side}${index}-${slug}` }]
  })
}

function textWidth(text: string): number {
  return [...text].length
}

function itemWidth(item: Item, palette: Palette): number {
  if (item.kind === 'sep') {
    return 1
  }

  return item.pill.runs.reduce((total, run) => total + textWidth(run.text), 0) + (palette.filled ? 2 : 0)
}

/** A largura de um lado da linha: cada item e uma coluna entre eles. */
function rowWidth(items: Item[], palette: Palette): number {
  return items.reduce((total, item) => total + itemWidth(item, palette), 0) + Math.max(0, items.length - 1)
}

/** Pílulas lado a lado: com fundo, o espaço as separa; sem fundo, um `│`. */
function spaced(pills: Pill[], palette: Palette): Item[] {
  return pills.flatMap((pill, index): Item[] =>
    index > 0 && !palette.filled ? [{ kind: 'sep' }, { kind: 'pill', pill }] : [{ kind: 'pill', pill }],
  )
}

type Fitted = { left: Item[]; right: Item[] }

/** O primeiro degrau em que os dois lados cabem juntos na linha; o mais enxuto quando nenhum cabe, cortado na borda. */
function fitRow(draw: Draw, spec: RowSpec, room: number): Fitted {
  const { palette } = draw
  let fitted: Fitted = { left: [], right: [] }

  for (const step of STEPS) {
    fitted = { left: spaced(pillsOf(draw, spec.left, 'l', step), palette), right: spaced(pillsOf(draw, spec.right, 'r', step), palette) }

    const gap = fitted.left.length > 0 && fitted.right.length > 0 ? 1 : 0

    if (rowWidth(fitted.left, palette) + gap + rowWidth(fitted.right, palette) <= room) {
      break
    }
  }

  return fitted
}

function pillElement(el: ElementTable, pill: Pill, palette: Palette, icons: Icons): RenderElement {
  const { Box, Text } = el
  const body = (
    <Text>
      {pill.runs.map((run, index) => (
        <Text key={`r${index}`} color={run.color} bold={run.bold}>
          {run.text}
        </Text>
      ))}
    </Text>
  )

  if (!palette.filled || pill.bg === '') {
    return (
      <Box key={pill.key} flexShrink={0}>
        {body}
      </Box>
    )
  }

  if (icons.caps !== undefined) {
    return (
      <Box key={pill.key} flexShrink={0}>
        <Text color={pill.bg}>{icons.caps[0]}</Text>
        <Box backgroundColor={pill.bg}>{body}</Box>
        <Text color={pill.bg}>{icons.caps[1]}</Text>
      </Box>
    )
  }

  return (
    <Box key={pill.key} flexShrink={0} backgroundColor={pill.bg} paddingX={1}>
      {body}
    </Box>
  )
}

/** A paleta e os ícones da linha: os da Nerd Font só no terminal, porque as outras superfícies desenham com a fonte delas. */
function drawOf(input: LineInput): Draw {
  const icons = input.look.icons === 'nerd' && input.surface === 'terminal' ? NERD : UNICODE

  return { palette: PALETTES[input.look.appearance], icons, input }
}

function sideChildren(el: ElementTable, draw: Draw, items: Item[], side: string): RenderElement[] {
  const { Text } = el

  return items.map((item, index) =>
    item.kind === 'sep' ? (
      <Text key={`${side}sep${index}`} color={draw.palette.label}>
        │
      </Text>
    ) : (
      pillElement(el, item.pill, draw.palette, draw.icons)
    ),
  )
}

/**
 * Uma linha de pílulas em `room` colunas: as da esquerda, um vão e as da direita.
 * Sem configuração, ou sem nada ainda a mostrar, uma linha em branco: assim as
 * linhas abaixo dela não mudam de lugar.
 */
export function drawRow(el: ElementTable, input: LineInput, spec: RowSpec | undefined, room: number, key: string): RenderElement {
  const { Box } = el
  const draw = drawOf(input)
  const { left, right } = spec === undefined ? { left: [], right: [] } : fitRow(draw, spec, room)

  if (left.length === 0 && right.length === 0) {
    return <Box key={key} height={1} />
  }

  // Com pílulas à direita, a linha ocupa a largura dela, e o vão as empurra para a borda.
  const sized = right.length > 0 ? { width: room } : {}

  return (
    <Box key={key} {...sized} height={1} flexDirection="row" flexWrap="nowrap" overflow="hidden" columnGap={1}>
      {sideChildren(el, draw, left, 'l')}
      {right.length > 0 ? <Box key="spring" flexGrow={1} /> : null}
      {sideChildren(el, draw, right, 'r')}
    </Box>
  )
}
