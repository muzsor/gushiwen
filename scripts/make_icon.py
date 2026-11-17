"""產生 App 圖示：毛筆「古」字，右下角加上取自王羲之《蘭亭集序》
（唐馮承素摹本，「未嘗不臨文嗟悼」句，公有領域）的「文」字朱紅印章，合成在宣紙色底上。

用法：
    python -I scripts/make_icon.py <古字圖.jpg> <LantingXu.jpg> <輸出資料夾> <預覽.png> [seal|ink]

輸出：
    icon-180.png           iPhone 主畫面（滿版，iOS 自動裁圓角）
    icon-192.png、icon-512.png  其他系統（已裁圓角，角落透明）
    icon-maskable-512.png  Android 自適應圖示（滿版，由系統裁切）

<古字圖.jpg>  左半邊為白底黑字「古」的圖片
seal / ink   「文」做成朱紅方印（預設）或墨色小字
需要 Pillow：pip install Pillow
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageChops

mock, lanting, outdir, preview = (Path(a) for a in sys.argv[1:5])
STYLE = sys.argv[5] if len(sys.argv) > 5 else "seal"
S = 1024


def keep_central(alpha, cx0=.25, cx1=.75, cy0=.2, cy1=.8, thr=128, minpx=40, grow=7):
    """只保留碰到中央區域的墨跡區塊（去掉相鄰字、陰影與雜點）。"""
    bp = alpha.point(lambda v: 255 if v > thr else 0).load()
    w, h = alpha.size
    seen = bytearray(w * h); keep = Image.new("L", (w, h), 0); kp = keep.load()
    for y in range(h):
        for x in range(w):
            if bp[x, y] and not seen[y * w + x]:
                seen[y * w + x] = 1; st = [(x, y)]; pts = []; central = False
                while st:
                    px, py = st.pop(); pts.append((px, py))
                    if cx0 * w < px < cx1 * w and cy0 * h < py < cy1 * h:
                        central = True
                    for nx, ny in ((px + 1, py), (px - 1, py), (px, py + 1), (px, py - 1)):
                        if 0 <= nx < w and 0 <= ny < h and bp[nx, ny] and not seen[ny * w + nx]:
                            seen[ny * w + nx] = 1; st.append((nx, ny))
                if central and len(pts) > minpx:
                    for p in pts:
                        kp[p] = 255
    keep = keep.filter(ImageFilter.MaxFilter(grow)).filter(ImageFilter.GaussianBlur(1.5))
    out = ImageChops.multiply(alpha, keep)
    return out.crop(out.getbbox())


# ---------- 古：取圖片左半邊的墨跡 ----------
im = Image.open(mock).convert("RGB")
im = im.crop((0, 0, im.width // 2, im.height))
L = im.convert("L")
small = L.resize((L.width // 8, L.height // 8), Image.BOX).filter(ImageFilter.MaxFilter(11))
paper = small.resize(L.size, Image.BICUBIC).filter(ImageFilter.GaussianBlur(20))
pp, lp = paper.load(), L.load()
gu = Image.new("L", L.size); gp = gu.load()
for y in range(L.height):
    for x in range(L.width):
        p = pp[x, y]
        gp[x, y] = int(max(0, min(1, (p - lp[x, y]) / max(1, p - 24))) * 255)
gu = gu.point(lambda v: 0 if v < 70 else min(255, int((v - 70) * 255 / 165)))
gu = keep_central(gu)

# ---------- 文：《蘭亭集序》「臨文嗟悼」 ----------
src = Image.open(lanting).convert("RGB").crop((860, 1040, 995, 1150))
sp = src.load()
wen = Image.new("L", src.size); wp = wen.load()
for y in range(src.height):
    for x in range(src.width):
        r, g, b = sp[x, y]
        wp[x, y] = int(max(0, min(1, (165 - (r + g + b) / 3) / 85 + (b - r) / 70)) * 255)
wen = keep_central(wen, .3, .7, .3, .7, thr=120, minpx=25, grow=5)
wen = wen.point(lambda v: 0 if v < 40 else min(255, int((v - 40) * 1.45)))
wen = wen.crop(wen.getbbox())
print("古", gu.size, "文", wen.size)


# ---------- 合成 ----------
def vgrad(top, bot):
    col = Image.new("RGB", (1, 256))
    for y in range(256):
        t = y / 255
        col.putpixel((0, y), tuple(round(top[i] * (1 - t) + bot[i] * t) for i in range(3)))
    return col.resize((S, S), Image.BICUBIC)


def fit(a, h):
    return a.resize((round(a.width * h / a.height), h), Image.LANCZOS)


def render(size, scale=1.0):
    """scale：字與印章相對於圖示中心縮放（背景不變），給 Android 自適應圖示留出安全範圍。"""
    k = size / S
    c = size / 2
    bg = vgrad((252, 248, 240), (236, 224, 204))
    warm = Image.new("L", (S, S), 0)
    ImageDraw.Draw(warm).ellipse([S * .45, S * .45, S * 1.25, S * 1.25], fill=80)
    bg = Image.composite(Image.new("RGB", (S, S), (240, 205, 178)), bg, warm.filter(ImageFilter.GaussianBlur(160)))
    sheen = Image.new("L", (S, S), 0)
    ImageDraw.Draw(sheen).ellipse([-S * .35, -S * .82, S * 1.35, S * .40], fill=50)
    bg = Image.composite(Image.new("RGB", (S, S), (255, 255, 255)), bg, sheen.filter(ImageFilter.GaussianBlur(50)))
    out = bg.resize((size, size), Image.LANCZOS)
    ink = Image.new("RGB", (size, size), (22, 21, 20))

    ks = k * scale                                        # 位置與大小都以圖示中心為基準
    # 古：略往左上，讓出右下角
    a = fit(gu, round(730 * ks))
    m = Image.new("L", (size, size), 0)
    m.paste(a, (round(c - a.width / 2 - 30 * ks), round(c - a.height / 2 - 22 * ks)))
    out = Image.composite(ink, out, m)

    # 文：右下角（避開 iOS 圓角）
    if STYLE == "seal":                                   # 朱紅方印，字留白
        box = round(150 * ks); x0 = y0 = round(c + 290 * ks)
        seal = Image.new("L", (size, size), 0)
        ImageDraw.Draw(seal).rounded_rectangle([x0, y0, x0 + box, y0 + box], radius=round(14 * ks), fill=235)
        w = fit(wen, round(box * .74))
        wm = Image.new("L", (size, size), 0)
        wm.paste(w, (x0 + (box - w.width) // 2, y0 + (box - w.height) // 2))
        out = Image.composite(Image.new("RGB", (size, size), (184, 46, 36)), out, ImageChops.subtract(seal, wm))
    else:                                                 # 墨色小字，像落款
        w = fit(wen, round(150 * ks))
        wm = Image.new("L", (size, size), 0)
        wm.paste(w, (round(c + 302 * ks - w.width / 2), round(c + 312 * ks - w.height / 2)))
        out = Image.composite(ink, out, wm)
    return out


def rounded(img):
    """圓角遮罩（四倍取樣後縮小，邊緣平滑）。圓角半徑約為邊長的 22.5%，接近 iOS 圖示。"""
    n = img.width * 4
    r = Image.new("L", (n, n), 0)
    ImageDraw.Draw(r).rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * .225), fill=255)
    return r.resize(img.size, Image.LANCZOS)


def with_corners(img):
    out = img.convert("RGBA")
    out.putalpha(rounded(img))
    return out


# icon-180：iPhone 主畫面用，必須滿版不透明，iOS 會自己裁圓角
render(180).save(outdir / "icon-180.png")
# icon-192 / icon-512：其他系統（Android、電腦安裝、瀏覽器分頁圖示）直接顯示，先裁好圓角、角落透明
for sz in (192, 512):
    with_corners(render(sz)).save(outdir / f"icon-{sz}.png")
# icon-maskable-512：Android 會依系統形狀（圓形、圓角方形等）自己裁切，必須滿版；
# 只保證中央直徑 80% 的圓形範圍可見，所以字與印章縮小到 0.64 倍，印章外角也落在圓內
render(512, scale=.64).save(outdir / "icon-maskable-512.png")


tile = 360
big, small180 = render(1024).resize((tile, tile), Image.LANCZOS), render(180)
pv = Image.new("RGB", (tile + 180 + 90, tile + 60), (238, 236, 233))
pv.paste(big, (30, 30), rounded(big))
pv.paste(small180, (tile + 60, 30 + (tile - 180) // 2), rounded(small180))
pv.save(preview)
print("ok")
