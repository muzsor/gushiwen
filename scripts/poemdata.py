"""作品資料的共用工具：scripts/ 底下的工具都從這裡取用，不要各自重寫。

- 路徑：專案根目錄、public/data/poems.json、簡體版資料、備份資料夾
- 讀寫：read_json／write_json（統一的 JSON 格式）、save（備份 → 寫入 → 重新產生簡體版）
- 資料用語：朝代、體裁、類型的清單與排序
- 從文字欄位組成資料：paragraphs、make_record（稿件工具與網頁編輯器共用）
- 常用的資料處理：as_list、one_or_many、segments、full_text、insert_position、upsert_poem
- 命令列的檢查報告：print_report

在其他腳本中載入（python -I 不會把腳本所在的資料夾放進 sys.path，所以要自己加上）：
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import poemdata as D
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

# 命令列工具都印中文；Windows 的主控台預設不是 UTF-8，載入這個模組時統一設定
sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "public" / "data" / "poems.json"
HANS_DATA = ROOT / "public" / "data" / "poems.hans.json"
BACKUP = ROOT / ".backup"

# ---------- 資料用語：只在這裡維護。閱讀器用的 public/js/terms.js 由 make_hans.py 依這裡產生，
# 網頁編輯器向 editor.py 取得，改了清單之後執行一次 make_hans.py ----------
DYNASTIES = ["先秦", "秦", "漢", "三國", "魏晉", "南北朝", "隋", "唐", "五代", "宋", "元", "明", "清", "臺灣"]
FORMS = ["四言詩", "樂府詩", "五言古詩", "七言古詩", "雜言古詩", "五言絕句", "七言絕句", "五言律詩", "七言律詩",
         "詞", "散曲", "雜劇", "史傳", "論說", "奏議", "雜記", "辭賦", "序跋", "小說"]
TYPES = {"verse": "詩詞", "prose": "散文"}   # 資料中的值 → 顯示名稱


def dynasty_rank(dynasty):
    """朝代的先後順序；不在清單中的排在最後。"""
    return DYNASTIES.index(dynasty) if dynasty in DYNASTIES else len(DYNASTIES)


# ---------- 讀寫 ----------
def read_json(path=DATA):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(data, path=DATA):
    """全站統一的 JSON 格式：保留中文、縮排 2 格、檔尾換行。"""
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def save(data):
    """寫入 poems.json：先把原本的檔案備份到 .backup/，寫入後重新產生簡體版。
    回傳 (備份檔路徑, 簡體版的結果訊息)。"""
    BACKUP.mkdir(exist_ok=True)
    backup = BACKUP / f"poems-{datetime.now():%Y%m%d-%H%M%S}.json"
    backup.write_text(DATA.read_text(encoding="utf-8"), encoding="utf-8")
    write_json(data)
    return backup, regen_hans()


def regen_hans():
    """重新產生簡體版（make_hans.py）。沒有安裝 OpenCC 時只提醒，不影響儲存。"""
    import make_hans   # 延後載入：make_hans 也會載入這個模組
    try:
        n, problems = make_hans.build()
    except RuntimeError as e:
        return f"提醒：簡體版沒有更新（{e}），之後請執行 python -I scripts/make_hans.py"
    return f"已更新簡體版（{n} 篇）" + "".join(f"\n問題 {x}" for x in problems)


# ---------- 資料處理 ----------
def as_list(v):
    """有些欄位只有一段時存成字串、多段時存成陣列；統一當成陣列處理。"""
    return v if isinstance(v, list) else [v]


def one_or_many(items):
    """as_list 的反向：只有一段時存成字串，多段時存成陣列。"""
    return items[0] if len(items) == 1 else items


def paragraphs(text):
    """以空行分段，段內各行去掉前後空白後直接相連。"""
    out, cur = [], []
    for line in text.split("\n") + [""]:
        if line.strip():
            cur.append(line.strip())
        elif cur:
            out.append("".join(cur)); cur = []
    return out


def make_record(f):
    """把文字欄位組成一篇作品與作者的資料。稿件工具（add_poem.py）和網頁編輯器共用，
    欄位的整理方式（去掉空白、分段、只有一段時存成字串、選填欄位沒填就省略）只寫在這裡。

    f 的欄位（都是文字，沒有的可以省略）：
      作品：id、title、author（作者代號）、source、type（verse／prose）、form、tags（用頓號、逗號或空白分隔）、
            preface（[原文, 語譯]）、body（各段的 [原文, 語譯] 清單）、notes（{term, in, note} 清單）、
            background／analysis／edition（以空行分段）、references（一行一筆）
      作者：author_name、dynasty、years、intro（以空行分段）、kind（"source" 表示書籍出處）
    回傳 (poem, author)。沒有任何作者欄位時 author 為 None（稿件只寫作者代號，沿用現有的作者資料）。"""
    text = lambda k: (f.get(k) or "").strip()
    poem = {"id": text("id"), "title": text("title"), "author": text("author")}
    if text("source"):
        poem["source"] = text("source")
    poem["type"] = text("type")
    poem["form"] = text("form")
    poem["tags"] = [t for t in re.split(r"[、，,\s]+", f.get("tags") or "") if t]
    if f.get("preface"):
        poem["preface"] = [s.strip() for s in f["preface"]]
    body = [[[s.strip(), t.strip()] for s, t in block if s.strip() or t.strip()] for block in f.get("body") or []]
    poem["body"] = [b for b in body if b]
    poem["notes"] = []
    for n in f.get("notes") or []:
        term, ctx, note = ((n.get(k) or "").strip() for k in ("term", "in", "note"))
        if term or note:
            poem["notes"].append({"term": term, **({"in": ctx} if ctx else {}), "note": note})
    poem["background"] = one_or_many(paragraphs(f.get("background") or ""))
    edition = paragraphs(f.get("edition") or "")
    if edition:
        poem["edition"] = edition
    poem["analysis"] = paragraphs(f.get("analysis") or "")
    refs = [s.strip() for s in (f.get("references") or "").split("\n") if s.strip()]
    if refs:
        poem["references"] = refs

    author = None
    if any(text(k) for k in ("author_name", "dynasty", "years", "intro")):
        author = {"name": text("author_name"), "dynasty": text("dynasty"), "years": text("years"),
                  "intro": one_or_many(paragraphs(f.get("intro") or ""))}
        if f.get("kind") == "source":
            author["kind"] = "source"
    return poem, author


def segments(p):
    """原文各段：小序一段，之後每段（散文）或每章／片（詩詞）一段。和閱讀器標註釋時的分段相同。"""
    return ([p["preface"][0]] if p.get("preface") else []) + ["".join(pair[0] for pair in b) for b in p["body"]]


def full_text(p):
    """整篇原文（保留詩句中的換行），用來檢查註釋的詞找不找得到。"""
    return "".join(segments(p))


def insert_position(data, dynasty):
    """新作品放在同朝代最後一篇之後；沒有同朝代作品時，依朝代順序放入。"""
    me, pos = dynasty_rank(dynasty), 0
    for i, p in enumerate(data["poems"]):
        if dynasty_rank(data["authors"][p["author"]]["dynasty"]) <= me:
            pos = i + 1
    return pos


def upsert_poem(data, poem, original_id=None, dynasty=None):
    """original_id 有值時取代那一篇（代號可以改），否則依朝代插入新作品。回傳 "replaced" 或 "added"。"""
    if original_id:
        i = next(i for i, p in enumerate(data["poems"]) if p["id"] == original_id)
        data["poems"][i] = poem
        return "replaced"
    dynasty = dynasty or data["authors"][poem["author"]]["dynasty"]
    data["poems"].insert(insert_position(data, dynasty), poem)
    return "added"


# ---------- 命令列報告 ----------
def print_report(errs, warns):
    """印出提醒與錯誤；回傳錯誤數（呼叫端有錯誤時以結束代碼 1 離開）。"""
    for w in warns:
        print("提醒", w)
    for e in errs:
        print("錯誤", e)
    print("錯誤數", len(errs))
    return len(errs)
