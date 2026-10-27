# Development

English | [Português](CONTRIBUTING.pt-BR.md)

```
claude --plugin-dir <pillbar folder>       loads the mod from the folder
claude plugin validate <pillbar folder>
claude plugin test <pillbar folder>
pwsh docs/shots/shots.ps1                  regenerates the README images
```

The images come from the mod's code with made-up data: `shots.ts` builds the scenes through `claude plugin test`, and `render.py` draws them on a terminal grid. `shots.ps1` needs Python 3 on the PATH and FiraCode Nerd Font Mono installed on Windows; `glyphs.py` lists the scene characters the font lacks.
