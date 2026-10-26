import type { ModelUsage, On, RenderElement, RenderSurface, SessionUsage } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import { baselined, emptyCache, leftMs, pinged, reWarmUsd, recalled, responded } from '../hooks/cache'
import { parseStatus } from '../hooks/git'
import { DEFAULT_LAYOUT, asLayout, rowsOf, run, suggest } from '../hooks/layout'
import { merge, newer, settled } from '../hooks/limits'
import { countdown, modelLabel, span } from '../hooks/line'
import { lastReply, transcriptPath } from '../hooks/transcript'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.parse('2026-10-07T12:00:00Z')

// As pontas arredondadas da Nerd Font (Powerline), U+E0B6 e U+E0B4.
const CAP_LEFT = String.fromCharCode(0xe0b6)
const CAP_RIGHT = String.fromCharCode(0xe0b4)

// 10k de input, 100k escritos no cache, 2k de saída: uma janela de 112k, que o
// Opus 5.5 (US$ 4 por milhão de input) reescreve a 1,25× por US$ 0,56.
const BUILD: ModelUsage = {
  input_tokens: 10_000,
  output_tokens: 2_000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 100_000,
}

const STATUS = [
  '# branch.oid 0123456789abcdef',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +1 -0',
  '1 .M N... 100644 100644 100644 aaa bbb hooks/line.tsx',
  '? notas.txt',
  '? rascunho.txt',
  '',
].join('\n')

/** Uma linha de transcript de uma resposta, da conversa principal ou de um subagente. */
function replyLine(at: number, sidechain = false): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: sidechain,
    timestamp: new Date(at).toISOString(),
    message: {
      model: 'claude-opus-5-5',
      role: 'assistant',
      usage: { ...BUILD, cache_creation: { ephemeral_1h_input_tokens: 100_000, ephemeral_5m_input_tokens: 0 } },
    },
  })
}

const TRANSCRIPT = [
  JSON.stringify({ type: 'user', timestamp: new Date(NOW - 20 * MINUTE).toISOString() }),
  replyLine(NOW - 13 * MINUTE),
  replyLine(NOW - 12 * MINUTE, true),
  JSON.stringify({ type: 'permission-mode', permissionMode: 'auto' }),
  '',
].join('\n')

test('o relógio do cache diz horas, minutos e, nos últimos dez, os segundos', () => {
  expect(countdown(HOUR)).toBe('1h 00m')
  expect(countdown(47 * MINUTE)).toBe('47m')
  expect(countdown(4 * MINUTE + 9000)).toBe('4:09')
  expect(countdown(47_000)).toBe('0:47')
})

test('a renovação de um limite diz dias e horas, ou horas e minutos', () => {
  expect(span(2 * HOUR + 40 * MINUTE)).toBe('2h 40m')
  expect(span(3 * HOUR)).toBe('3h 0m')
  expect(span(31 * HOUR)).toBe('1d 7h')
  expect(span(30_000)).toBe('1m')
})

test('o modelo aparece sem o prefixo, e a janela de 1M como sufixo', () => {
  expect(modelLabel('claude-opus-5-5')).toBe('opus-5-5')
  expect(modelLabel('claude-opus-5-5[1m]')).toBe('opus-5-5 1M')
  expect(modelLabel('opus')).toBe('opus')
})

test('o git diz a branch, os arquivos alterados e o quanto está à frente e atrás', () => {
  expect(parseStatus(STATUS)).toEqual({ branch: 'main', dirty: 3, ahead: 1, behind: 0 })
  expect(parseStatus('# branch.oid a1b2c3d4e5f6\n# branch.head (detached)\n')?.branch).toBe('a1b2c3d')
  expect(parseStatus('')).toBeUndefined()
})

test('o cache conta a hora a partir da última requisição principal e o re-warm sai do preço do modelo', () => {
  const start = baselined(emptyCache('1h', false), 0)
  const built = responded(start, { ...BUILD, model: 'claude-opus-5-5' }, NOW, true)

  expect(leftMs(built, NOW + 13 * MINUTE)).toBe(47 * MINUTE)
  expect(leftMs(built, NOW + 2 * HOUR)).toBe(0)
  expect((reWarmUsd(built, undefined) ?? 0).toFixed(4)).toBe('0.5600')

  // A resposta de um subagente entra na taxa, mas não mexe no relógio do cache principal.
  const sub = responded(built, { ...BUILD, model: 'claude-opus-5-5' }, NOW + 5 * MINUTE, false)
  expect(sub.lastAt).toBe(NOW)
  expect(sub.weighted).toBe(2 * built.weighted)
})

