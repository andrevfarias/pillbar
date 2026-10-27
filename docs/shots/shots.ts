// Gera as cenas das imagens do README: monta as linhas com o código real do
// pillbar e dados fictícios, e imprime cada linha como trechos com cor.
// O shots.ps1 roda este arquivo como tests/shots.test.ts numa cópia do mod; com o
// nome .test.ts aqui, o claude plugin test do repositório o rodaria junto da suíte.
import type { ModelUsage, On, RenderSurface, SessionUsage } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { mock, test } from 'claude-code/testing'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.parse('2026-10-07T12:00:00Z')
const SLOW = { timeoutMs: 60_000 }

// 264k de janela no Opus 5.5: o re-warm sai ~US$ 1,32.
const BUILD: ModelUsage = {
  input_tokens: 10_000,
  output_tokens: 4_000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 250_000,
}

const STATUS = [
  '# branch.oid 0123456789abcdef',
  '# branch.head feature/checkout-redesign',
  '# branch.upstream origin/feature/checkout-redesign',
  '# branch.ab +1 -0',
  '1 .M N... 100644 100644 100644 aaa bbb src/cart.ts',
  '1 .M N... 100644 100644 100644 aaa bbb src/checkout.ts',
  '? src/payment.ts',
  '',
].join('\n')

type Scene = { five?: number; week?: number; layout: unknown; advance?: number; working?: boolean }

function engine(on: On, scene: Scene) {
  const clock = mock.clock(on, { now: NOW - 13 * MINUTE })
  const quiet = { stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  const usage: SessionUsage = {
    startedAt: NOW - HOUR,
    context: { tokens: 380_000, window: 1_000_000, percent: 38 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: scene.five ?? 42, resetsAt: new Date(NOW + 2 * HOUR + 15 * MINUTE).toISOString() },
      { kind: 'seven_day', percentUsed: scene.week ?? 64, resetsAt: new Date(NOW + 76 * HOUR).toISOString() },
    ],
    cost: { usd: 12.4 },
  }

  mock.env(on, {})
  mock.store(on, { layout: scene.layout })
  on('settings.read', () => ({ value: {} }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.id', () => ({ value: 'shots' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.root', () => ({ value: '/home/dev/projects/storefront' }))
  on('session.usage', () => ({ value: usage }))
  on('process.run', () => ({ value: { ...quiet, exitCode: 0, stdout: STATUS } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { ...BUILD, model: e.model } }
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }))
  on('ui.render', { component: 'PromptHint' }, (_$, e) => ({ type: 'Text', props: {}, children: [e.props.hint] }))

  return clock
}

async function session($: Engine, on: On, scene: Scene) {
  const clock = engine(on, scene)
  await $.session.start({ cwd: '/home/dev/projects/storefront', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1 })

  for await (const _chunk of stream) {
    // drena o passo
  }

  await stream.result
  await clock.advance(13 * MINUTE + (scene.advance ?? 0))
}

type Seg = { t: string; fg?: string; bg?: string; b?: boolean }
type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

const SPRING = '\u0000spring'
const width = (segs: Seg[]) => segs.reduce((n, s) => n + (s.t === SPRING ? 0 : [...s.t].length), 0)

/** Uma linha da árvore como trechos: o vão entre os filhos, o fundo herdado e a mola que empurra o lado direito. */
function line(node: unknown, bg?: string, fg?: string, bold?: boolean): Seg[] {
  if (typeof node === 'string') {
    return node === '' ? [] : [{ t: node, fg, bg, b: bold }]
  }

  if (node === null || typeof node !== 'object') {
    return []
  }

  const n = node as Node
  const p = n.props ?? {}
  const kids = n.children ?? []

  if (n.type === 'Text') {
    return kids.flatMap(kid => line(kid, (p.backgroundColor as string) ?? bg, (p.color as string) ?? fg, (p.bold as boolean) ?? bold))
  }

  if (p.flexGrow === 1 && kids.length === 0) {
    return [{ t: SPRING }]
  }

  const ground = (p.backgroundColor as string) ?? bg
  const gap = (p.columnGap as number) ?? 0
  const out: Seg[] = []

  kids.forEach((kid, index) => {
    if (index > 0 && gap > 0) {
      out.push({ t: ' '.repeat(gap), bg })
    }

    out.push(...line(kid, ground, fg, bold))
  })

  const pad = (p.paddingX as number) ?? 0
  const padded = pad > 0 ? [{ t: ' '.repeat(pad), bg: ground }, ...out, { t: ' '.repeat(pad), bg: ground }] : out

  if (typeof p.width === 'number') {
    const fill = Math.max(0, p.width - width(padded))
    const spring = padded.findIndex(s => s.t === SPRING)

    return spring < 0 ? [...padded, { t: ' '.repeat(fill) }] : padded.map((s, i) => (i === spring ? { t: ' '.repeat(fill) } : s))
  }

  return padded.filter(s => s.t !== SPRING)
}

