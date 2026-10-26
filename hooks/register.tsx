import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, SessionUsage, Timer } from 'claude-code'

import type { Layout, Limit, Look, Snapshot, Workspace } from '../types'
import { MINUTE_MS, baselined, emptyCache, leftMs, pinged, pinnedTtl, recalled, responded } from './cache'
import { parseStatus } from './git'
import type { Git } from './git'
import { DEFAULT_LAYOUT, LAYOUT_KEY, asLayout, rowsOf, run, suggest } from './layout'
import { LIMITS_KEY, asLimits, merge, settled } from './limits'
import { drawRow } from './line'
import type { LineInput } from './line'
import { lastReply, transcriptPath } from './transcript'

// O engine só empurra `session.measure` ao fim de cada turno; durante o turno o
// contexto cresce a cada resposta, então a leitura (gratuita) é feita em ciclo.
// O ciclo é de um segundo, o passo do relógio do cache nos últimos dez minutos.
const POLL_MS = 1000
// O git roda a cada tantos ciclos, além do início da sessão e do fim de cada turno.
const GIT_EVERY = 30
// A leitura comum dos limites é relida a cada tantos ciclos.
const SHARED_EVERY = 5
const PROCESS_TIMEOUT_MS = 5000
const CLOSE_MS = 10 * MINUTE_MS
// A linha do engine tem margem: as pílulas não encostam na borda.
const MARGIN = 4

const DEFAULT_LOOK: Look = { appearance: 'dark', icons: 'nerd' }
const NO_WORKSPACE: Workspace = { dirty: 0, ahead: 0, behind: 0 }

const snapshot = atom({ plugin: 'pillbar', key: 'snapshot' } as const, null)
const cache = atom({ plugin: 'pillbar', key: 'cache' } as const, null)
const workspace = atom({ plugin: 'pillbar', key: 'workspace' } as const, NO_WORKSPACE)
const look = atom({ plugin: 'pillbar', key: 'look' } as const, DEFAULT_LOOK)
const layout = atom({ plugin: 'pillbar', key: 'layout' } as const, DEFAULT_LAYOUT)
const clock = atom({ plugin: 'pillbar', key: 'clock' } as const, 0)

type Figures = Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>

let timer: Timer | undefined
let ticks = 0
let lastKey = ''
let lastClock = 0
let lastModel = ''
// A leitura dos limites que esta sessão deixou no store por último, e a comum a todas.
let lastOwn = ''
let shared: Limit[] = []
let lastLayout = ''
// O diretório em que a sessão começou, que dá a pasta do transcript, e o estado
// do transcript na última leitura.
let sessionCwd: string | undefined
let lastTranscript = ''

function ownLimits(figures: Figures): Limit[] {
  return figures.rateLimits.map(limit => {
    const resetsAt = limit.resetsAt === undefined ? NaN : Date.parse(limit.resetsAt)

    return {
      kind: limit.kind,
      percent: limit.percentUsed,
      resetsAt: Number.isNaN(resetsAt) ? undefined : resetsAt,
    }
  })
}

function toSnapshot(figures: Figures, limits: Limit[]): Snapshot {
  return {
    tokens: figures.context.tokens,
    window: figures.context.window,
    percent: figures.context.percent,
    limits,
    usd: figures.cost?.usd,
  }
}

/** Deixa no store a leitura desta sessão quando ela muda, sobre o que as outras deixaram. */
async function share($: EngineInterface, own: Limit[]): Promise<void> {
  const key = JSON.stringify(own)

  if (key === lastOwn || own.length === 0) {
    return
  }

  lastOwn = key

  const stored = asLimits(await $.store.get(LIMITS_KEY))
  const next = merge(stored, own)

  shared = next

  if (JSON.stringify(next) !== JSON.stringify(stored)) {
    await $.store.set(LIMITS_KEY, next)
  }
}

async function store($: EngineInterface, figures: Figures, now: number): Promise<void> {
  const own = ownLimits(figures)

  await share($, own).catch(() => undefined)

  const next = toSnapshot(figures, settled(merge(own, shared), now))
  const key = JSON.stringify(next)

  if (key !== lastKey) {
    lastKey = key
    await update($, snapshot, () => next)
  }
}