test('fora da tabela, o re-warm sai da taxa que o custo da sessão resolve', () => {
  // 145k tokens pesados por US$ 0,58: US$ 4 por milhão, a mesma taxa do Opus 5.5.
  const built = responded(baselined(emptyCache('1h', false), 0), { ...BUILD, model: 'claude-outro-1' }, NOW, true)

  expect(reWarmUsd(built, undefined)).toBeUndefined()
  expect((reWarmUsd(built, 0.58) ?? 0).toFixed(4)).toBe('0.5600')
})

test('uma hora presumida que nada leu depois de cinco minutos parados era de cinco', () => {
  const built = responded(emptyCache('1h', false), BUILD, NOW, true)
  const missed = responded(built, BUILD, NOW + 10 * MINUTE, true)

  expect(missed.ttl).toBe('5m')
  expect(responded(responded(emptyCache('1h', true), BUILD, NOW, true), BUILD, NOW + 10 * MINUTE, true).ttl).toBe('1h')
})

test('do transcript vem a última resposta principal, e uma compactação depois dela a anula', () => {
  const reply = lastReply(TRANSCRIPT)

  expect(reply?.at).toBe(NOW - 13 * MINUTE)
  expect(reply?.ttl).toBe('1h')
  expect(leftMs(recalled(emptyCache('5m', false), reply ?? { at: 0, usage: BUILD }), NOW)).toBe(47 * MINUTE)
  expect(lastReply(`${TRANSCRIPT}{"type":"system","subtype":"compact_boundary"}\n`)).toBeUndefined()
  expect(lastReply('')).toBeUndefined()
  expect(transcriptPath('C:\\Users\\dev/.claude', 'C:\\dev\\my-app', 'abc')).toBe(
    'C:\\Users\\dev/.claude/projects/C--dev-my-app/abc.jsonl',
  )
})

test('de duas leituras de um limite fica a da janela que renova depois e, na mesma janela, a de uso maior', () => {
  const week = { kind: 'seven_day', percent: 71, resetsAt: NOW + 31 * HOUR }

  expect(newer(week, { ...week, percent: 74, resetsAt: NOW + 31 * HOUR + 20_000 }).percent).toBe(74)
  expect(newer(week, { ...week, percent: 70 }).percent).toBe(71)
  expect(newer(week, { ...week, percent: 3, resetsAt: NOW + 7 * 24 * HOUR }).percent).toBe(3)
  expect(newer({ kind: 'seven_day', percent: 80 }, week).percent).toBe(71)

  const five = { kind: 'five_hour', percent: 23, resetsAt: NOW + HOUR }
  expect(merge([five, week], [{ ...week, percent: 90 }]).map(limit => limit.percent)).toEqual([23, 90])
})

test('um limite cuja janela já renovou vale zero até a próxima leitura', () => {
  expect(settled([{ kind: 'five_hour', percent: 64, resetsAt: NOW - MINUTE }], NOW)).toEqual([{ kind: 'five_hour', percent: 0 }])
  expect(settled([{ kind: 'five_hour', percent: 64, resetsAt: NOW + MINUTE }], NOW)[0]?.percent).toBe(64)
})

// Os testes que montam a faixa andam minutos no relógio, e cada segundo é uma volta do ciclo do mod.
const SLOW = { timeoutMs: 20_000 }

/** `transcript`: se o transcript da sessão já existe; numa retomada ele chega depois do início da sessão. */
type World = { clock: MockClock; read: string[]; transcript: boolean }
/**
 * `band`: o que o engine e os mods abaixo deste deixam na faixa acima do prompt;
 * `store`: o que o store do mod guarda, de outras sessões.
 */
type Setup = {
  env?: Record<string, string>
  start?: number
  band?: RenderElement
  store?: Record<string, unknown>
  settings?: Record<string, unknown>
  /** Quando a janela de 5h renova, a partir de NOW. */
  fiveResetsIn?: number
}

