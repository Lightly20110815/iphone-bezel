#!/usr/bin/env python3
"""
从 Resources/*.dmg 里提取 Apple 官方 iPhone 边框 PNG，生成网页需要的素材：

  public/assets/bezels/<model>/<color>-<orientation>.<hash>.png   原始边框图（原样拷贝）
  public/assets/masks/<hash>.png                                   屏幕区域蒙版（1-bit，透明 = 屏幕外）
  public/assets/devices.js                                         设备清单（机型 / 颜色 / 屏幕位置）

图片文件名带内容哈希，内容变了文件名就变，所以线上可以长期缓存。

用法：
  python3 -m venv .venv && .venv/bin/pip install -r tools/requirements.txt
  .venv/bin/python tools/build_assets.py

新增 DMG 后重新运行即可。未知的机型 / 颜色会用自动取色，并在终端提示。
"""
import argparse
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parent.parent

# 机型展示顺序（新 → 旧），以及所属系列（用于网页上的系列切换）
MODEL_ORDER = [
    ("iPhone Duo Inner", "Duo"), ("iPhone Duo Outer", "Duo"), ("iPhone Duo Outer Open", "Duo"),
    ("iPhone 18 Pro Max", "18"), ("iPhone 18 Pro", "18"),
    ("iPhone 17 Pro Max", "17"), ("iPhone 17 Pro", "17"), ("iPhone Air", "17"), ("iPhone 17", "17"),
    ("iPhone 16 Pro Max", "16"), ("iPhone 16 Pro", "16"), ("iPhone 16 Plus", "16"), ("iPhone 16", "16"),
    ("iPhone 15 Pro Max", "15"), ("iPhone 15 Pro", "15"), ("iPhone 15 Plus", "15"), ("iPhone 15", "15"),
    ("iPhone 14 Pro Max", "14"), ("iPhone 14 Pro", "14"), ("iPhone 14 Plus", "14"), ("iPhone 14", "14"),
    ("iPhone 13 Pro Max", "13"), ("iPhone 13 Pro", "13"), ("iPhone 13", "13"), ("iPhone 13 mini", "13"),
    ("iPhone 12 Pro Max", "12"), ("iPhone 12 Pro", "12"), ("iPhone 12", "12"), ("iPhone 12 mini", "12"),
    ("iPhone 11 Pro Max", "11"), ("iPhone 11 Pro", "11"), ("iPhone 11", "11"),
]

MODEL_LABELS = {
    "iPhone Duo Inner": ("iPhone Duo", "内屏"),
    "iPhone Duo Outer": ("iPhone Duo", "外屏"),
    "iPhone Duo Outer Open": ("iPhone Duo", "展开 · 背面"),
}

# 没有颜色名的旧素材
DEFAULT_COLOR = {"iPhone 11": "White", "iPhone 11 Pro": "Space Gray", "iPhone 11 Pro Max": "Space Gray"}

