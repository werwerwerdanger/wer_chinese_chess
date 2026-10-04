# 蒸馏管线③④—— 训练学生网络 + 导出 ONNX
#
# 用法（需 python + torch + onnx，在训练机上）：
#   pip install torch onnx
#   python tools/distill/train.py --data data/merged.txt --out data/model-big.onnx
#
# 模型：FEN 90 格 × 14 棋子 one-hot + 行棋方 → MLP → tanh 分数
# 损失：MSE（教师分过 tanh 压缩，将杀大分不主导梯度）
#
# ★ 2026-10-05 重写为流式加载（原版会 OOM）
#   原版把每条样本都展开成 1261 维 float32 再 np.stack：100 万条 × 2 增广
#   = 10.2 GB，torch.tensor 再拷一份 → 峰值 ~30 GB，16GB 机器必炸。
#   现在只保留 91 字节/条的紧凑编码（90 格棋子 id + 行棋方），
#   展开成 one-hot 在 batch 内做（纯 numpy 向量化，不占常驻内存）。
#   200 万样本常驻内存 ≈ 180 MB，任何机器都跑得动。
#
# ★ 顺带修掉一个静默错误：原版在「增广后的样本」上随机切 train/val，
#   同一局面的镜像副本可能一半进 train 一半进 val → val loss 被乐观污染。
#   现在按「原始局面」切分，镜像跟随原局面同侧，val loss 才是诚实的。
import argparse
import math
import random
import sys
import time

PIECE_ORDER = "RNBAKCP" + "rnbakcp"  # 14 通道：红7 + 黑7（与 nnue.ts 的 PIECE_ORDER 逐位一致）
BOARD_CHARS = set(PIECE_ORDER)
CELLS = 90
VEC_LEN = CELLS * 14 + 1  # 1261


def compress_label(cp: float) -> float:
    """教师分 → tanh 压缩标签。

    ⚠️ 必须压缩（与 nnue.ts 的 `cp = atanh(score) * 1000` 互逆）：
       - 网络的末层是 Tanh，输出天然落在 [-1, 1]；
       - 将杀分是 ±10000，不压缩会让大分局面独占梯度。
       直接拿原始 cp 当标签会让 MSE 变成 cp² 量级（实测 2.8e7），训练完全不收敛。
    """
    return math.tanh(cp / 1000.0)


def parse_labeled_line(line: str):
    """'<fen> ; <score_cp>' → 紧凑编码 (91,) uint8 + tanh 压缩后的标签 float。

    紧凑编码：前 90 字节是每格的「棋子 id + 1」（0 = 空），第 91 字节是行棋方（红=1）。
    比展开成 1261 维 float32 小 55 倍。
    """
    import numpy as np

    fen, s = line.rsplit(";", 1)
    fen = fen.strip()
    parts = fen.split(" ")
    rows = parts[0].split("/")
    if len(rows) != 10:
        raise ValueError(f"bad fen: {fen}")

    code = np.zeros(91, dtype=np.uint8)
    for r, row in enumerate(rows):
        c = 0
        for ch in row:
            if ch.isdigit():
                c += int(ch)
                continue
            pi = PIECE_ORDER.find(ch)
            if pi < 0:
                raise ValueError(f"bad char {ch!r} in {fen}")
            code[r * 9 + c] = pi + 1
            c += 1
        if c != 9:
            raise ValueError(f"row width {c} != 9 in {fen}")
    code[90] = 1 if parts[1] == "w" else 0
    return code, compress_label(float(s))


def _mirror_cells(cells):
    """(N, 90) 棋子格 → 上下翻转（r → 9-r）+ 红黑互换（id ≤ 7 ↔ id + 7）。

    向量化：一次处理整个 batch。注意先转 int16，uint8 下 grid-7 会下溢
    （虽然被 np.where 丢掉，但白算一遍还容易看错）。"""
    import numpy as np

    g = cells.reshape(-1, 10, 9)[:, ::-1, :].reshape(cells.shape)
    return np.where(g == 0, 0, np.where(g <= 7, g + 7, g - 7))


def mirror_code(code):
    """单条紧凑编码的颜色镜像。行棋方互换；标签取反由调用方处理。"""
    import numpy as np

    out = np.empty_like(code)
    out[:CELLS] = _mirror_cells(code[:CELLS].astype(np.int16).reshape(1, -1))[0].astype(np.uint8)
    out[CELLS] = 1 - code[CELLS]
    return out