// A linha que outro mod (o cache-tax) põe na faixa acima do prompt.
const OTHER_MOD: RenderElement = {
  type: 'Box',
  props: {},
  children: [{ type: 'Text', props: {}, children: ['cache-tax · warm'] }],
}

// A raiz do projeto, que a pasta mostra; a sessão começa em C:\dev\my-app, que dá o transcript.
const ROOT = 'C:\\dev\\produtos\\my-app'
// O engine normaliza o separador do caminho para o do sistema.
const TRANSCRIPT_FILE = /^C:\\Users\\dev[\\/]\.claude[\\/]projects[\\/]C--dev-my-app[\\/]abc\.jsonl$/
const ENGINE_HINT = '(shift+tab to cycle) · esc to interrupt'

// O que o engine responde por baixo dos plugins: a linha de dicas dele é um texto.
function engine(on: On, setup: Setup = {}): World {
  const clock = mock.clock(on, { now: setup.start ?? NOW - 13 * MINUTE })
  const quiet = { stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  const world: World = { clock, read: [], transcript: true }
  const usage: SessionUsage = {
    startedAt: NOW - HOUR,
    context: { tokens: 76_000, window: 200_000, percent: 38 },
    rateLimits: [
      {
        kind: 'five_hour',
        percentUsed: 23.5,
        resetsAt: new Date(NOW + (setup.fiveResetsIn ?? 2 * HOUR + 40 * MINUTE)).toISOString(),
      },
      { kind: 'seven_day', percentUsed: 91, resetsAt: new Date(NOW + 31 * HOUR).toISOString() },
    ],
    cost: { usd: 0.58 },
  }

  mock.env(on, setup.env ?? {})
  mock.store(on, setup.store ?? {})
  on('settings.read', () => ({ value: setup.settings ?? { effortLevel: 'medium' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.usage', () => ({ value: usage }))
  on('process.run', () => ({ value: { ...quiet, exitCode: 0, stdout: STATUS } }))
  const exists = (path: string): boolean => world.transcript && TRANSCRIPT_FILE.test(path)
  on('fs.stat', (_$, e) => {
    if (!exists(e.path)) {
      throw new Error(`ENOENT: ${e.path}`)
    }

    return { value: { kind: 'file' as const, size: TRANSCRIPT.length, mtimeMs: NOW, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    world.read.push(e.path)

    if (!exists(e.path)) {
      throw new Error(`ENOENT: ${e.path}`)
    }

    return { value: TRANSCRIPT }
  })
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { ...BUILD, model: e.model },
    }
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'AbovePrompt' }, () => setup.band ?? { type: 'Box', props: {}, children: [] })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.render', { component: 'PromptHint' }, (_$, e) => ({ type: 'Text', props: { dimColor: true }, children: [e.props.hint] }))

  return world
}

async function start($: Engine, world: World): Promise<void> {
  await $.session.start({ cwd: 'C:\\dev\\my-app', surface: 'terminal', isInteractive: true })
  await world.clock.settle()
}

/** A sessão começa, a conversa principal faz uma requisição e, 13 minutos depois, as faixas são lidas. */
async function session($: Engine, world: World): Promise<void> {
  await start($, world)

  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })

  for await (const _chunk of stream) {
    // drena o passo para o hook ver o resultado
  }

  await stream.result
  await world.clock.advance(13 * MINUTE)
}

/** A faixa acima do prompt. */
function above(surface: RenderSurface, bodyColumns: number) {
  return {
    plugin: 'pillbar',
    surface,
    component: 'AbovePrompt' as const,
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 9 },
      view: {},
    },
  }
}

/** A linha de dicas sob o prompt. */
function below(surface: RenderSurface, columns: number, hint = ENGINE_HINT) {
  return {
    plugin: 'pillbar',
    surface,
    component: 'PromptHint' as const,
    props: { isDraft: false, isWorking: false, hint },
    viewport: { columns, rows: 40 },
  }
}

async function shown(ui: { findAll: (query: { type: string }) => Promise<readonly { text: string }[]> }) {
  return (await ui.findAll({ type: 'Text' })).map(found => found.text).join('|')
}

