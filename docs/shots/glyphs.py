"""Lista os caracteres das cenas que a FiraCode Nerd Font Mono não tem e diz se a
Segoe UI Symbol, a fonte reserva do render.py, tem cada um. Um caractere que nenhuma
das duas tem sai como um quadrado na imagem.

Uso: glyphs.py <shots.txt>
"""

import sys
from pathlib import Path

from fontTools.ttLib import TTFont

from render import SYMBOLS, covered, scenes

symbols = TTFont(str(SYMBOLS)).getBestCmap()
# O que o render.py escreve por conta própria, além das cenas: o input e a linha de dicas.
chars = set('⏵❯·±↑↓–~$…━─[-]')
for data in scenes(Path(sys.argv[1])).values():
    for area in data.values():
        for row in area:
            for seg in row:
                chars.update(seg['t'])
missing = sorted(c for c in chars if ord(c) not in covered and c not in ' \u0000')
print('faltam na Fira:', [(hex(ord(c)), ord(c) in symbols) for c in missing])
