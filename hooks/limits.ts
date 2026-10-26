// Os limites de 5h e 7d são da conta, não da sessão, mas cada sessão só os lê
// nos cabeçalhos das próprias respostas: parada, ela fica com a última leitura.
// Toda sessão deixa a sua no store do mod, comum a todas, e mostra a mais nova.
// Puro: register.tsx lê e grava o store.

import type { Limit } from '../types'

export const LIMITS_KEY = 'limits'

// Leituras de uma mesma janela podem trazer a renovação com segundos de diferença.
const SAME_WINDOW_MS = 60_000

const isLimit = (value: unknown): value is Limit =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Limit).kind === 'string' &&
  typeof (value as Limit).percent === 'number' &&
  ((value as Limit).resetsAt === undefined || typeof (value as Limit).resetsAt === 'number')

/** O que o store guarda, só as leituras com a forma certa. */
export function asLimits(value: unknown): Limit[] {
  return Array.isArray(value) ? value.filter(isLimit) : []
}

/**
 * A mais nova de duas leituras de um limite, sem saber de quando cada uma é: a
 * da janela que renova depois e, na mesma janela, a de uso maior, porque o uso
 * só sobe dentro dela.
 */
export function newer(a: Limit, b: Limit): Limit {
  if (a.resetsAt !== undefined && b.resetsAt !== undefined && Math.abs(a.resetsAt - b.resetsAt) > SAME_WINDOW_MS) {
    return a.resetsAt > b.resetsAt ? a : b
  }

  if ((a.resetsAt === undefined) !== (b.resetsAt === undefined)) {
    return a.resetsAt === undefined ? b : a
  }

  return b.percent > a.percent ? b : a
}

/** As leituras das duas fontes, a mais nova de cada limite, na ordem em que cada um aparece primeiro. */
export function merge(first: Limit[], second: Limit[]): Limit[] {
  const byKind = new Map<string, Limit>()

  for (const limit of [...first, ...second]) {
    const seen = byKind.get(limit.kind)
    byKind.set(limit.kind, seen === undefined ? limit : newer(seen, limit))
  }

  return [...byKind.values()]
}

/** Um limite cuja janela já renovou vale zero até a próxima leitura, que traz a renovação seguinte. */
export function settled(limits: Limit[], now: number): Limit[] {
  return limits.map(limit =>
    limit.resetsAt !== undefined && now > 0 && limit.resetsAt <= now ? { kind: limit.kind, percent: 0 } : limit,
  )
}