test('sob o input, os números, com · dentro das pílulas', SLOW, async ($, on) => {
  await session($, engine(on))

  const ui = await $.ui.mount(below('terminal', 204))
  const text = await shown(ui)

  for (const part of ['cache 47m · re-warm ~$0.56', 'ctx', '38% · 76k/200k', '$0.58', '24%', '2h 40m', '91%', '1d 7h']) {
    expect(text).toContain(part)
  }

  expect(text).not.toContain('│')
  await ui.unmount()
})

test('sob o input vêm a linha de dicas do engine, como está, os números e o ambiente', SLOW, async ($, on) => {
  await session($, engine(on))

  const ui = await $.ui.mount(below('terminal', 204))
  const tree = (await ui.drawn()) as { children?: unknown[] }
  const text = await shown(ui)
  const metrics = await ui.find({ type: 'Box', key: 'status-0' })
  const workspace = await ui.find({ type: 'Box', key: 'status-1' })

  expect(tree.children?.[0]).toMatchObject({ type: 'Text', children: [ENGINE_HINT] })
  expect(text.indexOf(ENGINE_HINT)).toBeLessThan(text.indexOf('cache 47m'))
  expect(text.indexOf('cache 47m')).toBeLessThan(text.indexOf('opus-5-5'))
  expect(metrics?.text).toContain('cache 47m')
  expect(metrics?.text).not.toContain('opus-5-5')

  for (const part of ['opus-5-5', 'high', 'main ±3 ↑1', ROOT]) {
    expect(workspace?.text).toContain(part)
  }

  await ui.unmount()
})

test('a faixa acima do prompt fica para os outros mods', SLOW, async ($, on) => {
  await session($, engine(on, { band: OTHER_MOD }))

  const ui = await $.ui.mount(above('terminal', 200))

  expect(await ui.drawn()).toMatchObject(OTHER_MOD)
  expect(await ui.find({ type: 'Text', text: /re-warm|ctx/ })).toBeUndefined()
  await ui.unmount()
})

test('a branch vem antes da pasta, e a pasta mostra o caminho inteiro só quando cabe', SLOW, async ($, on) => {
  await session($, engine(on))

  const wide = await $.ui.mount(below('terminal', 204))
  const text = (await wide.find({ type: 'Box', key: 'status-1' }))?.text ?? ''
  expect(text.indexOf('main ±3')).toBeLessThan(text.indexOf(ROOT))
  await wide.unmount()

  // 60 colunas, menos a margem: cabe o nome da pasta, não o caminho.
  const narrow = await $.ui.mount(below('terminal', 60))
  const tight = (await narrow.find({ type: 'Box', key: 'status-1' }))?.text ?? ''
  expect(tight).toContain('my-app')
  expect(tight).not.toContain(ROOT)
  await narrow.unmount()
})

test('no terminal as pílulas têm pontas arredondadas e as barras são linhas finas, sem marca', SLOW, async ($, on) => {
  await session($, engine(on))

  const ui = await $.ui.mount(below('terminal', 204))
  const text = await shown(ui)

  expect(text).toContain(CAP_LEFT)
  expect(text).toContain(CAP_RIGHT)
  expect(text).not.toMatch(/[█░┼┿│]/)
  // Contexto em 38%, 5h em 24%, 7d em 91%: só a parte cheia e o trilho.
  expect(text).toContain('━━━─────')
  expect(text).toContain('━━──────')
  expect(text).toContain('━━━━━━━─')
  await ui.unmount()
})

test('um ping de keepwarm que leu o cache recomeça o relógio dele; um que nada leu, não', () => {
  const built = responded(emptyCache('1h', false), { ...BUILD, model: 'claude-opus-5-5' }, NOW - 13 * MINUTE, true)
  const ping = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 112_000, cache_creation_input_tokens: 0 }

  expect(leftMs(pinged(built, ping, NOW), NOW)).toBe(HOUR)
  expect(leftMs(pinged(built, { ...ping, cache_read_input_tokens: 0 }, NOW), NOW)).toBe(47 * MINUTE)
  // Antes de qualquer resposta não há cache da conversa para o ping manter.
  expect(pinged(emptyCache('1h', false), ping, NOW).requests).toBe(0)
})

