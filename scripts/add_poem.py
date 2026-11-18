"""用純文字稿件新增或修改作品，不必直接編輯 JSON。

用法（在專案資料夾執行）：
  python -I scripts/add_poem.py check  稿件.txt            只檢查稿件，不修改資料
  python -I scripts/add_poem.py add    稿件.txt            檢查後加入 public/data/poems.json
  python -I scripts/add_poem.py add    稿件.txt --replace  代號已存在時，以稿件取代舊內容（修改作品用）
  python -I scripts/add_poem.py export 代號 [稿件.txt]     把現有作品匯出成稿件（沒給檔名就印在畫面上）

稿件格式見 templates/作品稿件範本.txt。
寫入前會把原本的資料備份到 .backup/ 資料夾。
"""
import importlib.util
import json
import re
import sys
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "public" / "data" / "poems.json"

_spec = importlib.util.spec_from_file_location("validate_poems", Path(__file__).with_name("validate_poems.py"))
V = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(V)

# 稿件開頭的欄位（「欄位：內容」）→ 資料欄位
HEAD = {
    "代號": "id", "標題": "title", "作者": "author_name", "作者代號": "author", "朝代": "dynasty",
    "生卒年": "years", "出處": "source", "類型": "type", "體裁": "form", "主題": "tags",
}
TYPES = {"詩詞": "verse", "詩": "verse", "詞": "verse", "曲": "verse", "散文": "prose", "文": "prose"}
TYPE_NAMES = {"verse": "詩詞", "prose": "散文"}
SECTIONS = ["作者介紹", "小序", "原文與語譯", "註釋", "創作背景", "版本", "賞析", "參考資料"]
TR = re.compile(r"^譯[：:]\s*")


class DraftError(Exception):
    pass


def paragraphs(lines):
    """以空行分段，段內各行直接相連。"""
    out, cur = [], []
    for l in lines + [""]:
        if l.strip():
            cur.append(l.strip())
        elif cur:
            out.append("".join(cur)); cur = []
    return out


def parse_pairs(lines, where, joiner=""):
    """原文一行（可連續多行，視為同一筆），下一行「譯：」開頭為語譯；空行換段。
    joiner：同一筆的多行原文如何相接。詩詞用換行（保留原本的分行），散文直接相連。"""
    blocks, block, src = [], [], []
    for n, raw in enumerate(lines + [""], 1):
        l = raw.strip()
        if not l:
            if src:
                raise DraftError(f"{where}：「{''.join(src)[:12]}…」後面缺少「譯：」語譯")
            if block:
                blocks.append(block); block = []
            continue
        if TR.match(l):
            tr = TR.sub("", l)
            if not src:
                raise DraftError(f"{where}：語譯「{tr[:12]}…」前面沒有原文")
            if not tr:
                raise DraftError(f"{where}：「{''.join(src)[:12]}…」的語譯是空的")
            block.append([joiner.join(src), tr]); src = []
        else:
            src.append(l)
    return blocks


def parse_notes(lines):
    """每行一則「詞：解釋」；同一個詞出現多次時寫成「詞｜所在的原文片段：解釋」。"""
    notes = []
    for raw in lines:
        l = raw.strip()
        if not l:
            continue
        m = re.match(r"^(.+?)[：:](.+)$", l)
        if not m:
            raise DraftError(f"註釋這一行少了「：」：{l}")
        head, note = m.group(1).strip(), m.group(2).strip()
        if "｜" in head or "|" in head:
            term, ctx = re.split(r"[｜|]", head, maxsplit=1)
            notes.append({"term": term.strip(), "in": ctx.strip(), "note": note})
        else:
            notes.append({"term": head, "note": note})
    return notes


