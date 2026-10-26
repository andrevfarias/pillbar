export type Limit = { kind: string; percent: number; resetsAt?: number }

export type Snapshot = {
  tokens?: number
  window: number
  percent?: number
  limits: Limit[]
  usd?: number
}

export type Ttl = '5m' | '1h'

/** O cache de prompt da conversa principal, medido pelos tokens de cada resposta. */
export type Cache = {
  /** Requisições da conversa principal já vistas. */
  requests: number
  /** Quando a última requisição da conversa principal saiu, em ms. */
  lastAt: number
  /** A janela inteira dessa requisição, resposta incluída: o que um re-warm reescreve. */
  window: number
  /** O que essa requisição deixou no cache (lido + escrito). */
  cached: number
  ttl: Ttl
  /** TTL fixado por variável de ambiente ou settings: nunca inferido. */
  ttlPinned: boolean
  /** O modelo que respondeu por último, como a API o nomeia. */
  model?: string
  /** Tokens de toda resposta desde a base, pesados pelo preço contra o input base. */
  weighted: number
  /** O custo da sessão quando a contagem começou. */
  costBase?: number
}

export type Workspace = {
  model?: string
  effort?: string
  /** A raiz do projeto, o caminho inteiro. */
  project?: string
  branch?: string
  dirty: number
  ahead: number
  behind: number
}

export type Look = {
  appearance: 'dark' | 'light' | 'plain'
  icons: 'nerd' | 'unicode'
}

/** As pílulas de uma linha, pelos slugs, alinhadas à esquerda e à direita; um slug repetido aparece duas vezes. */
export type RowSpec = { left: string[]; right: string[] }

/**
 * Onde cada pílula fica: `banner` acima do prompt, `statusLine` abaixo da linha de
 * dicas do Claude Code, cada área com as suas linhas por número, a partir de 0.
 * Uma linha sem configuração entre duas configuradas fica em branco. `version`
 * diz a numeração: sem ela, a antiga, em que o `statusLine row(0)` era a linha de dicas.
 */
export type Layout = { version?: number; banner: Record<string, RowSpec>; statusLine: Record<string, RowSpec> }

declare module 'claude-code' {
  interface PluginState {
    'pillbar': {
      snapshot: Snapshot | null
      cache: Cache | null
      workspace: Workspace
      look: Look
      layout: Layout
      /** O relógio da linha, arredondado ao passo em que ela muda: minuto ou segundo. */
      clock: number
    }
  }
}