/** As linhas de uma área: a raiz em coluna, cada filho uma linha; a linha de dicas do Claude Code fica de fora. */
function rows(tree: unknown, skipHint: boolean): Seg[][] {
  const n = tree as Node
  const kids = n.props?.flexDirection === 'column' ? (n.children ?? []) : [tree]

  return kids.filter((kid, i) => !(skipHint && i === 0 && (kid as Node).type === 'Text')).map(kid => line(kid))
}

function below(columns: number, isWorking = false) {
  return {
    plugin: 'pillbar',
    surface: 'terminal' as RenderSurface,
    component: 'PromptHint' as const,
    props: { isDraft: false, isWorking, hint: '(shift+tab to cycle)' },
    viewport: { columns, rows: 40 },
  }
}

function above(bodyColumns: number) {
  return {
    plugin: 'pillbar',
    surface: 'terminal' as RenderSurface,
    component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  }
}

function shot(name: string, data: unknown) {
  console.log(`SHOT ${name} ${JSON.stringify(data)}`)
}

const COLUMNS = 140
const DEFAULT = {
  version: 2,
  banner: {},
  statusLine: {
    '0': { left: ['cache', 'ctx', 'cost', '5h', '7d'], right: [] },
    '1': { left: ['model', 'effort', 'branch', 'folder'], right: [] },
  },
}
const CUSTOM = {
  version: 2,
  banner: { '0': { left: ['cache', 'cost'], right: ['ctx', '5h', '7d'] } },
  statusLine: { '0': { left: ['model', 'effort'], right: ['folder', 'branch'] } },
}

test('padrão', SLOW, async ($, on) => {
  await session($, on, { layout: DEFAULT })
  const ui = await $.ui.mount(below(COLUMNS))
  shot('default', { status: rows(await ui.drawn(), true) })
  await ui.unmount()
})

test('banner e statusLine com right', SLOW, async ($, on) => {
  await session($, on, { layout: CUSTOM })
  const top = await $.ui.mount(above(COLUMNS - 5))
  const bottom = await $.ui.mount(below(COLUMNS))
  shot('custom', { banner: rows(await top.drawn(), false), status: rows(await bottom.drawn(), true) })
  await top.unmount()
  await bottom.unmount()
})

const single = (slug: string) => ({ version: 2, banner: {}, statusLine: { '0': { left: [slug], right: [] } } })

for (const [name, slug, scene, working] of [
  ['cache-warm', 'cache', {}, false],
  ['cache-working', 'cache', {}, true],
  ['cache-soon', 'cache', { advance: 43 * MINUTE + 18_000 }, false],
  ['cache-cold', 'cache', { advance: 50 * MINUTE }, false],
  ['ctx', 'ctx', {}, false],
  ['cost', 'cost', {}, false],
  ['five', '5h', {}, false],
  ['five-warn', '5h', { five: 78 }, false],
  ['week-hot', '7d', { week: 93 }, false],
  ['model', 'model', {}, false],
  ['effort', 'effort', {}, false],
  ['branch', 'branch', {}, false],
] as const) {
  test(`pílula ${name}`, SLOW, async ($, on) => {
    await session($, on, { layout: single(slug), ...scene })
    const ui = await $.ui.mount(below(COLUMNS, working))
    shot(name, { status: rows(await ui.drawn(), true) })
    await ui.unmount()
  })
}
