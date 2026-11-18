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
import importlib.util
import json
import mimetypes
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
EDITOR = ROOT / "editor"
SITE = ROOT / "public"

_spec = importlib.util.spec_from_file_location("add_poem", Path(__file__).with_name("add_poem.py"))
A = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(A)
V = A.V

PORT = 8770
if "--port" in sys.argv:
    PORT = int(sys.argv[sys.argv.index("--port") + 1])
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}


def load():
    return json.loads(A.DATA.read_text(encoding="utf-8"))


def check_payload(body, data):
    """回傳 (poem, author_id, author, errors, warnings)。author 為要寫入的作者資料（新增或修改）。"""
    poem = body.get("poem") or {}
    author = body.get("author") or {}
    aid = (author.get("id") or poem.get("author") or "").strip()
    poem["author"] = aid
    rec = {k: author[k] for k in ("name", "dynasty", "years", "intro") if k in author}
    if author.get("kind") == "source":
        rec["kind"] = "source"
    errs = []
    if not aid:
        errs.append("請選擇作者，或填寫新作者的代號")
    elif not rec.get("name"):
        errs.append("作者名稱不能空白")
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
    if rec:
        e2 = []
        V.check_chars("作者", rec.get("name", "") + json.dumps(rec.get("intro", ""), ensure_ascii=False), e2)
        if rec.get("dynasty") not in V.DYNASTIES:
            e2.append(f"作者朝代不在清單：{rec.get('dynasty')}")
        if not rec.get("years"):
            e2.append("作者生卒年不能空白（不詳請寫「生卒年不詳」）")
        if not rec.get("intro"):
            e2.append("作者介紹不能空白")
        e += e2
    # 編輯器中只有一篇作品，去掉驗證訊息前面的「[稿件] 代號 標題:」
    strip = lambda m: m.split(": ", 1)[1] if m.startswith("[稿件] ") and ": " in m else m
    return poem, aid, rec, errs + [strip(x) for x in e], [strip(x) for x in w]


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
            return self._send(200, {"data": load(), "dynasties": V.DYNASTIES, "forms": V.FORMS})
        if url.path == "/api/export":
            pid = parse_qs(url.query).get("id", [""])[0]
            try:
                return self._send(200, {"text": A.export(pid, load())})
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
        data = load()

        if path == "/api/check":
            _, _, _, errs, warns = check_payload(body, data)
            return self._send(200, {"errors": errs, "warnings": warns})

        if path == "/api/save":
            poem, aid, rec, errs, warns = check_payload(body, data)
            if errs:
                return self._send(200, {"ok": False, "errors": errs, "warnings": warns})
            data["authors"][aid] = rec
            orig = body.get("originalId")
            if orig:
                i = next(i for i, p in enumerate(data["poems"]) if p["id"] == orig)
                data["poems"][i] = poem
            else:
                data["poems"].insert(A.insert_position(data, rec["dynasty"]), poem)
            bak = A.save(data)
            return self._send(200, {"ok": True, "warnings": warns, "backup": str(bak.relative_to(ROOT))})

        if path == "/api/delete":
            pid = body.get("id")
            if not any(p["id"] == pid for p in data["poems"]):
                return self._send(200, {"ok": False, "errors": [f"找不到作品「{pid}」"]})
            data["poems"] = [p for p in data["poems"] if p["id"] != pid]
            # 這位作者已經沒有其他作品時，一併移除作者資料
            used = {p["author"] for p in data["poems"]}
            removed = [a["name"] for k, a in data["authors"].items() if k not in used]
            data["authors"] = {k: a for k, a in data["authors"].items() if k in used}
            bak = A.save(data)
            return self._send(200, {"ok": True, "removedAuthors": removed, "backup": str(bak.relative_to(ROOT))})

        if path == "/api/reorder":
            # order：全部作品代號的新順序。閱讀器依朝代先後排列，同朝代內依這個順序
            order = body.get("order") or []
            ids = [p["id"] for p in data["poems"]]
            if sorted(order) != sorted(ids) or len(set(order)) != len(order):
                return self._send(200, {"ok": False, "errors": ["作品清單已有變動，請重新整理編輯器後再調整順序"]})
            by = {p["id"]: p for p in data["poems"]}
            if [p["id"] for p in data["poems"]] == order:
                return self._send(200, {"ok": True, "unchanged": True})
            data["poems"] = [by[i] for i in order]
            bak = A.save(data)
            return self._send(200, {"ok": True, "backup": str(bak.relative_to(ROOT))})

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