# 颜色中文名与色卡（以官方配色为参考）
COLORS = {
    "White": ("白色", "#F3F3F1"), "Silver": ("银色", "#E3E4E1"), "Space Gray": ("深空灰色", "#5E5E5C"),
    "Graphite": ("石墨色", "#56554F"), "Midnight": ("午夜色", "#30363D"), "Starlight": ("星光色", "#F1ECE4"),
    "Blue": ("蓝色", "#A7B9CB"), "Purple": ("紫色", "#DCD2E3"), "Red": ("红色", "#C8243A"),
    "Deep Purple": ("暗紫色", "#5E5566"), "Gold": ("金色", "#E9DCBE"), "Space Black": ("深空黑色", "#45423F"),
    "Black": ("黑色", "#3C3E40"), "Green": ("绿色", "#DCE4D0"), "Pink": ("粉色", "#EFD0D3"), "Yellow": ("黄色", "#EFE5BF"),
    "Black Titanium": ("黑色钛金属", "#3B3B3D"), "Blue Titanium": ("蓝色钛金属", "#3E4B5C"),
    "Natural Titanium": ("原色钛金属", "#BAB5AB"), "White Titanium": ("白色钛金属", "#EDEBE6"),
    "Desert Titanium": ("沙漠色钛金属", "#C4A68E"),
    "Teal": ("深青色", "#8DB7B7"), "Ultramarine": ("群青色", "#7D8FE3"),
    "Lavender": ("薰衣草紫色", "#D8C8E6"), "Mist Blue": ("青雾蓝色", "#A6BCD9"), "Sage": ("鼠尾草绿色", "#B3BF97"),
    "Cosmic Orange": ("星宇橙色", "#EE8347"), "Deep Blue": ("深墨蓝色", "#3D4558"),
    "Cloud White": ("云白色", "#F2F2F0"), "Light Gold": ("浅金色", "#EADFC6"), "Sky Blue": ("天蓝色", "#CFE0EE"),
    "Burgundy": ("酒红色", "#5C2A33"), "Glacier": ("冰川色", "#B8C8DC"),
    "Night Sky": ("夜空色", "#2F3747"), "Star White": ("星白色", "#EDECE7"),
}
# 同名但不同代颜色不一样的情况
COLOR_OVERRIDES = {
    ("15", "Blue"): "#CFDDE5", ("15", "Black"): "#3D4043", ("16", "Pink"): "#E8A5CF",
    ("16", "White"): "#F4F4F3", ("17", "Black"): "#3A3B3D", ("17", "Silver"): "#E3E3E3",
    ("18", "Black"): "#262527", ("18", "Silver"): "#DADADA", ("17", "Space Black"): "#2B2B2D",
}

ALPHA_T = 128        # alpha 低于该值视为透明（屏幕区域）
MASK_GROW = 3        # 蒙版向外扩几像素，垫在边框的抗锯齿内沿下面


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def parse_name(stem):
    """'iPhone 16 Pro - Desert Titanium - Portrait' -> (model, color, orientation)"""
    parts = [p.strip() for p in stem.split(" - ")]
    model = re.sub(r"\bMini\b", "mini", parts[0])
    rest = parts[1:]
    orient = "portrait"
    if rest and re.search(r"(Portrait|Landscape|Outer Open)$", rest[-1]):
        last = rest.pop()
        if model == "iPhone Duo":
            if last.startswith("Inner Open"):
                model = "iPhone Duo Inner"
            elif last.startswith("Outer Closed"):
                model = "iPhone Duo Outer"
            else:
                model = "iPhone Duo Outer Open"
        orient = "landscape" if last.endswith("Landscape") else "portrait"
    color = rest[0] if rest else DEFAULT_COLOR.get(model, "Default")
    return model, color, orient


def mount(dmg, mountpoint):
    # Apple 的 DMG 带许可协议，用 stdin 自动同意
    subprocess.run(
        ["hdiutil", "attach", "-nobrowse", "-readonly", "-noverify", "-mountpoint", str(mountpoint), str(dmg)],
        input=b"Y\n", stdout=subprocess.DEVNULL, check=True,
    )


def detach(mountpoint):
    r = subprocess.run(["hdiutil", "detach", str(mountpoint), "-quiet"])
    if r.returncode:
        subprocess.run(["hdiutil", "detach", str(mountpoint), "-force", "-quiet"])


def analyze(img):
    """找出屏幕区域：被机身包围的最大透明区域。返回 (bbox, 蒙版数组)"""
    a = np.asarray(img)[:, :, 3]
    clear = a < ALPHA_T
    lab, n = ndi.label(clear)
    edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    sizes = ndi.sum(clear, lab, range(1, n + 1))
    inner = [(sizes[i - 1], i) for i in range(1, n + 1) if i not in edge]
    if not inner:
        raise ValueError("没有找到屏幕区域")
    screen = lab == max(inner)[1]
    ys, xs = np.nonzero(screen)
    bbox = [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]

    outside = np.isin(lab, edge[edge > 0])
    mask = ndi.binary_fill_holes(screen)                       # 把灵动岛 / 挖孔也算进屏幕
    mask = ndi.binary_dilation(mask, iterations=MASK_GROW) & ~outside
    return bbox, mask