/** Avança o relógio da linha só quando o que ela mostra muda: a cada minuto, e a cada segundo nos últimos dez do cache. */
async function tick($: EngineInterface, now: number): Promise<void> {
  const left = leftMs(await read($, cache), now)
  const step = left !== undefined && left > 0 && left < CLOSE_MS ? 1000 : MINUTE_MS
  const at = Math.floor(now / step) * step

  if (at !== lastClock) {
    lastClock = at
    await update($, clock, () => at)
  }
}

/** Grava no ambiente só os campos que mudaram, sobre o que estiver lá: assim nada redesenha à toa. */
async function note($: EngineInterface, changes: Partial<Workspace>): Promise<void> {
  const current = await read($, workspace)
  const changed = (Object.keys(changes) as (keyof Workspace)[]).some(field => changes[field] !== current[field])

  if (changed) {
    await update($, workspace, latest => ({ ...latest, ...changes }))
  }
}

async function gitStatus($: EngineInterface, cwd: string | undefined): Promise<Git | undefined> {
  try {
    const result = await $.process.run(
      ['git', '-c', 'core.fsmonitor=false', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'],
      { cwd, timeoutMs: PROCESS_TIMEOUT_MS },
    )

    return result.exitCode === 0 ? parseStatus(result.stdout) : undefined
  } catch {
    return undefined
  }
}

async function readWorkspace($: EngineInterface): Promise<void> {
  const root = await $.session.root().catch(() => undefined)
  const git = await gitStatus($, root)

  await note($, {
    project: root,
    branch: git?.branch,
    dirty: git?.dirty ?? 0,
    ahead: git?.ahead ?? 0,
    behind: git?.behind ?? 0,
  })
}

async function refresh($: EngineInterface): Promise<void> {
  try {
    const now = await $.clock.now()

    await store($, await $.session.usage(), now)
    await tick($, now)

    const model = await $.session.model().catch(() => undefined)

    if (model !== undefined && model !== lastModel) {
      lastModel = model
      await note($, { model })
    }

    ticks += 1

    // O que as outras sessões leram dos limites da conta, para esta não ficar parada
    // na sua última leitura, e o layout que um /pillbar em outra sessão mudou.
    if (ticks % SHARED_EVERY === 0) {
      shared = asLimits(await $.store.get(LIMITS_KEY).catch(() => undefined))
      await readLayout($)
      // Até a primeira resposta, o cache vem do transcript, que numa retomada chega depois.
      await recall($)
    }

    if (ticks % GIT_EVERY === 0) {
      await readWorkspace($)
    }
  } catch {
    // Sem leitura agora (sessão encerrando, recarga): o próximo ciclo tenta de novo.
  }
}

async function readLook($: EngineInterface): Promise<Look> {
  const appearance = (await $.env.get('PILLBAR_APPEARANCE'))?.toLowerCase()
  const icons = (await $.env.get('PILLBAR_ICONS'))?.toLowerCase()
  const noColor = await $.env.get('NO_COLOR')

  return {
    appearance: noColor ? 'plain' : appearance === 'light' || appearance === 'plain' ? appearance : 'dark',
    icons: icons === 'unicode' ? 'unicode' : 'nerd',
  }
}

/** O TTL que o ambiente ou os settings fixam; sem fixação, a hora, até uma resposta mostrar que eram cinco minutos. */
async function configureCache($: EngineInterface, settings: Readonly<Record<string, unknown>> | undefined): Promise<void> {
  const pinned = pinnedTtl({
    force5m: await $.env.get('FORCE_PROMPT_CACHING_5M'),
    chosen: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL'),
    setting: settings?.promptCacheTtl,
    enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H'),
  })

  await update($, cache, current => {
    if (current === null) {
      return emptyCache(pinned ?? '1h', pinned !== undefined)
    }

    return pinned === undefined ? current : { ...current, ttl: pinned, ttlPinned: true }
  })
}

/**
 * Carregado no meio de uma conversa (recarga, sessão retomada, /resume), o mod
 * não viu a última resposta: ela vem do transcript, que fica na pasta do projeto
 * pelo diretório em que a sessão começou. Numa sessão retomada o Claude Code só
 * grava o transcript depois de avisar que a sessão começou, então o ciclo tenta
 * de novo enquanto nenhuma resposta foi vista, relendo o arquivo só quando ele muda.
 */
async function recall($: EngineInterface): Promise<void> {
  if (sessionCwd === undefined || ((await read($, cache))?.requests ?? 0) > 0) {
    return
  }

  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home === undefined ? undefined : `${home}/.claude`)

    if (config === undefined) {
      return
    }

    const path = transcriptPath(config, sessionCwd, await $.session.id())
    const stat = await $.fs.stat(path)
    const seen = `${path}|${stat.size}|${stat.mtimeMs}`

    if (seen === lastTranscript) {
      return
    }

    lastTranscript = seen

    const reply = lastReply(await $.fs.read(path))

    if (reply !== undefined) {
      await update($, cache, current => recalled(current ?? emptyCache('1h', false), reply))
    }
  } catch {
    // Sem transcript ainda (sessão nova, retomada antes de gravá-lo, outra pasta de config).
  }
}

