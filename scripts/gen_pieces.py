# -*- coding: utf-8 -*-
"""生成中国象棋 PNG 棋子素材 v2 — 仿天天象棋视觉风格（自绘，非提取）

质感要点（照着手游棋子的渲染思路自己做）：
- 主体：木色径向渐变 + 顶部偏移的亮斑（受光面）+ 底部暗弧（背光面）
- 外环：粗主环 + 细内环，颜色饱和（红/黑），带轻微立体（上亮下暗双色环）
- 文字：大号楷体，白色描边 + 色字，中心偏上留出底部反光
- 阴影：向下偏移椭圆 + 高斯模糊
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

SIZE = 256
OUT = os.path.join(os.path.dirname(__file__), '..', 'web', 'public', 'pieces')
os.makedirs(OUT, exist_ok=True)

FONT = ImageFont.truetype('C:/Windows/Fonts/simkai.ttf', 122)

RED = {'帅': 'red_king', '仕': 'red_advisor', '相': 'red_elephant',
       '马': 'red_horse', '车': 'red_rook', '炮': 'red_cannon', '兵': 'red_pawn'}
BLACK = {'将': 'black_king', '士': 'black_advisor', '象': 'black_elephant',
         '马': 'black_horse', '车': 'black_rook', '炮': 'black_cannon', '卒': 'black_pawn'}

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def make_piece(char: str, color: str, name: str):
    img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    cx = cy = SIZE // 2
    r = 106

    # ---- 1. 投影：向下偏移 + 模糊 ----
    sh = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse([cx - r + 3, cy - r + 12, cx + r + 3, cy + r + 12], fill=(0, 0, 0, 90))
    sh = sh.filter(ImageFilter.GaussianBlur(7))
    img.alpha_composite(sh)

    # ---- 2. 主体：木色渐变 ----
    # 天天象棋风：亮木色面 (255,236,190) 中心 → (232,196,140) 中段 → (196,152,96) 边缘
    body = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    bd = ImageDraw.Draw(body)
    c_in, c_mid, c_out = (255, 238, 196), (238, 206, 152), (198, 154, 98)
    for i in range(r, 0, -1):
        t = i / r
        col = lerp(c_in, c_mid, t * 1.6) if t < 0.62 else lerp(c_mid, c_out, (t - 0.62) / 0.38)
        bd.ellipse([cx - i, cy - i, cx + i, cy + i], fill=col + (255,))

    # ---- 3. 顶部受光：中心上移的亮斑 ----
    hl = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    for i in range(r * 3 // 4, 0, -2):
        a = int(46 * (1 - i / (r * 0.75)) + 6)
        hd.ellipse([cx - i, cy - i - r // 3, cx + i, cy + i - r // 3], fill=(255, 255, 240, a))
    hl = hl.filter(ImageFilter.GaussianBlur(10))
    # 裁回圆内再叠加
    mask = Image.new('L', (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    body.paste(hl, (0, 0), Image.composite(hl.getchannel('A'), Image.new('L', (SIZE, SIZE), 0), mask))

    # ---- 4. 底部背光：下弧暗带 ----
    dk = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dk)
    for i in range(r * 3 // 4, 0, -2):
        a = int(38 * (1 - i / (r * 0.75)) + 5)
        dd.ellipse([cx - i, cy - i + r // 3, cx + i, cy + i + r // 3], fill=(120, 80, 30, a))
    dk = dk.filter(ImageFilter.GaussianBlur(10))
    body.paste(dk, (0, 0), Image.composite(dk.getchannel('A'), Image.new('L', (SIZE, SIZE), 0), mask))

    img.alpha_composite(body)

    # ---- 5. 双环描边（带上亮下暗立体感） ----
    d = ImageDraw.Draw(img)
    if color == 'red':
        ring_main, ring_light = (196, 40, 33), (230, 90, 80)
        text_col = (178, 34, 28)
    else:
        ring_main, ring_light = (40, 36, 32), (90, 84, 76)
        text_col = (30, 28, 26)
    # 主环（粗）+ 亮色上半弧 + 细内环
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=ring_main, width=9)
    # 上半弧高光：手动画弧线段（PIL arc 从 -90° 到 90° 是右半，需调）
    arc_img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    ad = ImageDraw.Draw(arc_img)
    ad.arc([cx - r, cy - r, cx + r, cy + r], start=180, end=360, fill=ring_light + (160,), width=9)
    arc_img = arc_img.filter(ImageFilter.GaussianBlur(1.5))
    img.alpha_composite(arc_img)
    d = ImageDraw.Draw(img)
    d.ellipse([cx - r + 16, cy - r + 16, cx + r - 16, cy + r - 16], outline=ring_main, width=4)

    # ---- 6. 文字：白描边 + 色字 ----
    # 白色描边（stroke_width 沿字形外扩）
    d.text((cx, cy + 2), char, font=FONT, anchor='mm',
           fill=text_col, stroke_width=6, stroke_fill=(255, 252, 240))
    # 轻微下移的投影提高立体感
    d.text((cx, cy + 4), char, font=FONT, anchor='mm',
           fill=None)  # 占位防 lint；实际投影已由 stroke 承担
    # 重画一遍主体字（stroke 之上）
    d.text((cx, cy + 1), char, font=FONT, anchor='mm',
           fill=text_col, stroke_width=2, stroke_fill=(255, 252, 240))

    img.save(os.path.join(OUT, f'{name}.png'))
    print(f'{name}.png ok')

for ch, name in RED.items():
    make_piece(ch, 'red', name)
for ch, name in BLACK.items():
    make_piece(ch, 'black', name)
print('v2 all done ->', os.path.abspath(OUT))
