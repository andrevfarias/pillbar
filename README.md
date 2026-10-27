# pillbar

English | [Português](README.pt-BR.md)

Live pills above (`banner`) and below (`statusLine`) the Claude Code prompt: the prompt cache countdown and what rewriting the cache costs, context usage, session cost, the 5h and 7d limits, the model, the effort, the branch and the project folder. Each pill has a slug, and the `/pillbar layout` command sets the row and the side it goes on.

![pillbar: cache, cost, context and limits above the input; model, effort, folder and branch below the hint line](docs/layout.png)

This layout comes from these three commands:

```
/pillbar layout banner row(0) left cache,cost right ctx,5h,7d
/pillbar layout statusLine clear
/pillbar layout statusLine row(0) left model,effort right folder,branch
```

## Installation

At the prompt of a Claude Code session in the terminal:

```
/plugin install pillbar --marketplace andrevfarias/pillbar
```

Answer `y` to add the marketplace and pick the scope.

From the shell:

```
claude plugin install pillbar --marketplace andrevfarias/pillbar
```

In the desktop app, where `/plugin` doesn't run: click the + next to the prompt box, then Plugins, Add marketplace with `andrevfarias/pillbar`, and Add plugin.

The repository is private: installing works only for someone with access to it on GitHub and a git credential for github.com on the machine (an SSH key, or `gh auth login` followed by `gh auth setup-git`). The install doesn't ask for the credential.

## Requirements

- Claude Code with mod support (tested on 2.1.310).
- A Nerd Font in the terminal for the icons and the rounded ends of the pills. Without one, use `PILLBAR_ICONS=unicode`.

## Layout

```
/pillbar layout                                           shows the layout and the slugs
/pillbar layout statusLine row(0) left cache,ctx right 5h,7d
/pillbar layout banner row(0) right cost
/pillbar layout statusLine row(1)                         shows the row
/pillbar layout statusLine row(1) right clear             clears one side
/pillbar layout banner row(0) clear | banner clear | clear | reset
```

- `banner` sits above the prompt; `statusLine`, below the Claude Code hint line. Rows count from `row(0)` to `row(9)`.
- An unset row between two set ones stays blank; a repeated slug shows up twice; a side the command leaves out stays as it is.
- One layout serves every session and project, and a change reaches open sessions within 5 s.
- Autocomplete suggests the next word of the command and, in a list, the slug after the comma.

| Slug | Pill |
| --- | --- |
| `cache` | time left before the cache goes cold and what rewriting it costs (`~`, estimated) |
| `ctx` | context usage |
| `cost` | session cost |
| `5h`, `7d` | account limits, with the reset |
| `model` | model |
| `effort` | effort |
| `branch` | branch, changed files, ahead and behind |
| `folder` | project folder: the full path when it fits, otherwise the name |

The pills and their states: the cache warm, during a turn, in its last minutes and cold; context and cost; the limits below 70%, from 70% and from 90%; the model, the effort and the branch.

![The pillbar pills in their states](docs/pills.png)

The default is `statusLine row(0)` with `cache, ctx, cost, 5h, 7d` and `row(1)` with `model, effort, branch, folder`:

![The pillbar default layout](docs/default.png)

A row that doesn't fit the width drops detail (bars, tokens, long text) instead of wrapping.

## Configuration

| Variable | Values |
| --- | --- |
| `PILLBAR_APPEARANCE` | `dark` (default), `light` or `plain` (no background, theme colors) |
| `PILLBAR_ICONS` | `nerd` (default) or `unicode` |
| `NO_COLOR` | forces `plain` |

## How the numbers are read

- The cache counts from the last request of the main conversation, with the 1h TTL, unless `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, `promptCacheTtl` or `ENABLE_PROMPT_CACHING_1H` sets another one. A resumed session reads the last response from the transcript. The re-warm cost is the whole window at 1.25× the model's input price, the way the Claude Code cost counter charges it.
- The 5h and 7d limits belong to the account: each session leaves its reading in the mod's store, and every session shows the newest one. A window whose reset has passed shows 0% until the next reading.
- A keepwarm ping (cache-tax's, for example) that read the cache restarts the countdown.
