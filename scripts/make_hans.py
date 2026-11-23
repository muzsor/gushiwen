"""產生簡體版資料：把 public/data/poems.json 轉成簡體並把注音轉成拼音，輸出 public/data/poems.hans.json，
另外產生介面文字用的字對照表 public/js/hans-ui.js，以及閱讀器排序用的朝代、體裁清單 public/js/terms.js
（清單只在 scripts/poemdata.py 維護）。這三個檔案都是自動產生的，不要手動修改。

用法（在專案資料夾執行）：
  python -I scripts/make_hans.py

需要 OpenCC 的 Python 版本：pip install opencc-python-reimplemented
新增或修改作品後要重新執行（網頁編輯器與 add_poem.py 儲存時會自動執行）；修改 poemdata.py 的朝代、體裁清單後也要執行。

轉換規則：
- 簡體用 OpenCC 的 tw2s（臺灣繁體 → 簡體），「著」會依詞語轉成「着」或保留「著」。
- 轉換後若變成 Unicode 擴充區的罕用字形（例如「輮」→「𫐓」，多數字型無法顯示），保留原字。
- 註釋、創作背景、賞析、版本、作者介紹中，引號「」內的寫法若轉成簡體後會和同一篇中另一個不同的寫法變成一樣
  （例如異文說明中的「遊」「游」），就保留繁體，讀者才看得出各版本的差別。
- 注音轉成拼音（例如「ㄐㄩㄣ」→「jūn」）。讀音仍是教育部《重編國語辭典修訂本》的讀音。
- 註釋的 term／in 依原文位置對應到簡體原文；轉換後若變得不唯一，自動補上 in，讓底線標在同一個地方。
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import poemdata as D
from poemdata import as_list, segments

ROOT = D.ROOT
OUT = D.HANS_DATA
UI_OUT = ROOT / "public" / "js" / "hans-ui.js"
TERMS_OUT = ROOT / "public" / "js" / "terms.js"
UI_SOURCES = [ROOT / "public" / "index.html", ROOT / "public" / "js" / "app.js", TERMS_OUT]

try:
    import opencc
except ImportError:  # 讓呼叫端（編輯器、add_poem.py）可以提示安裝
    opencc = None

# ---------- 注音 → 拼音 ----------
INITIAL = dict(zip("ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙ",
                   ["b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x",
                    "zh", "ch", "sh", "r", "z", "c", "s"]))
FINAL = {"": "", "ㄚ": "a", "ㄛ": "o", "ㄜ": "e", "ㄝ": "ê", "ㄞ": "ai", "ㄟ": "ei", "ㄠ": "ao", "ㄡ": "ou",
         "ㄢ": "an", "ㄣ": "en", "ㄤ": "ang", "ㄥ": "eng", "ㄦ": "er"}
WITH_I = {"": "i", "ㄚ": "ia", "ㄛ": "io", "ㄝ": "ie", "ㄞ": "iai", "ㄠ": "iao", "ㄡ": "iu", "ㄢ": "ian",
          "ㄣ": "in", "ㄤ": "iang", "ㄥ": "ing"}
WITH_U = {"": "u", "ㄚ": "ua", "ㄛ": "uo", "ㄞ": "uai", "ㄟ": "ui", "ㄢ": "uan", "ㄣ": "un", "ㄤ": "uang", "ㄥ": "ong"}
WITH_V = {"": "ü", "ㄝ": "üe", "ㄢ": "üan", "ㄣ": "ün", "ㄥ": "iong"}
ZERO_I = {"": "yi", "ㄚ": "ya", "ㄛ": "yo", "ㄝ": "ye", "ㄞ": "yai", "ㄠ": "yao", "ㄡ": "you", "ㄢ": "yan",
          "ㄣ": "yin", "ㄤ": "yang", "ㄥ": "ying"}
ZERO_U = {"": "wu", "ㄚ": "wa", "ㄛ": "wo", "ㄞ": "wai", "ㄟ": "wei", "ㄢ": "wan", "ㄣ": "wen", "ㄤ": "wang", "ㄥ": "weng"}
ZERO_V = {"": "yu", "ㄝ": "yue", "ㄢ": "yuan", "ㄣ": "yun", "ㄥ": "yong"}
MARKS = {"a": "āáǎà", "e": "ēéěè", "i": "īíǐì", "o": "ōóǒò", "u": "ūúǔù", "ü": "ǖǘǚǜ", "ê": ["ê̄", "ế", "ê̌", "ề"]}
TONE = {"": 1, "ˊ": 2, "ˇ": 3, "ˋ": 4, "˙": 5}
SYL = re.compile(r"(˙?)([ㄅ-ㄩ]+)([ˊˇˋ˙]?)")


def _mark(py, tone):
    if tone == 5:
        return py
    t = tone - 1
    for v in ("a", "e", "ê"):
        if v in py:
            return py.replace(v, MARKS[v][t], 1)
    if "ou" in py:
        return py.replace("o", MARKS["o"][t], 1)
    for i in range(len(py) - 1, -1, -1):
        if py[i] in MARKS:
            return py[:i] + MARKS[py[i]][t] + py[i + 1:]
    return py


def syllable(zy, tone_sym=""):
    ini, rest = "", zy
    if rest and rest[0] in INITIAL:
        ini, rest = INITIAL[rest[0]], rest[1:]
    med = rest[0] if rest and rest[0] in "ㄧㄨㄩ" else ""
    fin = rest[1:] if med else rest
    if fin not in FINAL:
        raise ValueError(zy)
    if not med:
        if not fin and ini in ("zh", "ch", "sh", "r", "z", "c", "s"):
            py = ini + "i"
        elif fin == "ㄛ" and ini not in ("b", "p", "m", "f", ""):
            py = ini + "uo"
        else:
            py = ini + FINAL[fin]
    elif med == "ㄧ":
        py = (ini + WITH_I[fin]) if ini else ZERO_I[fin]
    elif med == "ㄨ":
        py = (ini + WITH_U[fin]) if ini else ZERO_U[fin]
    elif not ini:
        py = ZERO_V[fin]
    elif ini in ("j", "q", "x"):
        py = ini + WITH_V[fin].replace("ü", "u")
    else:
        py = ini + WITH_V[fin]
    return _mark(py, TONE[tone_sym])


def zhuyin_to_pinyin(text):
    def rep(m):
        lead, zy, tail = m.groups()
        try:
            return syllable(zy, "˙" if lead else tail)
        except (ValueError, KeyError):
            return m.group(0)
    return SYL.sub(rep, text)


# ---------- 繁體 → 簡體 ----------
EXTRA = {"牠": "它"}   # OpenCC 沒有處理的臺灣用字
_cc = None


def to_hans(text):
    global _cc
    if _cc is None:
        _cc = opencc.OpenCC("tw2s")
    out = _cc.convert(text)
    for a, b in EXTRA.items():
        out = out.replace(a, b)
    if len(out) == len(text):   # 轉成擴充區罕用字形時保留原字
        out = "".join(o if not (ord(o) >= 0x20000 > ord(s)) else s for o, s in zip(out, text))
    return out


def conv(text, keep=frozenset()):
    """轉成簡體＋拼音；keep 中的寫法若出現在「」內就保留繁體。"""
    if not keep:
        return to_hans(zhuyin_to_pinyin(text))
    parts = re.split(r"(「[^「」]+」)", text)
    return "".join(p if p.startswith("「") and p[1:-1] in keep else to_hans(zhuyin_to_pinyin(p)) for p in parts)


def keep_set(texts):
    """引號內轉成簡體後會和另一個不同寫法變成一樣的，回傳這些寫法。"""
    by = defaultdict(set)
    for t in texts:
        for q in re.findall(r"「([^「」]+)」", t):
            by[to_hans(q)].add(q)
    return frozenset(q for qs in by.values() if len(qs) > 1 for q in qs)


def conv_field(v, keep):
    return [conv(x, keep) for x in v] if isinstance(v, list) else conv(v, keep)


# ---------- 註釋位置（和 app.js 的 markText 相同的規則） ----------
def mark(segs, notes, only=None):
    taken = [[False] * len(s) for s in segs]
    hits = {}
    order = sorted(((i, n) for i, n in enumerate(notes) if only is None or i in only),
                   key=lambda x: (-(1 if x[1].get("in") else 0), -len(x[1]["term"])))
    for i, n in order:
        t = n["term"]
        for si, s in enumerate(segs):
            if n.get("in"):
                ctx = s.find(n["in"])
                if ctx < 0:
                    continue
                at = ctx + n["in"].find(t)
                if at >= ctx and not any(taken[si][at:at + len(t)]):
                    for k in range(at, at + len(t)):
                        taken[si][k] = True
                    hits[i] = (si, at)
                break
            at = s.find(t)
            found = False
            while at != -1:
                if not any(taken[si][at:at + len(t)]):
                    for k in range(at, at + len(t)):
                        taken[si][k] = True
                    hits[i] = (si, at)
                    found = True
                    break
                at = s.find(t, at + 1)
            if found:
                break
    return hits


def unique_context(segs, si, at, length):
    """在簡體原文中找一段包含 [at, at+length)、全文唯一的片段，作為 in。"""
    s = segs[si]
    for extra in range(1, 21):
        for left in range(0, extra + 1):
            a, b = max(0, at - left), min(len(s), at + length + extra - left)
            ctx = s[a:b]
            if sum(x.count(ctx) for x in segs) == 1:
                return ctx
    return None


def convert_poem(p, problems):
    texts = [n["note"] for n in p["notes"]] + list(p.get("edition", [])) + list(p["analysis"]) + as_list(p["background"])
    keep = keep_set(texts)
    h = dict(p)
    h["title"] = conv(p["title"])
    for k in ("source", "form"):
        if k in p:
            h[k] = conv(p[k])
    h["tags"] = [conv(t) for t in p["tags"]]
    if p.get("preface"):
        h["preface"] = [conv(p["preface"][0]), conv(p["preface"][1])]
    h["body"] = [[[conv(s), conv(t)] for s, t in block] for block in p["body"]]
    h["background"] = conv_field(p["background"], keep)
    h["analysis"] = [conv(x, keep) for x in p["analysis"]]
    if p.get("edition"):
        h["edition"] = [conv(x, keep) for x in p["edition"]]
    if p.get("references"):
        h["references"] = [conv(x) for x in p["references"]]

    # 註釋：term／in 依原文位置取簡體原文中的對應字串
    osegs, hsegs = segments(p), segments(h)
    same_len = [len(a) == len(b) for a, b in zip(osegs, hsegs)]
    ohits = mark(osegs, p["notes"])
    notes = []
    for i, n in enumerate(p["notes"]):
        hn = {"term": conv(n["term"])}
        if i in ohits and same_len[ohits[i][0]]:
            si, at = ohits[i]
            hn["term"] = hsegs[si][at:at + len(n["term"])]
            if n.get("in"):
                ctx = osegs[si].find(n["in"])
                hn["in"] = hsegs[si][ctx:ctx + len(n["in"])]
        elif n.get("in"):
            hn["in"] = conv(n["in"])
        elif i not in ohits:   # 只在題目中的詞
            at = p["title"].find(n["term"])
            if at >= 0 and len(p["title"]) == len(h["title"]):
                hn["term"] = h["title"][at:at + len(n["term"])]
        hn["note"] = conv(n["note"], keep)
        notes.append(hn)
    # 轉換後位置不同（例如「後」「后」合併後先遇到別處）時補上 in
    for _ in range(3):
        hhits = mark(hsegs, notes)
        moved = [i for i in ohits if hhits.get(i) != ohits[i]]
        if not moved:
            break
        for i in moved:
            si, at = ohits[i]
            ctx = unique_context(hsegs, si, at, len(notes[i]["term"]))
            if ctx and not notes[i].get("in"):
                notes[i] = {"term": notes[i]["term"], "in": ctx, "note": notes[i]["note"]}
            elif ctx:
                notes[i]["in"] = ctx
    hhits = mark(hsegs, notes)
    for i in ohits:
        if hhits.get(i) != ohits[i]:
            problems.append(f"{p['id']} 註釋「{p['notes'][i]['term']}」在簡體版標的位置不同")
    for i, n in enumerate(p["notes"]):
        if i not in ohits and notes[i]["term"] not in h["title"]:
            problems.append(f"{p['id']} 註釋「{n['term']}」在簡體版找不到")
    h["notes"] = notes
    return h


def write_terms():
    """閱讀器的朝代、體裁排列順序（app.js 的 DYNASTY_ORDER、FORM_ORDER）。不需要 OpenCC，先寫出來。"""
    terms = {"dynasties": D.DYNASTIES, "forms": D.FORMS}
    TERMS_OUT.write_text("/* 自動產生（scripts/make_hans.py），不要手動修改：朝代與體裁的排列順序，清單在 scripts/poemdata.py */\n"
                         "self.TERMS = " + json.dumps(terms, ensure_ascii=False, separators=(",", ":")) + ";\n",
                         encoding="utf-8")


def build():
    write_terms()
    if opencc is None:
        raise RuntimeError("需要 OpenCC：pip install opencc-python-reimplemented")
    d = D.read_json()
    problems = []
    authors = {}
    for k, a in d["authors"].items():
        keep = keep_set(as_list(a["intro"]))
        authors[k] = {**a, "name": conv(a["name"]), "dynasty": conv(a["dynasty"]), "years": conv(a["years"]),
                      "intro": conv_field(a["intro"], keep)}
    poems = [convert_poem(p, problems) for p in d["poems"]]
    out = {"script": "hans", "authors": authors, "poems": poems}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # 介面文字：只做逐字對照（介面用語都是現代常用字）
    chars = sorted({c for f in UI_SOURCES for c in f.read_text(encoding="utf-8") if "一" <= c <= "鿿"})
    ui = {c: to_hans(c) for c in chars if to_hans(c) != c}
    # 朝代、體裁的值在介面上用逐字對照轉換，要和資料中的轉換結果一致
    t = lambda s: "".join(ui.get(c, c) for c in s)
    for k, a in d["authors"].items():
        if t(a["dynasty"]) != authors[k]["dynasty"]:
            problems.append(f"朝代「{a['dynasty']}」逐字轉換與資料不一致")
    for p, h in zip(d["poems"], poems):
        if t(p["form"]) != h["form"]:
            problems.append(f"體裁「{p['form']}」逐字轉換與資料不一致")
    # 介面的逐字轉換也會掃過標題、目錄卡片等資料文字；對照表中的字不應出現在簡體資料中（引號內保留的繁體除外）
    plain = re.sub(r"「[^「」]*」", "", OUT.read_text(encoding="utf-8"))
    for c in ui:
        if c in plain:
            problems.append(f"介面對照表的「{c}」也出現在簡體資料中，介面轉換可能改到作品內容")
    UI_OUT.write_text("/* 自動產生（scripts/make_hans.py），不要手動修改：介面文字的繁體→簡體逐字對照 */\n"
                      "self.HANS_UI = " + json.dumps(ui, ensure_ascii=False, separators=(",", ":")) + ";\n",
                      encoding="utf-8")
    return len(poems), sorted(set(problems))


def main():
    try:
        n, problems = build()
    except RuntimeError as e:
        print("錯誤", e)
        sys.exit(1)
    for x in problems:
        print("問題", x)
    print(f"已產生簡體版：{n} 篇 → {OUT.relative_to(ROOT)}、{UI_OUT.relative_to(ROOT)}、{TERMS_OUT.relative_to(ROOT)}；問題 {len(problems)} 項")
    if problems:
        sys.exit(1)


if __name__ == "__main__":
    main()
