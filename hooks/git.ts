// O estado do git que a linha mostra, lido da saída de
// `git status --porcelain=v2 --branch`. Puro: register.tsx roda o comando.

export type Git = { branch: string; dirty: number; ahead: number; behind: number }

/** A branch (ou o commit curto, com HEAD destacado), os arquivos alterados e o quanto está à frente e atrás. */
export function parseStatus(stdout: string): Git | undefined {
  let head: string | undefined
  let oid: string | undefined
  let ahead = 0
  let behind = 0
  let dirty = 0

  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) {
      head = line.slice('# branch.head '.length)
    } else if (line.startsWith('# branch.oid ')) {
      oid = line.slice('# branch.oid '.length)
    } else if (line.startsWith('# branch.ab ')) {
      const counts = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line)
      ahead = Number(counts?.[1] ?? 0)
      behind = Number(counts?.[2] ?? 0)
    } else if (line !== '' && !line.startsWith('#')) {
      dirty += 1
    }
  }

  if (head === undefined) {
    return undefined
  }

  const detached = oid !== undefined && oid !== '(initial)' ? oid.slice(0, 7) : 'HEAD'

  return { branch: head === '(detached)' ? detached : head, dirty, ahead, behind }
}