test('no desktop os ícones são Unicode, sem os da Nerd Font', SLOW, async ($, on) => {
  await session($, engine(on))

  const ui = await $.ui.mount(below('desktop', 204))

  expect(await shown(ui)).not.toMatch(/[\uE000-\uF8FF]/)
  await ui.unmount()
})

test('estreita, a faixa dos números perde detalhe em vez de quebrar', SLOW, async ($, on) => {
  await session($, engine(on))

  const ui = await $.ui.mount(below('terminal', 104))
  const text = (await ui.find({ type: 'Box', key: 'status-0' }))?.text ?? ''

  expect(text).toContain('38%')
  expect(text).not.toContain('76k/200k')
  await ui.unmount()
})

test('nos últimos minutos o cache fica âmbar e conta os segundos', SLOW, async ($, on) => {
  const world = engine(on)
  await session($, world)
  await world.clock.advance(43 * MINUTE)

  const ui = await $.ui.mount(below('terminal', 204))
  const text = await shown(ui)

  expect(text).toContain('4:00 left · re-warm ~$0.56')
  // A ponta da pílula do cache pinta-se no fundo âmbar.
  const caps = (await ui.findAll({ type: 'Text' })).filter(found => found.text === CAP_LEFT)
  expect(caps.some(found => found.props?.color === '#3a2f17')).toBe(true)
  await ui.unmount()
})

test('carregado no meio da conversa, o cache vem da última resposta do transcript', SLOW, async ($, on) => {
  const world = engine(on, { env: { USERPROFILE: 'C:\\Users\\dev' }, start: NOW })
  await start($, world)

  const ui = await $.ui.mount(below('terminal', 204))

  expect(world.read.some(path => TRANSCRIPT_FILE.test(path))).toBe(true)
  expect(await shown(ui)).toContain('cache 47m · re-warm ~$0.56')
  await ui.unmount()
})

test('retomada, a sessão acha a última resposta quando o transcript aparece, depois do início', SLOW, async ($, on) => {
  const world = engine(on, { env: { USERPROFILE: 'C:\\Users\\dev' }, start: NOW })
  world.transcript = false
  await start($, world)

  const before = await $.ui.mount(below('terminal', 204))
  expect(await shown(before)).toContain('cache –')
  await before.unmount()

  world.transcript = true
  await world.clock.advance(5000)

  const after = await $.ui.mount(below('terminal', 204))
  expect(await shown(after)).toContain('cache 47m · re-warm ~$0.56')
  await after.unmount()
})

test('antes da primeira requisição, o effort vem do modelSettings do modelo, e não do geral', SLOW, async ($, on) => {
  const settings = { effortLevel: 'medium', modelSettings: { 'claude-opus-5': { effortLevel: 'low' }, 'claude-opus-5-5': { effortLevel: 'xhigh' } } }
  const world = engine(on, { settings })
  await start($, world)

  const ui = await $.ui.mount(below('terminal', 204))
  const text = await shown(ui)

  expect(text).toContain('xhigh')
  expect(text).not.toContain('medium')
  await ui.unmount()
})

test('parada, a sessão mostra a leitura mais nova que outra sessão deixou dos limites da conta', SLOW, async ($, on) => {
  const week = { kind: 'seven_day', percent: 96, resetsAt: NOW + 31 * HOUR }
  await session($, engine(on, { store: { limits: [week] } }))

  const ui = await $.ui.mount(below('terminal', 204))
  const text = await shown(ui)

  expect(text).toContain('96%')
  expect(text).not.toContain('91%')
  await ui.unmount()
})

test('passada a renovação, o limite aparece zerado, sem contagem', SLOW, async ($, on) => {
  const world = engine(on, { fiveResetsIn: MINUTE })
  await session($, world)
  await world.clock.advance(2 * MINUTE)

  const ui = await $.ui.mount(below('terminal', 204))
  const five = await ui.find({ type: 'Text', text: /5h/ })

  expect(five?.text).toContain(' 0%')
  expect(five?.text).not.toContain('24%')
  expect(five?.text).not.toContain('·')
  await ui.unmount()
})

