"""古詩文網頁編輯器的本機伺服器（只在自己的電腦上使用，不會部署）。

用法（在專案資料夾執行）：
  python -I scripts/editor.py            開啟後瀏覽 http://127.0.0.1:8770
  python -I scripts/editor.py --port 9000

安全：
- 只接受本機（127.0.0.1）連線，同一個網路的其他裝置連不進來。
- 只回應 Host 為本機的請求，修改資料的請求還要求來源（Origin）也是本機，
  避免其他網站透過瀏覽器偷偷呼叫。
- 每次寫入前把原本的 public/data/poems.json 備份到 .backup/。

網址：
  /            編輯器（editor/ 資料夾）
  /site/       網站本身（public/ 資料夾），用來預覽
  /api/...     讀寫資料
"""
import json
import mimetypes
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import poemdata as D
import validate_poems as V
import add_poem as A

EDITOR = D.ROOT / "editor"
SITE = D.ROOT / "public"

PORT = 8770
if "--port" in sys.argv:
    PORT = int(sys.argv[sys.argv.index("--port") + 1])
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}


def form_record(body):
    """編輯器送來的是表單上的原始文字（fields）；整理成資料的方式和稿件工具相同（poemdata.make_record）。"""
    poem, author = D.make_record(body.get("fields") or {})
    return poem, author or {}


def check_payload(body, data):
    """回傳 (poem, author_id, author, errors, warnings)。author 為要寫入的作者資料（新增或修改）。"""
    try:
        poem, rec = form_record(body)
    except Exception as ex:   # 表單結構不完整時，回報而不是讓伺服器出錯
        return {}, "", {}, [f"資料格式有誤：{ex}"], []
    aid = poem["author"]
    errs = []
    if not aid:
        errs.append("請選擇作者，或填寫新作者的代號")
    elif not V.AUTHOR_ID_RE.fullmatch(aid):
        errs.append(f"作者代號只能用英文小寫與數字：{aid}")
    orig = body.get("originalId") or None
    ids = [p["id"] for p in data["poems"]]
    if poem.get("id") in ids and poem.get("id") != orig:
        errs.append(f"代號「{poem.get('id')}」已被其他作品使用")
    if orig and orig not in ids:
        errs.append(f"找不到原本的作品「{orig}」，可能已被刪除")
    # 用暫時的資料檢查（作者以表單內容為準）
    tmp = {"authors": dict(data["authors"]), "poems": [p for p in data["poems"] if p["id"] != orig]}
    if aid:
        tmp["authors"][aid] = rec
    try:
        e, w, _ = A.validate(poem, rec if aid not in data["authors"] else None, tmp)
    except A.DraftError as ex:
        e, w = [str(ex)], []
    except Exception as ex:   # 表單結構不完整時，回報而不是讓伺服器出錯
        e, w = [f"資料格式有誤：{ex}"], []
    if aid:
        e += V.check_author(rec)   # 作者資料以表單內容為準（和資料檢查、稿件工具同一套規則）
    # 編輯器中只有一篇作品，去掉驗證訊息前面的「[稿件] 代號 標題:」
    strip = lambda m: m.split(": ", 1)[1] if m.startswith("[稿件] ") and ": " in m else m
    return poem, aid, rec, errs + [strip(x) for x in e], [strip(x) for x in w]


def note_statuses(body):
    """表單上每一列註釋的狀態（包含還沒填的空白列），規則和儲存時的檢查相同（validate_poems.note_status）。"""
    poem, _ = form_record(body)
    full = D.full_text(poem)
    rows = (body.get("fields") or {}).get("notes") or []
    return [V.note_status({k: (n.get(k) or "").strip() for k in ("term", "in", "note")}, full, poem["title"]) for n in rows]


# ---------- 快速貼上：把整篇原文與整篇語譯切成逐句的配對 ----------
SENTENCE = re.compile(r"[^。！？]*[。！？]+[」』]*|[^。！？]+$")
SENTENCE_END = re.compile(r"[。！？][」』]*$")


def split_source(text, verse):
    """詩詞依行切，到句號、問號、驚嘆號才算一句（同一句的幾行保留分行）；散文依標點切句。空行代表換段。"""
    blocks = []
    for block in re.split(r"\n\s*\n", text):
        if verse:
            sents, cur = [], []
            for line in filter(None, (s.strip() for s in block.split("\n"))):
                cur.append(line)
                if SENTENCE_END.search(line):
                    sents.append("\n".join(cur)); cur = []
            if cur:
                sents.append("\n".join(cur))
        else:
            sents = SENTENCE.findall(re.sub(r"\s+", "", block))
        if sents:
            blocks.append(sents)
    return blocks


def paste_pairs(source, translation, verse):
    """依順序把原文各句配上語譯；語譯多出來的放在最後一段的最後。回傳 (各段的配對, 句數統計)。"""
    src = split_source(source, verse)
    trs = [SENTENCE.findall(p) for p in D.paragraphs(translation)]
    flat = [t for p in trs for t in p]
    k, blocks = 0, []
    for b in src:
        blocks.append([[s, flat[k + i] if k + i < len(flat) else ""] for i, s in enumerate(b)])
        k += len(b)
    if blocks and k < len(flat):
        blocks[-1].append(["", "".join(flat[k:])])
    counts = {"srcBlocks": len(src), "srcSentences": sum(map(len, src)),
              "trBlocks": len(trs), "trSentences": len(flat)}
    return blocks, counts


