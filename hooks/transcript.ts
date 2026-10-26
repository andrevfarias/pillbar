// A última resposta da conversa principal, lida do transcript (JSONL) de uma
// sessão: o cache que ela deixou, para a linha não começar em branco quando o mod
// carrega no meio de uma conversa ou numa sessão retomada. Puro: register.tsx lê
// o arquivo.

import type { Ttl } from '../types'
import type { Response } from './cache'

export type Reply = { at: number; usage: Response; ttl?: Ttl }

type Entry = Record<string, unknown>

const isEntry = (value: unknown): value is Entry => typeof value === 'object' && value !== null && !Array.isArray(value)

const count = (value: unknown): number => (typeof value === 'number' ? value : 0)

/** O arquivo do transcript: `<config>/projects/<raiz com cada não-alfanumérico como ->/<sessão>.jsonl`. */
export function transcriptPath(config: string, root: string, sessionId: string): string {
  return `${config}/projects/${root.replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`
}

/**
 * A última resposta principal, de trás para a frente. Uma compactação depois dela
 * trocou a conversa por um resumo, e o cache que ela deixou não vale mais: undefined.
 */
export function lastReply(text: string): Reply | undefined {
  const lines = text.split('\n')

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] ?? ''

    if (line.includes('"compact_boundary"')) {
      return undefined
    }

    if (!line.includes('"assistant"')) {
      continue
    }

    let entry: unknown

    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    if (!isEntry(entry) || entry.type !== 'assistant' || entry.isSidechain === true || typeof entry.timestamp !== 'string') {
      continue
    }

    const message = entry.message
    const at = Date.parse(entry.timestamp)

    if (!isEntry(message) || !isEntry(message.usage) || message.model === '<synthetic>' || Number.isNaN(at)) {
      continue
    }

    const usage = message.usage
    const written = isEntry(usage.cache_creation) ? usage.cache_creation : {}

    return {
      at,
      ttl: count(written.ephemeral_1h_input_tokens) > 0 ? '1h' : count(written.ephemeral_5m_input_tokens) > 0 ? '5m' : undefined,
      usage: {
        input_tokens: count(usage.input_tokens),
        output_tokens: count(usage.output_tokens),
        cache_read_input_tokens: count(usage.cache_read_input_tokens),
        cache_creation_input_tokens: count(usage.cache_creation_input_tokens),
        model: typeof message.model === 'string' ? message.model : undefined,
      },
    }
  }

  return undefined
}