/** O effort dos settings: o do modelo em `modelSettings`, se houver, senão o geral. */
function effortSetting(settings: Readonly<Record<string, unknown>> | undefined, models: (string | undefined)[]): string | undefined {
  const perModel = settings?.modelSettings

  for (const model of models) {
    const name = model?.replace(/\[[^\]]*\]$/, '')
    const entry = name === undefined || typeof perModel !== 'object' || perModel === null ? undefined : (perModel as Record<string, unknown>)[name]
    const level = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).effortLevel : undefined

    if (typeof level === 'string') {
      return level
    }
  }

  return typeof settings?.effortLevel === 'string' ? settings.effortLevel : undefined
}

async function ledger($: EngineInterface): Promise<number | undefined> {
  return (await $.session.usage().catch(() => undefined))?.cost?.usd
}

/** O que as linhas desenham, lido do estado: a leitura inscreve quem desenha, que redesenha quando ele muda. */
async function lineInput($: EngineInterface, surface: string, isWorking: boolean): Promise<LineInput> {
  return {
    surface,
    isWorking,
    now: (await read($, clock)) || (await $.clock.now()),
    snapshot: await read($, snapshot),
    cache: await read($, cache),
    workspace: await read($, workspace),
    look: await read($, look),
  }
}

/** O layout do store, comum a todas as sessões; o padrão enquanto ninguém o mudou. */
async function readLayout($: EngineInterface): Promise<void> {
  const stored = asLayout(await $.store.get(LAYOUT_KEY).catch(() => undefined)) ?? DEFAULT_LAYOUT
  const key = JSON.stringify(stored)

  if (key !== lastLayout) {
    lastLayout = key
    await update($, layout, () => stored)
  }
}

async function saveLayout($: EngineInterface, next: Layout): Promise<void> {
  await $.store.set(LAYOUT_KEY, next)
  lastLayout = JSON.stringify(next)
  await update($, layout, () => next)
}

/** O que o engine e os mods abaixo deste deixaram na faixa acima do prompt: nada, quando é uma Box vazia. */
function drewNothing(tree: RenderElement): boolean {
  return tree.type === 'Box' && !('children' in tree && Array.isArray(tree.children) && tree.children.length > 0)
}