def frame_color(img):
    px = np.asarray(img).astype(int)
    h = px.shape[0]
    out = []
    for y in range(int(h * 0.55), int(h * 0.75), 7):
        row = px[y]
        xs = np.nonzero(row[:, 3] > 250)[0]
        if len(xs):
            seg = row[xs[0]:xs[0] + 12]
            out += list(seg[seg[:, 3] > 250][:, :3])
    r, g, b = np.median(np.array(out), axis=0).astype(int)
    return f"#{r:02X}{g:02X}{b:02X}"


def save_mask(mask, masks_dir):
    im = Image.fromarray(mask.astype(np.uint8), "L").convert("P")
    im.putpalette([0, 0, 0, 255, 255, 255])
    digest = hashlib.sha1(mask.tobytes() + str(mask.shape).encode()).hexdigest()[:12]
    path = masks_dir / f"{digest}.png"
    if not path.exists():
        im.save(path, transparency=0, bits=1, optimize=True)
    return f"assets/masks/{digest}.png"


def top_side(portrait, landscape):
    """判断原生横屏图里机身顶部朝左还是朝右（和竖屏图旋转后比对）"""
    pa = np.asarray(portrait)[:, :, 3].astype(np.int16)
    la = np.asarray(landscape)[:, :, 3].astype(np.int16)
    best = None
    for side, k in (("left", 1), ("right", -1)):         # rot90 k=1 为逆时针：顶部 -> 左
        r = np.rot90(pa, k)
        if r.shape != la.shape:
            r = np.asarray(Image.fromarray(r.astype(np.uint8)).resize(la.shape[::-1])).astype(np.int16)
        d = np.abs(r - la).mean()
        if best is None or d < best[0]:
            best = (d, side)
    return best[1]


def model_groups(models):
    """颜色相同的相邻机型合并成一行，返回 [(机型名, 颜色名列表)]"""
    groups = []
    for m in models:
        colors = [c["name"] for c in m["colors"]]
        if groups and groups[-1]["family"] == m["family"] and groups[-1]["colors"] == colors:
            g = groups[-1]
        else:
            g = {"family": m["family"], "colors": colors, "names": {}}
            groups.append(g)
        g["names"].setdefault(m["name"], []).append(m["variant"])
    out = []
    for g in groups:
        names = [f"{n}（{' / '.join(v)}）" if any(v) else n for n, v in g["names"].items()]
        out.append(("、".join(names), g["colors"]))
    return out


