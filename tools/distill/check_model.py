"""model.onnx 健全性检查：加载 + 开局/残局推理，验证分数方向（红优势应为正）。"""
import math
import sys

import numpy as np
import onnxruntime as ort

PIECE_ORDER = "RNBAKCP" + "rnbakcp"


def encode_fen(fen: str):
    rows = fen.split(" ")[0].split("/")
    assert len(rows) == 10, f"bad fen: {fen}"
    x = np.zeros(90 * 14 + 1, dtype=np.float32)
    for r, row in enumerate(rows):
        c = 0
        for ch in row:
            if ch.isdigit():
                c += int(ch)
                continue
            assert ch in set(PIECE_ORDER), f"bad char {ch!r} in {fen}"
            x[(r * 9 + c) * 14 + PIECE_ORDER.index(ch)] = 1.0
            c += 1
        assert c == 9, f"row width {c} != 9 in {fen}"
    x[-1] = 1.0 if fen.split(" ")[1] == "w" else 0.0  # 引擎 FEN 用 w/b
    return x


sess = ort.InferenceSession(r"C:\Users\20633\WorkBuddy\2026-09-12-10-08-27\wer_chinese_chess\data\model.onnx")
inp = {i.name: None for i in sess.get_inputs()}

def score(fen: str) -> float:
    x = encode_fen(fen)[None, :]
    out = sess.run(None, {sess.get_inputs()[0].name: x})[0][0][0]
    return float(out)

cases = [
    # (fen, 描述)  分数 = 红方视角 tanh 值
    ("rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w", "开局（红先，理想≈0）"),
    ("rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b", "开局（黑先）"),
    ("4k4/9/9/9/4R4/9/9/9/9/4K4 w", "红多一车（应明显为正）"),
    ("4k4/9/9/9/9/3r5/9/9/4K4/9 w", "黑多一车（应明显为负）"),
    ("2Rak4/9/9/9/9/9/9/9/9/4K4 w", "红车直指黑将旁（应大正）"),
]

ok = True
for fen, desc in cases:
    s = score(fen)
    print(f"{desc:32s} tanh={s:+.4f}  cp≈{math.atanh(max(-0.999, min(0.999, s))) * 1000:+.0f}")

# 方向断言：子力优势方向必须正确
s_red_up = score("4k4/9/9/9/4R4/9/9/9/9/4K4 w")
s_black_up = score("4k4/9/9/9/9/3r5/9/9/4K4/9 w")
assert s_red_up > 0.1, f"红多一车应为正，实际 {s_red_up}"
assert s_black_up < -0.1, f"黑多一车应为负，实际 {s_black_up}"
print("ONNX 健全性检查通过 ✓（方向性正确）")