def load_compact(paths, limit: int = 0, dedup: bool = True):
    """labeled.txt（可多个，逗号分隔）→ (codes (N,91) uint8, labels (N,) float32)。

    多个文件按顺序拼接，然后按紧凑编码去重（同一局面保留先出现的标签）。
    注意这里返回的是「原始局面」；镜像在 batch 里现做，不占额外常驻内存。
    """
    import numpy as np

    codes = []
    labels = []
    bad = 0
    t0 = time.time()
    for path in paths:
        n0 = len(codes)
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or ";" not in line:
                    continue
                try:
                    code, y = parse_labeled_line(line)
                except ValueError:
                    bad += 1
                    continue
                codes.append(code)
                labels.append(y)
                if limit and len(codes) >= limit:
                    break
                if len(codes) % 200000 == 0:
                    print(f"[train]   已读 {len(codes)} 条 ({time.time() - t0:.0f}s)", flush=True)
        print(f"[train]   {path}: {len(codes) - n0} 条", flush=True)
        if limit and len(codes) >= limit:
            break
    if bad:
        print(f"[train]   ⚠ 跳过 {bad} 行无法解析的数据")
    C = np.stack(codes) if codes else np.zeros((0, 91), dtype=np.uint8)
    y = np.array(labels, dtype=np.float32)

    if dedup and len(C) > 1:
        # 同一局面（紧凑编码逐字节相同）只留一条：40 万 + 46 万两个来源本来零重叠，
        # 但 selfplay 数据可能和它们撞车，去重后训练集才是真正的"唯一局面数"。
        _, keep = np.unique(C, axis=0, return_index=True)
        keep.sort()
        if len(keep) < len(C):
            print(f"[train]   去重：{len(C)} → {len(keep)} 条（丢掉 {len(C) - len(keep)} 条重复局面）")
        C, y = C[keep], y[keep]
    return C, y


def expand_codes(codes, mirror_mask=None):
    """紧凑编码 → (B, 1261) float32 one-hot。

    mirror_mask 为等长布尔数组时，对 True 的行先做颜色镜像再展开
    （增广的镜像副本，全程向量化，不占额外常驻内存）。"""
    import numpy as np

    if mirror_mask is not None and mirror_mask.any():
        C = codes.copy()
        C[mirror_mask, :CELLS] = _mirror_cells(
            codes[mirror_mask, :CELLS].astype(np.int16)
        ).astype(np.uint8)
        C[mirror_mask, CELLS] = 1 - codes[mirror_mask, CELLS]
    else:
        C = codes

    B = len(C)
    X = np.zeros((B, VEC_LEN), dtype=np.float32)
    cells = C[:, :CELLS].astype(np.int32)
    colbase = np.arange(CELLS) * 14
    for p in range(1, 15):
        rows, cols = np.nonzero(cells == p)
        if len(rows):
            X[rows, colbase[cols] + (p - 1)] = 1.0
    X[:, VEC_LEN - 1] = C[:, CELLS]
    return X


def build_model(hidden):
    import torch.nn as nn

    layers = []
    prev = VEC_LEN
    for h in hidden:
        layers += [nn.Linear(prev, h), nn.SiLU()]
        prev = h
    layers += [nn.Linear(prev, 1), nn.Tanh()]
    return nn.Sequential(*layers)


