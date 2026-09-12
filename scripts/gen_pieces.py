# -*- coding: utf-8 -*-
"""生成中国象棋 PNG 棋子素材（红黑双方 7 种棋子 + 底盘阴影）"""
from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 256  # 高清正方形，前端按需缩放
OUT = os.path.join(os.path.dirname(__file__), '..', 'web', 'public', 'pieces')
os.makedirs(OUT, exist_ok=True)

FONT = ImageFont.truetype('C:/Windows/Fonts/simkai.ttf', 118)

# Piece 编码（与 engine/src/types.ts 一致）
RED = {'帅': 'red_king', '仕': 'red_advisor', '相': 'red_elephant',
       '马': 'red_horse', '车': 'red_rook', '炮': 'red_cannon', '兵': 'red_pawn'}
BLACK = {'将': 'black_king', '士': 'black_advisor', '象': 'black_elephant',
         '马': 'black_horse', '车': 'black_rook', '炮': 'black_cannon', '卒': 'black_pawn'}

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def make_piece(char: str, color: str, name: str):
    img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cy = SIZE // 2
    r = 104  # 棋子主体半径

    # 1. 底部阴影（向下偏移的椭圆）
    sh = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse([cx - r + 4, cy - r + 10, cx + r + 4, cy + r + 10], fill=(0, 0, 0, 70))
    from PIL import ImageFilter
    sh = sh.filter(ImageFilter.GaussianBlur(6))
    img.alpha_composite(sh)

    # 2. 主体：象牙白径向渐变（中心亮 → 边缘暖黄）
    grad = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    inner = (252, 240, 214)   # 中心
    outer = (228, 198, 148)   # 边缘
    for i in range(r, 0, -1):
        t = i / r
        gd.ellipse([cx - i, cy - i, cx + i, cy + i], fill=lerp(inner, outer, 1 - t) + (255,))
    img.alpha_composite(grad)
    # 裁成圆形
    mask = Image.new('L', (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    img.putalpha(Image.composite(img.getchannel('A'), Image.new('L', (SIZE, SIZE), 0), mask))

    # 3. 外圈与内圈描边（红/黑）
    ring = (168, 49, 42) if color == 'red' else (34, 34, 34)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=ring, width=7)
    d.ellipse([cx - r + 14, cy - r + 14, cx + r - 14, cy + r - 14], outline=ring, width=4)

    # 4. 文字（微下移补偿楷体基线）
    text_color = (185, 45, 40) if color == 'red' else (28, 28, 28)
    bbox = d.textbbox((cx, cy), char, font=FONT, anchor='mm')
    # 文字描边：先画放大一点的暗色版本
    d.text((cx + 2, cy + 3), char, font=FONT, anchor='mm', fill=(0, 0, 0, 40))
    d.text((cx, cy + 2), char, font=FONT, anchor='mm', fill=text_color)

    img.save(os.path.join(OUT, f'{name}.png'))
    print(f'{name}.png ok')

for ch, name in RED.items():
    make_piece(ch, 'red', name)
for ch, name in BLACK.items():
    make_piece(ch, 'black', name)
print('all done ->', os.path.abspath(OUT))