class Handler(BaseHTTPRequestHandler):
    server_version = "GushiwenEditor"

    def log_message(self, fmt, *args):
        pass

    def _host_ok(self):
        return self.headers.get("Host", "") in ALLOWED_HOSTS

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def _saved(self, data, **extra):
        """寫入資料（備份、更新簡體版）並回報結果；簡體版的訊息也一併傳回編輯器顯示。"""
        backup, hans = D.save(data)
        print(hans)
        self._send(200, {"ok": True, "backup": str(backup.relative_to(D.ROOT)), "hans": hans, **extra})

    def _static(self, base, rel):
        path = (base / unquote(rel or "index.html")).resolve()
        if base.resolve() not in path.parents and path != base.resolve():
            return self._send(403, {"error": "forbidden"})
        if path.is_dir():
            path = path / "index.html"
        if not path.is_file():
            return self._send(404, {"error": "not found"})
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self._send(200, path.read_bytes(), ctype)

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, {"error": "只接受本機連線"})
        url = urlparse(self.path)
        if url.path == "/api/data":
            return self._send(200, {"data": D.read_json(), "dynasties": D.DYNASTIES, "forms": D.FORMS, "types": D.TYPES})
        if url.path == "/api/export":
            pid = parse_qs(url.query).get("id", [""])[0]
            try:
                return self._send(200, {"text": A.export(pid, D.read_json())})
            except A.DraftError as e:
                return self._send(400, {"error": str(e)})
        if url.path.startswith("/site"):
            rel = url.path[len("/site"):].lstrip("/")
            if rel == "sw.js":   # 預覽時不啟用離線快取，存檔後重新整理就能看到最新內容
                return self._send(404, {"error": "預覽模式不使用離線快取"})
            return self._static(SITE, rel)
        return self._static(EDITOR, url.path.lstrip("/"))

    def do_POST(self):
        origin = self.headers.get("Origin", "")
        if not self._host_ok() or origin.split("://")[-1] not in ALLOWED_HOSTS:
            return self._send(403, {"error": "只接受本機編輯器的請求"})
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            return self._send(415, {"error": "需要 JSON"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))).decode("utf-8"))
        except Exception:
            return self._send(400, {"error": "無法解析的請求"})
        path = urlparse(self.path).path
        data = D.read_json()

        if path == "/api/check":
            _, _, _, errs, warns = check_payload(body, data)
            return self._send(200, {"errors": errs, "warnings": warns})

        if path == "/api/notes":
            try:
                return self._send(200, {"ok": True, "statuses": note_statuses(body)})
            except Exception as ex:
                return self._send(200, {"ok": False, "errors": [f"資料格式有誤：{ex}"]})

        if path == "/api/split":
            blocks, counts = paste_pairs(body.get("source", ""), body.get("translation", ""), body.get("verse", True))
            return self._send(200, {"ok": True, "blocks": blocks, **counts})

        if path == "/api/save":
            poem, aid, rec, errs, warns = check_payload(body, data)
            if errs:
                return self._send(200, {"ok": False, "errors": errs, "warnings": warns})
            # 編輯器的作者欄位一律寫回（修改作者資料會套用到這位作者的所有作品）；稿件工具則只新增新作者
            data["authors"][aid] = rec
            D.upsert_poem(data, poem, body.get("originalId"), rec["dynasty"])
            return self._saved(data, warnings=warns, id=poem["id"])

        if path == "/api/delete":
            pid = body.get("id")
            if not any(p["id"] == pid for p in data["poems"]):
                return self._send(200, {"ok": False, "errors": [f"找不到作品「{pid}」"]})
            data["poems"] = [p for p in data["poems"] if p["id"] != pid]
            # 這位作者已經沒有其他作品時，一併移除作者資料
            used = {p["author"] for p in data["poems"]}
            removed = [a["name"] for k, a in data["authors"].items() if k not in used]
            data["authors"] = {k: a for k, a in data["authors"].items() if k in used}
            return self._saved(data, removedAuthors=removed)

        if path == "/api/reorder":
            # order：全部作品代號的新順序。閱讀器依朝代先後排列，同朝代內依這個順序
            order = body.get("order") or []
            ids = [p["id"] for p in data["poems"]]
            if sorted(order) != sorted(ids) or len(set(order)) != len(order):
                return self._send(200, {"ok": False, "errors": ["作品清單已有變動，請重新整理編輯器後再調整順序"]})
            by = {p["id"]: p for p in data["poems"]}
            if ids == order:
                return self._send(200, {"ok": True, "unchanged": True})
            data["poems"] = [by[i] for i in order]
            return self._saved(data)

        if path == "/api/import":
            try:
                poem, author = A.parse(body.get("text", ""))
            except A.DraftError as e:
                return self._send(200, {"ok": False, "errors": [str(e)]})
            return self._send(200, {"ok": True, "poem": poem, "author": author})

        return self._send(404, {"error": "not found"})


def main():
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"古詩文編輯器已啟動：http://127.0.0.1:{PORT}")
    print("只在這臺電腦上可以使用。關閉請按 Ctrl+C。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已關閉")


if __name__ == "__main__":
    main()
