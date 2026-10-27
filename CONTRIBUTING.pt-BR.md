# Desenvolvimento

[English](CONTRIBUTING.md) | Português

```
claude --plugin-dir <pasta do pillbar>     carrega o mod da pasta
claude plugin validate <pasta do pillbar>
claude plugin test <pasta do pillbar>
pwsh docs/shots/shots.ps1                  regenera as imagens do README
```

As imagens saem do código do mod com dados fictícios: o `shots.ts` monta as cenas pelo `claude plugin test` e o `render.py` as desenha numa grade de terminal. O `shots.ps1` precisa do Python 3 no PATH e da FiraCode Nerd Font Mono instalada no Windows; o `glyphs.py` lista os caracteres das cenas que faltam na fonte.
