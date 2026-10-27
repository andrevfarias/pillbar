"""Desenha as cenas do pillbar (linhas de trechos com cor, vindas de shots.txt) numa
grade de terminal, com a FiraCode Nerd Font Mono, e grava os PNGs do README.

Uso: render.py <shots.txt> <pasta de saída>, ou o shots.ps1, que faz o shots.txt antes.
A FiraCode Nerd Font Mono precisa estar instalada para o usuário; o que ela não tem
sai na Segoe UI Symbol do Windows.
"""

import json
import os
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

FONTS = Path(os.environ['LOCALAPPDATA']) / 'Microsoft' / 'Windows' / 'Fonts'
REGULAR = FONTS / 'FiraCodeNerdFontMono-Regular.ttf'
BOLD = FONTS / 'FiraCodeNerdFontMono-Bold.ttf'
SYMBOLS = Path(os.environ['WINDIR']) / 'Fonts' / 'seguisym.ttf'

SIZE = 26
BACKGROUND = '#161618'
TEXT = '#d4d4d4'
DIM = '#8b8b8b'
BORDER = '#5c5c63'
MODE = '#e8b339'
COLUMNS = 140

regular = ImageFont.truetype(str(REGULAR), SIZE)
bold = ImageFont.truetype(str(BOLD), SIZE)
symbols = ImageFont.truetype(str(SYMBOLS), SIZE - 4)
covered = set(TTFont(str(REGULAR)).getBestCmap())
ascent, descent = regular.getmetrics()
CW = round(regular.getlength('M'))
CH = ascent + descent + 6
PAD_X, PAD_Y = 2 * CW, CH


def scenes(path: Path) -> dict:
    found = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        _, name, data = line.split(' ', 2)
        found[name] = json.loads(data)
    return found


class Grid:
    def __init__(self, cols: int, rows: int):
        self.image = Image.new('RGB', (PAD_X * 2 + cols * CW, PAD_Y * 2 + rows * CH), BACKGROUND)
        self.draw = ImageDraw.Draw(self.image)

    def cell(self, row: int, col: int, ch: str, fg: str | None, bg: str | None, is_bold: bool) -> None:
        x, y = PAD_X + col * CW, PAD_Y + row * CH
        fg = fg or TEXT
        if bg:
            self.draw.rectangle([x, y, x + CW, y + CH - 1], fill=bg)
        if ch in ' \u0000':
            return
        if ch == '\ue0b6':  # ponta esquerda da pílula: meia elipse
            self.draw.pieslice([x, y, x + 2 * CW, y + CH - 1], 90, 270, fill=fg)
        elif ch == '\ue0b4':  # ponta direita
            self.draw.pieslice([x - CW, y, x + CW, y + CH - 1], 270, 90, fill=fg)
        elif ch in '━─':  # as barras e as bordas, como o terminal as desenha: contínuas
            height = max(2, round(CH * (0.14 if ch == '━' else 0.05)))
            top = y + (CH - height) // 2
            self.draw.rectangle([x, top, x + CW, top + height - 1], fill=fg)
        else:
            font = (bold if is_bold else regular) if ord(ch) in covered else symbols
            self.draw.text((x, y + 3), ch, font=font, fill=fg)

    def put(self, row: int, col: int, segs: list) -> int:
        for seg in segs:
            for ch in seg['t']:
                self.cell(row, col, ch, seg.get('fg'), seg.get('bg'), seg.get('b', False))
                col += 1
        return col

    def text(self, row: int, col: int, text: str, fg: str = TEXT) -> int:
        return self.put(row, col, [{'t': text, 'fg': fg}])


def prompt(grid: Grid, row: int, cols: int) -> int:
    """O input do Claude Code e a linha de dicas dele, abaixo: devolve a linha seguinte."""
    grid.text(row, 0, '─' * cols, BORDER)
    grid.text(row + 1, 0, '❯ ', TEXT)
    grid.cell(row + 1, 2, ' ', None, TEXT, False)
    grid.text(row + 2, 0, '─' * cols, BORDER)
    col = grid.text(row + 3, 2, '⏵⏵ auto mode on', MODE)
    grid.text(row + 3, col, ' (shift+tab to cycle)', DIM)
    return row + 4


def trimmed(segs: list) -> list:
    """Os trechos de uma pílula sem o espaço em volta que não é dela."""
    while segs and not segs[-1].get('bg') and not segs[-1]['t'].strip(' \u0000'):
        segs = segs[:-1]
    while segs and not segs[0].get('bg') and not segs[0]['t'].strip(' \u0000'):
        segs = segs[1:]
    return segs


def width(segs: list) -> int:
    return sum(len(seg['t']) for seg in segs)


def main() -> None:
    found = scenes(Path(sys.argv[1]))
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)

    # O layout atual: banner acima do input, statusLine abaixo da linha de dicas.
    custom = found['custom']
    grid = Grid(COLUMNS, 6 + len(custom['status']))
    grid.put(0, 0, custom['banner'][0])
    grid.text(0, COLUMNS - 3, '[-]', DIM)
    row = prompt(grid, 2, COLUMNS)
    for n, segs in enumerate(custom['status']):
        grid.put(row + n, 2, segs)
    grid.image.save(out / 'layout.png', optimize=True)

    # O layout padrão: as duas linhas abaixo da linha de dicas.
    default = found['default']
    grid = Grid(COLUMNS, 4 + len(default['status']))
    row = prompt(grid, 0, COLUMNS)
    for n, segs in enumerate(default['status']):
        grid.put(row + n, 2, segs)
    grid.image.save(out / 'default.png', optimize=True)

    # As pílulas, uma a uma, nos seus estados.
    groups = [
        ['cache-warm', 'cache-working', 'cache-soon', 'cache-cold'],
        ['ctx', 'cost', 'five', 'five-warn', 'week-hot'],
        ['model', 'effort', 'branch'],
    ]
    pills = [[trimmed(found[name]['status'][0]) for name in group] for group in groups]
    cols = max(sum(width(p) for p in group) + 2 * (len(group) - 1) for group in pills)
    grid = Grid(cols, 2 * len(pills) - 1)
    for n, group in enumerate(pills):
        col = 0
        for pill in group:
            col = grid.put(2 * n, col, pill) + 2
    grid.image.save(out / 'pills.png', optimize=True)

    for name in ('layout', 'default', 'pills'):
        with Image.open(out / f'{name}.png') as image:
            print(name, image.size)


if __name__ == '__main__':
    main()