test('sem cor, nada tem fundo e um │ separa as caixas', SLOW, async ($, on) => {
  await session($, engine(on, { env: { PILLBAR_APPEARANCE: 'plain' } }))

  const ui = await $.ui.mount(below('terminal', 204))
  const boxes = await ui.findAll({ type: 'Box' })

  expect(boxes.some(box => 'backgroundColor' in (box.props ?? {}))).toBe(false)
  expect(await ui.findAll({ type: 'Text', text: /^│$/ })).not.toHaveLength(0)
  await ui.unmount()
})

test('sem transcript nem resposta o cache não tem relógio, e o effort vem dos settings', SLOW, async ($, on) => {
  const world = engine(on)
  await start($, world)

  const ui = await $.ui.mount(below('terminal', 204))
  const text = await shown(ui)

  expect(text).toContain('cache –')
  expect(text).toContain('medium')
  await ui.unmount()
})

// ---- o layout ---------------------------------------------------------------

test('o comando define os lados informados de uma linha e deixa o outro como está', () => {
  const left = run(DEFAULT_LAYOUT, 'layout statusLine row(1) left cache,ctx')
  const both = run(left.layout ?? DEFAULT_LAYOUT, 'layout statusLine row(1) right 5h, 7d')

  expect(left.layout?.statusLine['1']).toEqual({ left: ['cache', 'ctx'], right: [] })
  expect(both.layout?.statusLine['1']).toEqual({ left: ['cache', 'ctx'], right: ['5h', '7d'] })
  // Um slug repetido aparece duas vezes.
  expect(run(DEFAULT_LAYOUT, 'layout banner row(0) left cost,cost').layout?.banner['0']).toEqual({ left: ['cost', 'cost'], right: [] })
})

test('o comando limpa um lado, uma linha, uma área ou tudo, e volta ao padrão', () => {
  const set = run(DEFAULT_LAYOUT, 'layout statusLine row(1) right 5h').layout ?? DEFAULT_LAYOUT

  expect(run(set, 'layout statusLine row(1) right clear').layout?.statusLine['1']?.right).toEqual([])
  expect(run(set, 'layout statusLine row(1) clear').layout?.statusLine['1']).toBeUndefined()
  expect(run(set, 'layout statusLine clear').layout?.statusLine).toEqual({})
  expect(run(set, 'layout clear').layout).toEqual({ version: 2, banner: {}, statusLine: {} })
  expect(run(set, 'layout reset').layout).toEqual(DEFAULT_LAYOUT)
})

test('sem o que mudar, o comando mostra a configuração; com erro, diz qual', () => {
  expect(run(DEFAULT_LAYOUT, 'layout').layout).toBeUndefined()
  expect(run(DEFAULT_LAYOUT, 'layout statusLine').text).toContain('row(1): left model, effort, branch, folder')
  expect(run(DEFAULT_LAYOUT, 'layout statusLine row(0)').text).toContain('row(0): left cache, ctx, cost, 5h, 7d')
  expect(run(DEFAULT_LAYOUT, 'layout banner').text).toContain('**banner**: vazio')
  expect(run(DEFAULT_LAYOUT, 'layout statusLine row(1) left cash').text).toContain('Slug desconhecido: `cash`')
  expect(run(DEFAULT_LAYOUT, 'layout statusLine row(9) right').text).toContain('Informe os slugs de `right`')
  expect(run(DEFAULT_LAYOUT, 'layout top').text).toContain('Área desconhecida')
})

test('uma linha não configurada entre duas configuradas fica em branco', () => {
  const layout = run(run(DEFAULT_LAYOUT, 'layout banner row(1) left ctx').layout ?? DEFAULT_LAYOUT, 'layout banner row(3) left cost').layout

  expect(layout === undefined ? [] : rowsOf(layout, 'banner').map(spec => spec?.left[0])).toEqual([undefined, 'ctx', undefined, 'cost'])
  expect(run(layout ?? DEFAULT_LAYOUT, 'layout banner').text).toContain('row(2): em branco')
})

