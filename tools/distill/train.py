# 蒸馏管线③④—— 训练学生网络 + 导出 ONNX
#
# 用法（需 python + torch + onnx + onnxruntime，在 4080 机器上）：
#   pip install torch onnx onnxruntime
#   python tools/distill/train.py --data data/labeled.txt --out model.onnx
#
# 模型：FEN 90 格 × 14 棋子 one-hot + 行棋方 → MLP → tanh 分数
# 损失：MSE（教师分过 tanh 压缩，将杀大分不主导梯度）
import argparse
import math
import random

FEN_CHARS = "RNBAKCP rnba kcp ".replace(" ", "")  # 占位，真实映射见 PIECE_ORDER
PIECE_ORDER = "RNBAKCP" + "rnbakcp"  # 14 通道：红7 + 黑7
BOARD_CHARS = set(PIECE_ORDER)


def encode_fen(fen: str):
    """FEN → (1261,) float 向量。90 格 × 14 通道 one-hot 展平 + 行棋方 1 维。"""
    import numpy as np

    rows = fen.split(" ")[0].split("/")
    assert len(rows) == 10, f"bad fen: {fen}"
    x = np.zeros(90 * 14 + 1, dtype=np.float32)
    for r, row in enumerate(rows):
        c = 0
        for ch in row:
            if ch.isdigit():
                c += int(ch)
                continue
            assert ch in BOARD_CHARS, f"bad char {ch!r} in {fen}"
            pi = PIECE_ORDER.index(ch)
            x[(r * 9 + c) * 14 + pi] = 1.0
            c += 1
        assert c == 9, f"row width {c} != 9 in {fen}"
    side = 1.0 if fen.split(" ")[1] == "w" else 0.0  # 引擎 FEN 用 w/b 表示红/黑
    x[-1] = side
    return x


def mirror_fen(fen: str) -> str:
    """颜色镜像：上下翻转棋盘 + 红黑棋子互换 + 行棋方互换。红方视角分数取反。"""
    parts = fen.split(" ")
    rows = parts[0].split("/")[::-1]
    flipped = []
    for row in rows:
        out = ""
        for ch in row:
            out += ch if ch.isdigit() else ch.swapcase()
        flipped.append(out)
    side = "b" if parts[1] == "w" else "w"  # 引擎 FEN 用 w/b
    return "/".join(flipped) + " " + side


def load_dataset(path: str, augment: bool = True):
    """labeled.txt → (X, y)。教师分 tanh(score/1000) 压缩。
    augment=True 时每个局面附加颜色镜像副本（标签取反），
    强制 f(mirror)=-f(原) 对称性，消除红黑不对称偏差。"""
    import numpy as np

    xs, ys = [], []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or ";" not in line:
                continue
            fen, s = line.rsplit(";", 1)
            fen = fen.strip()
            y = math.tanh(float(s) / 1000.0)
            xs.append(encode_fen(fen))
            ys.append(y)
            if augment:
                xs.append(encode_fen(mirror_fen(fen)))
                ys.append(-y)
    X = np.stack(xs)
    y = np.array(ys, dtype=np.float32)
    return X, y


def build_model():
    import torch.nn as nn

    return nn.Sequential(
        nn.Linear(90 * 14 + 1, 1024),
        nn.SiLU(),
        nn.Linear(1024, 512),
        nn.SiLU(),
        nn.Linear(512, 256),
        nn.SiLU(),
        nn.Linear(256, 1),
        nn.Tanh(),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/labeled.txt")
    ap.add_argument("--out", default="data/model.onnx")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=4096)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--val-frac", type=float, default=0.02)
    ap.add_argument("--no-augment", action="store_true", help="关闭颜色镜像增广")
    args = ap.parse_args()

    import torch
    import torch.nn as nn

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[train] device = {device}")

    print(f"[train] 读取 {args.data} ...")
    X, y = load_dataset(args.data, augment=not args.no_augment)
    print(f"[train] 样本 {len(X)}{'（含颜色镜像增广）' if not args.no_augment else ''}")

    # 随机划分 train/val（v1 按行分，足够）
    idx = list(range(len(X)))
    random.shuffle(idx)
    n_val = max(1, int(len(X) * args.val_frac))
    val_idx, train_idx = idx[:n_val], idx[n_val:]

    X_tr = torch.tensor(X[train_idx], device=device)
    y_tr = torch.tensor(y[train_idx], device=device).unsqueeze(1)
    X_va = torch.tensor(X[val_idx], device=device)
    y_va = torch.tensor(y[val_idx], device=device).unsqueeze(1)

    model = build_model().to(device)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    loss_fn = nn.MSELoss()

    n = len(X_tr)
    best_val = float("inf")
    for epoch in range(args.epochs):
        model.train()
        perm = torch.randperm(n, device=device)
        total = 0.0
        for i in range(0, n, args.batch):
            b = perm[i : i + args.batch]
            pred = model(X_tr[b])
            loss = loss_fn(pred, y_tr[b])
            opt.zero_grad()
            loss.backward()
            opt.step()
            total += loss.item() * len(b)
        sched.step()

        model.eval()
        with torch.no_grad():
            val_loss = loss_fn(model(X_va), y_va).item()
        marker = ""
        if val_loss < best_val:
            best_val = val_loss
            torch.save(model.state_dict(), args.out.replace(".onnx", ".pt"))
            marker = "  *best"
        print(f"[train] epoch {epoch + 1}/{args.epochs}  train {total / n:.5f}  val {val_loss:.5f}{marker}")

    # 导出 ONNX（用最佳权重）
    model.load_state_dict(torch.load(args.out.replace(".onnx", ".pt"), map_location=device))
    model.eval()
    dummy = X_va[:1]
    torch.onnx.export(
        model, dummy, args.out,
        input_names=["board"], output_names=["score"],
        dynamic_axes={"board": {0: "batch"}, "score": {0: "batch"}},
    )
    print(f"[train] 导出 {args.out}（best val {best_val:.5f}）")
    print(f"[train] 反归一化参考：val_loss {best_val:.5f} ≈ 平均分差 {math.atanh(best_val) ** 0.5 * 1000:.0f} cp 量级（粗估）")


if __name__ == "__main__":
    main()
