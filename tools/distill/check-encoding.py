"""编码回归护栏 —— 校验 train.py 的 encoder 与 engine-ai/src/nnue.ts 逐位一致。

为什么需要它：编码约定（90 格 × 14 通道 one-hot + 行棋方）被三处实现共用
（engine-ai/src/nnue.ts 推理、tools/distill/train.py 训练、probe-eval.mjs 体检）。
任何一处漂移都会让"训练时看到的局面"和"推理时看到的局面"不一样，
而且不会报错 —— 只表现为棋力莫名下降。这个项目已经被同类 bug 咬过两次
（m4c 输入 buffer 没清零、更早的坐标换算），所以固化成可一键运行的护栏。

权威源是 nnue.ts 的 encodeFen（金标准文件由它生成，见文件内注释）。

用法：
  python tools/distill/check-encoding.py            # 用 chess venv 的 python
  python tools/distill/check-encoding.py --golden 工具/distill/tests/encoding-golden.txt
"""
import argparse
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--golden", default=os.path.join(HERE, "tests", "encoding-golden.txt"))
    args = ap.parse_args()

    import numpy as np

    import train

    if not os.path.exists(args.golden):
        sys.exit(f"✖ 找不到金标准文件 {args.golden}")

    cases = []
    with open(args.golden, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            fen, want = line.rsplit(";", 1)
            cases.append((fen.strip(), want.strip()))
    if not cases:
        sys.exit("✖ 金标准文件里没有用例")

    print(f"[check] 校验 {len(cases)} 个局面（金标准来自 nnue.ts 的 encodeFen）")
    fail = 0
    for fen, want in cases:
        code, _ = train.parse_labeled_line(f"{fen} ; 0")
        vec = train.expand_codes(code.reshape(1, -1))[0]
        got = hashlib.sha256(vec.tobytes()).hexdigest()[:32]
        if got != want:
            fail += 1
            print(f"  ✖ {fen}\n      want {want}\n      got  {got}")
    print(f"[check] {'全部一致 ✔' if fail == 0 else f'★ {fail} 个不一致 ★'}")

    # 镜像对称性的编码级自检：mirror(mirror(x)) == x
    print("[check] 镜像自反性（mirror∘mirror == id）...")
    bad = 0
    for fen, _ in cases:
        code, _ = train.parse_labeled_line(f"{fen} ; 0")
        twice = train.mirror_code(train.mirror_code(code))
        if not np.array_equal(code, twice):
            bad += 1
            print(f"  ✖ {fen}")
    print(f"[check] {'镜像自反 ✔' if bad == 0 else f'★ {bad} 个不满足 ★'}")

    sys.exit(0 if (fail == 0 and bad == 0) else 1)


if __name__ == "__main__":
    main()
