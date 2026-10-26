// O cache de prompt da conversa principal, como a linha o mede pelos tokens de
// cada resposta: quanto tempo falta para esfriar e quanto custa reescrevê-lo.
// Puro: register.tsx guarda o estado em $.state e entrega os fatos aqui.

import type { ModelUsage } from 'claude-code'

import type { Cache, Ttl } from '../types'

export const MINUTE_MS = 60_000
export const TTL_MS: Readonly<Record<Ttl, number>> = { '5m': 5 * MINUTE_MS, '1h': 60 * MINUTE_MS }

// O input base, em dólares por milhão de tokens, pela tabela da Anthropic (2026-10).
const INPUT_USD_PER_MTOK: Readonly<Record<string, number>> = {
  'claude-opus-5-5': 4,
  'claude-sonnet-5-5': 2,
  'claude-haiku-5-5': 0.1,
  'claude-fable-5-1': 10,
  'claude-mythos-5-1': 10,
}
// Preço de cada tipo de token contra o input base. Escrita e saída têm a mesma
// razão em todo modelo; leitura não. O Claude Code cobra toda escrita no cache a
// 1,25×, seja qual for o TTL, e a linha faz igual para bater com o custo que ele mostra.
const WRITE_MULT = 1.25
const OUTPUT_MULT = 5
const READ_MULT: Readonly<Record<string, number>> = {
  'claude-opus-5-5': 0.05,
  'claude-sonnet-5-5': 0.05,
  'claude-fable-5-1': 0.025,
  'claude-mythos-5-1': 0.025,
}
const DEFAULT_READ_MULT = 0.1
// Modelos cujo preço sobe com o tamanho do prompt: acima de `over`, `factor` vezes.
const TIERS: Readonly<Record<string, { over: number; factor: number }>> = {
  'claude-haiku-5-5': { over: 100_000, factor: 5 },
}

// Uma requisição que leu do cache bem menos do que ele guardava errou o cache.
const MISS_MIN_TOKENS = 2000

export type Response = Pick<
  ModelUsage,
  'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'
> & { model?: string }

/** `claude-opus-5-5[1m]` cobra como `claude-opus-5-5`. */
const billedAs = (model: string | undefined): string => (model ?? '').replace(/\[[^\]]*\]$/, '')

function tierFactor(model: string | undefined, prompt: number): number {
  const tier = TIERS[billedAs(model)]

  return tier !== undefined && prompt > tier.over ? tier.factor : 1
}

function weighted(usage: Response): number {
  const read = READ_MULT[billedAs(usage.model)] ?? DEFAULT_READ_MULT
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const tokens =
    usage.input_tokens +
    WRITE_MULT * usage.cache_creation_input_tokens +
    read * usage.cache_read_input_tokens +
    OUTPUT_MULT * usage.output_tokens

  return tokens * tierFactor(usage.model, prompt)
}

export function emptyCache(ttl: Ttl, ttlPinned: boolean): Cache {
  return { requests: 0, lastAt: 0, window: 0, cached: 0, ttl, ttlPinned, weighted: 0 }
}

/** O custo da sessão quando a primeira resposta é contada: a base da taxa. */
export function baselined(cache: Cache, ledger: number | undefined): Cache {
  return cache.costBase === undefined && ledger !== undefined ? { ...cache, costBase: ledger } : cache
}

/**
 * Uma resposta, enviada em `sentAt`. Toda resposta entra na conta da taxa (a de
 * um subagente também, porque o custo da sessão inclui os subagentes); só a da
 * conversa principal mede o cache, porque o prefixo de um subagente é dele.
 */