function effortOf(effort: string | number | undefined): string | undefined {
  return effort === undefined ? undefined : String(effort)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    timer?.cancel()
    timer = $.clock.every(POLL_MS, () => void refresh($))
    void $.command
      .register({
        name: 'pillbar',
        description: 'Organiza as pílulas do pillbar em linhas acima (banner) e abaixo (statusLine) do prompt',
        argumentHint: 'layout [banner|statusLine] [row(N)] [left|right <slugs>|clear] | clear | reset',
      })
      .catch(() => undefined)

    const settings = await $.settings.read().catch(() => undefined)
    const chosen = await readLook($)

    sessionCwd = e.cwd
    lastTranscript = ''
    await update($, look, () => chosen)
    await configureCache($, settings)
    await recall($)
    await readLayout($)
    shared = asLimits(await $.store.get(LIMITS_KEY).catch(() => undefined))

    // Até a primeira requisição dizer o effort em uso, o dos settings para o modelo
    // da sessão, ou o da última resposta, quando o da sessão é um apelido.
    const effort = effortSetting(settings, [await $.session.model().catch(() => undefined), (await read($, cache))?.model])

    if (effort !== undefined && (await read($, workspace)).effort === undefined) {
      await note($, { effort })
    }

    void refresh($)
    void readWorkspace($)

    return started
  })

  on('session.measure', async ($, e, next) => {
    await store($, e, await $.clock.now())

    return next(e)
  })

  // /clear e /resume encerram a conversa, não o processo, e nenhum session.start
  // vem depois: o ciclo continua, e o cache recomeça com a conversa nova.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      await update($, cache, current => emptyCache(current?.ttlPinned ? current.ttl : '1h', current?.ttlPinned ?? false))
      void readWorkspace($)
    } else {
      timer?.cancel()
      timer = undefined
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // O TTL do cache corre de quando a requisição sai, não de quando a resposta termina.
    const sentAt = await $.clock.now()
    const isMain = e.agentId === undefined

    if ((await read($, cache))?.costBase === undefined) {
      const spent = await ledger($)
      await update($, cache, current => baselined(current ?? emptyCache('1h', false), spent))
    }

    if (isMain) {
      await note($, { effort: effortOf(e.effort) })
    }

    const result = yield* next(e)
    const usage = result?.usage

    if (usage) {
      await update($, cache, current => responded(current ?? emptyCache('1h', false), usage, sentAt, isMain))
    }

    return result
  })

  // Um ping de outro mod (o keepwarm do cache-tax) que leu o cache da conversa o
  // manteve quente: o relógio recomeça dali.
  on('model.fork', async ($, e, next) => {
    const sentAt = await $.clock.now()
    const result = await next(e)
    const answer = 'value' in result ? result.value : undefined

    if (answer !== undefined && 'usage' in answer) {
      const { usage } = answer
      await update($, cache, current => (current === null ? current : pinged(current, usage, sentAt)))
    }

    return result
  })

  // Um turno pode ter trocado de branch, commitado ou mudado arquivos.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined) {
      void readWorkspace($)
    }

    return result
  })

  on('command.run', { command: 'pillbar' }, async ($, e) => {
    const result = run(await read($, layout), e.args)

    if (result.layout !== undefined) {
      await saveLayout($, result.layout)
    }

    return { text: result.text }
  })

  // Enquanto se digita `/pillbar ...`: a próxima palavra do comando, ou o slug depois da vírgula.
  on('prompt.autocomplete', async ($, e, next) => {
    const result = await next(e)
    const mine = suggest(e.text, e.start, e.token)

    return mine.length === 0 ? result : { suggestions: [...mine, ...result.suggestions] }
  })

  // banner: as linhas acima do prompt, abaixo do que outros mods desenham ali (a
  // linha do cache-tax); um questionário que ocupa a faixa tem a vez. O engine
  // deixa uma linha em branco entre ela e o input, e um mod não desenha nela.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const rows = rowsOf(await read($, layout), 'banner')

    if (e.props.hasSurvey || rows.length === 0) {
      return rest
    }

    const el = $.ui.resolve(e)
    const { Box } = el
    const input = await lineInput($, e.surface, e.props.isWorking)

    return (
      <Box flexDirection="column">
        {drewNothing(rest) ? null : rest}
        {rows.map((spec, n) => drawRow(el, input, spec, e.props.bodyColumns, `banner-${n}`))}
      </Box>
    )
  })

  // statusLine: as linhas abaixo da linha de dicas do Claude Code, que fica como
  // está (o indicador de modo, o `esc to interrupt` e os pills dela continuam
  // dele), sem linha em branco entre elas.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const line = await next(e)
    const rows = rowsOf(await read($, layout), 'statusLine')

    if (rows.length === 0) {
      return line
    }

    const el = $.ui.resolve(e)
    const { Box } = el
    const input = await lineInput($, e.surface, e.props.isWorking)
    const room = (e.viewport?.columns ?? 120) - MARGIN

    return (
      <Box flexDirection="column">
        {line}
        {rows.map((spec, n) => drawRow(el, input, spec, room, `status-${n}`))}
      </Box>
    )
  })
}