def write_model_lists(models, site_dir):
    """同步网页底部和 llms.txt 里的「支持的机型」列表"""
    groups = model_groups(models)
    page = site_dir / "index.html"
    if page.exists():
        items = "\n".join(
            f"            <li><strong>{html.escape(n)}</strong><span>{html.escape('、'.join(c))}</span></li>"
            for n, c in groups)
        text = re.sub(r"(<!-- MODELS:START -->\n).*?(<!-- MODELS:END -->)",
                      lambda m: m.group(1) + items + "\n" + m.group(2), page.read_text(encoding="utf-8"), flags=re.S)
        page.write_text(text, encoding="utf-8")
    llms = site_dir / "llms.txt"
    if llms.exists():
        items = "\n".join(f"- {n}：{'、'.join(c)}" for n, c in groups)
        text = re.sub(r"(## 支持的机型和颜色\n\n).*?(\n\n## )",
                      lambda m: m.group(1) + items + m.group(2), llms.read_text(encoding="utf-8"), flags=re.S)
        llms.write_text(text, encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--resources", default=ROOT / "Resources", type=Path)
    ap.add_argument("--out", default=ROOT / "public" / "assets", type=Path)
    ap.add_argument("--lists-only", action="store_true", help="不重新提取素材，只按现有 devices.js 更新网页和 llms.txt 里的机型列表")
    args = ap.parse_args()

    if args.lists_only:
        js = (args.out / "devices.js").read_text(encoding="utf-8")
        write_model_lists(json.loads(js[js.index("{"):js.rindex("}") + 1])["models"], args.out.parent)
        print("已更新机型列表")
        return

    bezels_dir, masks_dir = args.out / "bezels", args.out / "masks"
    for d in (bezels_dir, masks_dir):
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)

    models = {}   # model -> color -> orient -> asset
    tmp = Path(tempfile.mkdtemp(prefix="bezel-"))
    try:
        for dmg in sorted(args.resources.glob("*.dmg")):
            mp = tmp / dmg.stem
            mp.mkdir()
            print(f"挂载 {dmg.name}")
            mount(dmg, mp)
            try:
                for png in sorted((mp / "PNG").rglob("*.png")):
                    if png.name.startswith("."):
                        continue
                    model, color, orient = parse_name(png.stem)
                    img = Image.open(png).convert("RGBA")
                    bbox, mask = analyze(img)
                    digest = hashlib.sha1(png.read_bytes()).hexdigest()[:10]
                    rel = f"assets/bezels/{slug(model)}/{slug(color)}-{orient}.{digest}.png"
                    (args.out.parent / rel).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(png, args.out.parent / rel)
                    asset = {
                        "src": rel, "mask": save_mask(mask, masks_dir),
                        "size": [img.width, img.height], "screen": bbox,
                    }
                    models.setdefault(model, {}).setdefault(color, {})[orient] = (asset, img, frame_color(img))
                    print(f"  {model} / {color} / {orient}  屏幕 {bbox[2]}×{bbox[3]}")
            finally:
                detach(mp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    order = {name: i for i, (name, _) in enumerate(MODEL_ORDER)}
    family_of = dict(MODEL_ORDER)
    out_models = []
    for model in sorted(models, key=lambda m: order.get(m, -1)):
        if model not in order:
            print(f"! 未登记的机型：{model}（排在最前，系列取名称中的数字）")
        family = family_of.get(model) or (re.findall(r"\d+", model) or ["?"])[0]
        name, variant = MODEL_LABELS.get(model, (model, ""))
        colors = []
        for color, orients in models[model].items():
            zh, hex_ = COLORS.get(color, (None, None))
            hex_ = COLOR_OVERRIDES.get((family, color), hex_)
            any_orient = orients.get("portrait") or orients.get("landscape")
            if zh is None:
                print(f"! 未登记的颜色：{model} / {color}，使用自动取色 {any_orient[2]}")
                zh, hex_ = color, any_orient[2]
            entry = {"id": slug(color), "name": zh, "en": color, "hex": hex_}
            for o in ("portrait", "landscape"):
                if o in orients:
                    entry[o] = orients[o][0]
            if "portrait" in orients and "landscape" in orients:
                entry["landscape"]["top"] = top_side(orients["portrait"][1], orients["landscape"][1])
            elif "landscape" in orients:
                entry["landscape"]["top"] = "left"
            colors.append(entry)
        ref = colors[0].get("portrait") or colors[0]["landscape"]
        sw, sh = ref["screen"][2:]
        out_models.append({
            "id": slug(model), "name": name, "variant": variant, "family": family,
            "screen": [min(sw, sh), max(sw, sh)], "colors": colors,
        })

    families = []
    for m in out_models:
        if m["family"] not in families:
            families.append(m["family"])

    js = "// 由 tools/build_assets.py 生成，请勿手动修改\nwindow.DEVICE_DATA = " + json.dumps(
        {"families": families, "models": out_models}, ensure_ascii=False, indent=1) + ";\n"
    (args.out / "devices.js").write_text(js, encoding="utf-8")
    write_model_lists(out_models, args.out.parent)
    n_assets = sum(len(o) for c in models.values() for o in c.values())
    print(f"\n完成：{len(out_models)} 个机型，{n_assets} 张边框，{len(list(masks_dir.iterdir()))} 张蒙版")


if __name__ == "__main__":
    sys.exit(main())