test('o autocomplete sugere a próxima palavra do comando e o slug depois da vírgula', () => {
  const texts = (text: string) => {
    const start = text.lastIndexOf(' ') + 1

    return suggest(text, start, text.slice(start)).map(found => found.text)
  }

  expect(texts('/pillbar la')).toEqual(['layout'])
  expect(texts('/pillbar layout s')).toEqual(['statusLine'])
  expect(texts('/pillbar layout statusLine r')).toContain('row(1)')
  expect(texts('/pillbar layout statusLine row(1) l')).toEqual(['left'])
  expect(texts('/pillbar layout statusLine row(0) r')).toEqual(['right'])
  expect(texts('/pillbar layout statusLine row(1) left cache,c')).toEqual(['cache,cache', 'cache,ctx', 'cache,cost'])
  expect(texts('/pillbar layout statusLine row(1) left cache,ctx r')).toEqual(['right'])
  expect(texts('/outro la')).toEqual([])
})

test('o layout do store decide as linhas: à direita, em branco no meio e repetidas', SLOW, async ($, on) => {
  const layout = {
    version: 2,
    banner: {},
    statusLine: {
      '0': { left: ['cost', 'cost'], right: ['5h', '7d'] },
      '2': { left: ['model'], right: [] },
    },
  }
  await session($, engine(on, { store: { layout } }))

  const ui = await $.ui.mount(below('terminal', 204))
  const first = await ui.find({ type: 'Box', key: 'status-0' })
  const blank = await ui.find({ type: 'Box', key: 'status-1' })
  const third = await ui.find({ type: 'Box', key: 'status-2' })

  // À direita, a linha ocupa a sua largura: 204 menos a margem.
  expect(first?.props).toMatchObject({ width: 200 })
  expect(first?.text.split('$0.58')).toHaveLength(3)
  expect(first?.text.indexOf('$0.58')).toBeLessThan(first?.text.indexOf('5h') ?? 0)
  expect(blank?.props).toMatchObject({ height: 1 })
  expect(blank?.text).toBe('')
  expect(third?.text).toContain('opus-5-5')
  await ui.unmount()
})

test('um layout da numeração antiga perde a linha de dicas, e as outras sobem uma', () => {
  const old = {
    banner: { '0': { left: ['cache'], right: ['ctx'] } },
    statusLine: {
      '0': { left: ['model'], right: [] },
      '1': { left: ['model', 'effort'], right: ['folder', 'branch'] },
      '3': { left: ['cost'], right: [] },
    },
  }

  expect(asLayout(old)).toEqual({
    version: 2,
    banner: { '0': { left: ['cache'], right: ['ctx'] } },
    statusLine: { '0': { left: ['model', 'effort'], right: ['folder', 'branch'] }, '2': { left: ['cost'], right: [] } },
  })
  expect(asLayout(DEFAULT_LAYOUT)).toEqual(DEFAULT_LAYOUT)
})

test('o statusLine começa na linha logo abaixo da de dicas do Claude Code, que fica como está', SLOW, async ($, on) => {
  const layout = { version: 2, banner: {}, statusLine: { '0': { left: ['model'], right: ['effort'] } } }
  await session($, engine(on, { store: { layout } }))

  const ui = await $.ui.mount(below('terminal', 204))
  const tree = (await ui.drawn()) as { children?: unknown[] }

  expect(tree.children?.[0]).toMatchObject({ type: 'Text', children: [ENGINE_HINT] })
  expect((await ui.find({ type: 'Box', key: 'status-0' }))?.text).toMatch(/opus-5-5.*high/)
  await ui.unmount()
})

test('o banner desenha as suas linhas abaixo do que outro mod deixou na faixa', SLOW, async ($, on) => {
  const layout = { version: 2, banner: { '0': { left: ['cache'], right: ['cost'] } }, statusLine: {} }
  await session($, engine(on, { store: { layout }, band: OTHER_MOD }))

  const top = await $.ui.mount(above('terminal', 200))
  const tree = (await top.drawn()) as { children?: unknown[] }

  expect(tree.children?.[0]).toMatchObject(OTHER_MOD)
  expect(await shown(top)).toContain('cache 47m')
  expect((await top.find({ type: 'Box', key: 'banner-0' }))?.props).toMatchObject({ width: 200 })
  await top.unmount()

  // Sem linhas no statusLine, a linha de dicas fica só a do Claude Code.
  const bottom = await $.ui.mount(below('terminal', 204))
  expect(await bottom.drawn()).toMatchObject({ type: 'Text', children: [ENGINE_HINT] })
  await bottom.unmount()
})