def export_onnx(model, out, device):
    """导出 ONNX —— 必须与 nnue.ts 里 onnxruntime-node 能加载的格式一致。

    ⚠️ 现有可用模型是 opset 17 / ir_version 8 / 节点 Gemm+Sigmoid+Mul+Tanh
      （即旧版 TorchScript 导出器 + opset 17）。torch ≥ 2.9 默认改用
      torch.export 新导出器，它需要 onnxscript、且产出的 opset/节点集不同，
      会导致 onnxruntime-node 侧加载失败。所以这里显式指定 dynamo=False +
      opset_version=17；只有在旧导出器被移除（报错）时才回退到新导出器。
    """
    import os

    import torch

    dummy = torch.zeros(1, VEC_LEN, device=device)
    base = dict(
        input_names=["board"], output_names=["score"],
        dynamic_axes={"board": {0: "batch"}, "score": {0: "batch"}},
    )
    attempts = [
        ("legacy/opset17", dict(dynamo=False, opset_version=17)),
        ("default/opset17", dict(opset_version=17)),
    ]
    last_err = None
    for name, extra in attempts:
        if os.path.exists(out):
            os.remove(out)
        try:
            torch.onnx.export(model, dummy, out, **base, **extra)
            print(f"[train] ONNX 导出器: {name}")
            return
        except Exception as e:  # noqa: BLE001
            last_err = e
            print(f"[train] 导出器 {name} 失败：{type(e).__name__}: {str(e)[:200]}")
    raise RuntimeError(
        f"ONNX 导出失败：{last_err}\n"
        f"提示：新版导出器需要 onnxscript —— pip install onnxscript"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/labeled.txt",
                    help="标注数据文件，可用逗号分隔多个（按顺序拼接后去重）")
    ap.add_argument("--out", default="data/model.onnx")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=4096)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--val-frac", type=float, default=0.02)
    ap.add_argument("--hidden", default="1024,512,256",
                    help="隐藏层宽度，逗号分隔。数据大时可放宽，如 2048,1024,512")
    ap.add_argument("--limit", type=int, default=0, help="只读前 N 条（冒烟测试用）")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--log", default="", help="把每个 epoch 的 loss 追加到该文件（画曲线用）")
    ap.add_argument("--no-augment", action="store_true", help="关闭颜色镜像增广")
    ap.add_argument("--no-dedup", action="store_true", help="关闭跨文件局面去重")
    args = ap.parse_args()

    import numpy as np
    import torch
    import torch.nn as nn

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    hidden = [int(x) for x in args.hidden.split(",") if x.strip()]
    print(f"[train] device = {device}  hidden = {hidden}")

    paths = [p.strip() for p in args.data.split(",") if p.strip()]
    print(f"[train] 读取 {len(paths)} 个数据文件：{', '.join(paths)}")
    C, y = load_compact(paths, limit=args.limit, dedup=not args.no_dedup)
    n = len(C)
    if n == 0:
        sys.exit("[train] ✖ 没读到任何样本")
    print(f"[train] 原始局面 {n} 条（流式紧凑编码，常驻 {C.nbytes / 1e6:.0f} MB）")

    # 按「原始局面」切 train/val：镜像副本跟随原局面同侧，避免同局面泄漏到两边
    perm = np.random.permutation(n)
    n_val = max(1, int(n * args.val_frac))
    val_idx = perm[:n_val]
    train_idx = perm[n_val:]
    print(f"[train] train {len(train_idx)} / val {len(val_idx)} 个原始局面"
          f"{'（每个 batch 现做颜色镜像增广，等效样本 ×2）' if not args.no_augment else ''}")

    model = build_model(hidden).to(device)
    n_param = sum(p.numel() for p in model.parameters())
    print(f"[train] 参数 {n_param:,}")
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    loss_fn = nn.MSELoss()

    augment = not args.no_augment
    pt_path = args.out.replace(".onnx", ".pt")
    best_val = float("inf")
    t_start = time.time()
    logf = open(args.log, "a", encoding="utf-8") if args.log else None

    def batch_tensors(idx, mirror_flags=None):
        Xn = expand_codes(C[idx], mirror_flags)
        yn = y[idx].copy()
        if mirror_flags is not None:
            yn[mirror_flags] = -yn[mirror_flags]
        return (torch.from_numpy(Xn).to(device),
                torch.from_numpy(yn).unsqueeze(1).to(device))

    for epoch in range(args.epochs):
        model.train()
        order = np.random.permutation(train_idx)
        total = 0.0
        nb = 0
        for i in range(0, len(order), args.batch):
            bidx = order[i:i + args.batch]
            mm = None
            if augment:
                # 每个 batch 内的样本一半用镜像副本，等效数据集 ×2 且不占常驻内存
                mm = np.random.rand(len(bidx)) < 0.5
            Xb, yb = batch_tensors(bidx, mm)
            pred = model(Xb)
            loss = loss_fn(pred, yb)
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += loss.item() * len(bidx)
            nb += len(bidx)
        sched.step()

        model.eval()
        vloss = 0.0
        vn = 0
        with torch.no_grad():
            for i in range(0, len(val_idx), args.batch):
                bidx = val_idx[i:i + args.batch]
                Xv, yv = batch_tensors(bidx, None)
                vloss += loss_fn(model(Xv), yv).item() * len(bidx)
                vn += len(bidx)
        val_loss = vloss / max(1, vn)

        marker = ""
        if val_loss < best_val:
            best_val = val_loss
            torch.save(model.state_dict(), pt_path)
            marker = "  *best"
        eta = (time.time() - t_start) / (epoch + 1) * (args.epochs - epoch - 1)
        line = (f"[train] epoch {epoch + 1}/{args.epochs}  train {total / max(1, nb):.5f}"
                f"  val {val_loss:.5f}{marker}  剩余约 {eta / 60:.1f} 分钟")
        print(line, flush=True)
        if logf:
            logf.write(f"{epoch + 1}\t{total / max(1, nb):.6f}\t{val_loss:.6f}\n")
            logf.flush()

    if logf:
        logf.close()

    model.load_state_dict(torch.load(pt_path, map_location=device))
    model.eval()
    export_onnx(model, args.out, device)
    print(f"[train] 导出 {args.out}（best val {best_val:.5f}）")
    # y = tanh(cp/1000)，小分处 tanh≈线性 → cp 误差 ≈ 1000 × RMSE(y)。
    # 大分局面因 tanh 压缩会被低估，仅作数量级参考。
    print(f"[train] 粗估平均分差 ≈ {1000 * math.sqrt(best_val):.0f} cp（大分局面低估）")
    print(f"[train] 权重 {pt_path}，ONNX {args.out}")


if __name__ == "__main__":
    main()