export function responded(cache: Cache, usage: Response, sentAt: number, isMain: boolean): Cache {
  const next = { ...cache, weighted: cache.weighted + weighted(usage) }

  if (!isMain) {
    return next
  }

  const hit = usage.cache_read_input_tokens
  const gap = cache.requests > 0 ? sentAt - cache.lastAt : 0
  const switched = cache.model !== undefined && usage.model !== undefined && usage.model !== cache.model
  // Uma hora presumida que não leu nada depois de cinco minutos parados era de cinco.
  const wasFive =
    !cache.ttlPinned &&
    cache.ttl === '1h' &&
    !switched &&
    cache.cached >= MISS_MIN_TOKENS &&
    hit === 0 &&
    gap > TTL_MS['5m'] &&
    gap < TTL_MS['1h']

  return {
    ...next,
    requests: cache.requests + 1,
    lastAt: sentAt,
    window: usage.input_tokens + hit + usage.cache_creation_input_tokens + usage.output_tokens,
    cached: hit + usage.cache_creation_input_tokens,
    ttl: wasFive ? '5m' : cache.ttl,
    model: usage.model ?? cache.model,
  }
}

/**
 * Um fork da conversa principal (`$.model.fork`, o ping de um keepwarm): o que ele
 * leu do cache renovou o TTL do prefixo, e ele entra na taxa como toda resposta.
 * Um fork que nada leu achou o cache frio e não o aqueceu para a conversa.
 */
export function pinged(cache: Cache, usage: Response, sentAt: number): Cache {
  if (cache.requests === 0 || usage.cache_read_input_tokens <= 0) {
    return cache
  }

  return { ...cache, lastAt: Math.max(cache.lastAt, sentAt), weighted: cache.weighted + weighted(usage) }
}

/** Quanto falta para o cache esfriar: 0 quando já esfriou, undefined antes da primeira resposta. */
export function leftMs(cache: Cache | null, now: number): number | undefined {
  if (cache === null || cache.requests === 0) {
    return undefined
  }

  return Math.max(0, cache.lastAt + TTL_MS[cache.ttl] - now)
}

/**
 * A taxa por token de um modelo fora da tabela, tirada do próprio custo da sessão:
 *
 *   custo - base = taxa × tokens pesados
 *
 * Undefined sem custo para resolver a taxa.
 */
function solvedRate(cache: Cache, ledger: number | undefined): number | undefined {
  if (ledger === undefined || cache.costBase === undefined || cache.weighted <= 0 || ledger <= cache.costBase) {
    return undefined
  }

  return (ledger - cache.costBase) / cache.weighted
}

/**
 * Quanto custa a próxima mensagem reescrever o cache, em dólares: a janela inteira
 * escrita de novo, ao preço de tabela do modelo ou à taxa resolvida do custo da
 * sessão. Estimativa (o custo da sessão também é a preço de tabela): a linha a
 * mostra sempre com `~`.
 */
export function reWarmUsd(cache: Cache, ledger: number | undefined): number | undefined {
  const listed = INPUT_USD_PER_MTOK[billedAs(cache.model)]
  const rate = listed === undefined ? solvedRate(cache, ledger) : listed / 1_000_000

  if (rate === undefined || cache.window <= 0) {
    return undefined
  }

  return rate * WRITE_MULT * cache.window * tierFactor(cache.model, cache.window)
}

/** A última resposta principal antes deste carregamento, lida do transcript: o cache como ela o deixou. */
export function recalled(cache: Cache, reply: { at: number; usage: Response; ttl?: Ttl }): Cache {
  if (cache.requests > 0) {
    return cache
  }

  const { usage } = reply
  const hit = usage.cache_read_input_tokens

  return {
    ...cache,
    requests: 1,
    lastAt: reply.at,
    window: usage.input_tokens + hit + usage.cache_creation_input_tokens + usage.output_tokens,
    cached: hit + usage.cache_creation_input_tokens,
    ttl: cache.ttlPinned ? cache.ttl : (reply.ttl ?? cache.ttl),
    model: usage.model ?? cache.model,
  }
}

/** O TTL que o ambiente ou os settings fixam, na ordem do Claude Code; undefined quando nada fixa. */
export function pinnedTtl(env: {
  force5m: string | undefined
  chosen: string | undefined
  setting: unknown
  enable1h: string | undefined
}): Ttl | undefined {
  const asTtl = (value: unknown): Ttl | undefined => (value === '5m' || value === '1h' ? value : undefined)

  if (env.force5m === '1') {
    return '5m'
  }

  return asTtl(env.chosen) ?? asTtl(env.setting) ?? (env.enable1h === '1' ? '1h' : undefined)
}