def parse(text):
    head, sections, cur = {}, {}, None
    for raw in text.splitlines():
        line = raw.rstrip()
        if line.lstrip().startswith("#"):
            continue
        m = re.match(r"^【(.+?)】\s*$", line.strip())
        if m:
            name = m.group(1)
            if name not in SECTIONS:
                raise DraftError(f"不認得的段落【{name}】，只能用：{'、'.join('【' + s + '】' for s in SECTIONS)}")
            cur = sections.setdefault(name, [])
            continue
        if cur is None:
            if not line.strip():
                continue
            m = re.match(r"^\s*(.+?)[：:]\s*(.*)$", line)
            if not m or m.group(1) not in HEAD:
                raise DraftError(f"開頭欄位格式應為「欄位：內容」，可用的欄位：{'、'.join(HEAD)}。這一行有問題：{line}")
            head[HEAD[m.group(1)]] = m.group(2).strip()
        else:
            cur.append(line)
    for k, name in (("id", "代號"), ("title", "標題"), ("author", "作者代號"), ("type", "類型"), ("form", "體裁")):
        if not head.get(k):
            raise DraftError(f"缺少開頭欄位「{name}：」")
    if head["type"] not in TYPES:
        raise DraftError(f"類型只能寫「詩詞」或「散文」：{head['type']}")
    if "原文與語譯" not in sections:
        raise DraftError("缺少【原文與語譯】")

    poem = {"id": head["id"], "title": head["title"], "author": head["author"]}
    if head.get("source"):
        poem["source"] = head["source"]
    poem["type"] = TYPES[head["type"]]
    poem["form"] = head["form"]
    poem["tags"] = [t for t in re.split(r"[、，,\s]+", head.get("tags", "")) if t]
    if sections.get("小序") and any(l.strip() for l in sections["小序"]):
        pre = parse_pairs(sections["小序"], "【小序】")
        if len(pre) != 1 or len(pre[0]) != 1:
            raise DraftError("【小序】只能有一筆：原文一行、「譯：」一行")
        poem["preface"] = pre[0][0]
    poem["body"] = parse_pairs(sections["原文與語譯"], "【原文與語譯】", "\n" if poem["type"] == "verse" else "")
    poem["notes"] = parse_notes(sections.get("註釋", []))
    bg = paragraphs(sections.get("創作背景", []))
    poem["background"] = bg[0] if len(bg) == 1 else bg
    poem["analysis"] = paragraphs(sections.get("賞析", []))
    ed = paragraphs(sections.get("版本", []))
    if ed:
        poem["edition"] = ed
    refs = [l.strip() for l in sections.get("參考資料", []) if l.strip()]
    if refs:
        poem["references"] = refs

    author = None
    if head.get("author_name") or head.get("dynasty") or sections.get("作者介紹"):
        intro = paragraphs(sections.get("作者介紹", []))
        author = {"name": head.get("author_name", ""), "dynasty": head.get("dynasty", ""),
                  "years": head.get("years", ""), "intro": intro[0] if len(intro) == 1 else intro}
        if author["name"].startswith("《"):
            author["kind"] = "source"
    return poem, author


def validate(poem, author, data):
    """沿用 validate_poems.py 的檢查。作者已存在時用現有資料，否則用稿件中的作者欄位。"""
    authors = dict(data["authors"])
    batch = {"authors": {}, "poems": [poem]}
    if poem["author"] not in authors:
        if not author or not author["name"]:
            raise DraftError(f"作者代號「{poem['author']}」是新作者，稿件中要寫「作者：」「朝代：」「生卒年：」與【作者介紹】")
        batch["authors"][poem["author"]] = author
        authors[poem["author"]] = author
    errs, warns = V.check(batch, authors, "稿件")
    raw = json.dumps([poem, author], ensure_ascii=False)
    for mark in ("（這句的語譯）", "（下一段第一句的語譯）", "寫在這裡", "賞析第一段"):
        if mark in raw:
            errs.append(f"稿件裡還有範本的示範文字「{mark}」，請換成實際內容")
    if not re.fullmatch(r"[a-z0-9-]+", poem["id"]):
        errs.append(f"代號只能用英文小寫、數字與 -：{poem['id']}")
    if not re.fullmatch(r"[a-z0-9]+", poem["author"]):
        errs.append(f"作者代號只能用英文小寫與數字：{poem['author']}")
    return errs, warns, batch["authors"]


def insert_position(data, dynasty):
    """放在同朝代最後一篇之後；沒有同朝代作品時，依朝代順序放入。"""
    rank = {d: i for i, d in enumerate(V.DYNASTIES)}
    me = rank.get(dynasty, 999)
    pos = 0
    for i, p in enumerate(data["poems"]):
        if rank.get(data["authors"][p["author"]]["dynasty"], 999) <= me:
            pos = i + 1
    return pos


def save(data):
    backup = ROOT / ".backup"
    backup.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    (backup / f"poems-{stamp}.json").write_text(DATA.read_text(encoding="utf-8"), encoding="utf-8")
    DATA.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return backup / f"poems-{stamp}.json"


def export(pid, data):
    p = next((x for x in data["poems"] if x["id"] == pid), None)
    if not p:
        raise DraftError(f"找不到代號 {pid}")
    a = data["authors"][p["author"]]
    out = [f"代號：{p['id']}", f"標題：{p['title']}", f"作者代號：{p['author']}",
           f"作者：{a['name']}", f"朝代：{a['dynasty']}", f"生卒年：{a['years']}"]
    if p.get("source"):
        out.append(f"出處：{p['source']}")
    out += [f"類型：{TYPE_NAMES[p['type']]}", f"體裁：{p['form']}", f"主題：{'、'.join(p['tags'])}", ""]
    intro = a["intro"] if isinstance(a["intro"], list) else [a["intro"]]
    out += ["【作者介紹】", "\n\n".join(intro), ""]
    if p.get("preface"):
        out += ["【小序】", p["preface"][0], "譯：" + p["preface"][1], ""]
    out.append("【原文與語譯】")
    for block in p["body"]:
        for src, tr in block:
            out += src.split("\n") + ["譯：" + tr]
        out.append("")
    out.append("【註釋】")
    out += [f"{n['term']}｜{n['in']}：{n['note']}" if n.get("in") else f"{n['term']}：{n['note']}" for n in p["notes"]]
    bg = p["background"] if isinstance(p["background"], list) else [p["background"]]
    out += ["", "【創作背景】", "\n\n".join(bg), ""]
    if p.get("edition"):
        out += ["【版本】", "\n\n".join(p["edition"]), ""]
    out += ["【賞析】", "\n\n".join(p["analysis"]), ""]
    if p.get("references"):
        out += ["【參考資料】", *p["references"], ""]
    return "\n".join(out)


def main():
    args = sys.argv[1:]
    if len(args) < 2 or args[0] not in ("check", "add", "export"):
        print(__doc__); sys.exit(2)
    data = json.loads(DATA.read_text(encoding="utf-8"))
    try:
        if args[0] == "export":
            text = export(args[1], data)
            if len(args) > 2:
                Path(args[2]).write_text(text, encoding="utf-8")
                print("已匯出到", args[2])
            else:
                print(text)
            return
        poem, author = parse(Path(args[1]).read_text(encoding="utf-8-sig"))
        replace = "--replace" in args
        exists = any(p["id"] == poem["id"] for p in data["poems"])
        if exists and not replace:
            raise DraftError(f"代號「{poem['id']}」已經存在。要修改這篇作品請加上 --replace，要新增請換一個代號")
        errs, warns, new_authors = validate(poem, author, data)
    except DraftError as e:
        print("錯誤", e); sys.exit(1)

    pairs = sum(len(b) for b in poem["body"])
    print(f"〈{poem['title']}〉：{len(poem['body'])} 段、{pairs} 句、註釋 {len(poem['notes'])} 則、賞析 {len(poem['analysis'])} 段")
    for w in warns:
        print("提醒", w)
    for e in errs:
        print("錯誤", e)
    if errs:
        print("錯誤數", len(errs)); sys.exit(1)
    if args[0] == "check":
        print("檢查通過，可以用 add 加入。"); return

    data["authors"].update(new_authors)
    if exists:
        i = next(i for i, p in enumerate(data["poems"]) if p["id"] == poem["id"])
        data["poems"][i] = poem
        action = "已取代"
    else:
        dyn = data["authors"][poem["author"]]["dynasty"]
        data["poems"].insert(insert_position(data, dyn), poem)
        action = "已加入"
    bak = save(data)
    if new_authors:
        print("新增作者：", "、".join(a["name"] for a in new_authors.values()))
    print(f"{action}〈{poem['title']}〉，原資料備份在 {bak.relative_to(ROOT)}")
    print("提醒：發布前把 public/sw.js 的 VERSION 改成新版本號，並記錄到 CHANGELOG.md。")


if __name__ == "__main__":
    main()
