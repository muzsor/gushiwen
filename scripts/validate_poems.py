"""檢查 public/data/poems.json 的格式與內容。

用法：
  python -I scripts/validate_poems.py check public/data/poems.json
  python -I scripts/validate_poems.py merge <現有.json> <輸出.json> <新增1.json> [新增2.json ...]   檢查後合併

檢查項目：必要欄位、作者對應、朝代與體裁是否在清單內、原文與語譯是否成對、
註釋是否標得到原文、是否混入簡體字或非教育部標準字形。
有「錯誤」時結束代碼為 1；「提醒」不影響結果。
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import poemdata as D

DYNASTIES, FORMS = D.DYNASTIES, D.FORMS   # 清單在 poemdata.py，這裡沿用舊名稱給其他工具引用
ID_RE = re.compile(r"[a-z0-9-]+")          # 作品代號
AUTHOR_ID_RE = re.compile(r"[a-z0-9]+")    # 作者代號
# 常見簡體字（排除繁體文言中也會用的字，如云、后、余、于、只、台、里、范、采）
SIMPLIFIED = set("们这为时东门见发来国学个书长马鸟问间关观对开头实变让认进运还过无语说请读调论证识话该车军张亲树电乐乡兴举义从众会传伤体儿兰写农决净凤击刘则刚创别剑剧劝办务动劳势区医华单卖卫历压县参双叶号听启员响团园围图圆圣场坏块坚坛声处备复够夺奋奖妇妈孙宁宝审宫宽宾寻导寿将尔尘尝尽层岁岂岛岭师帅帐帘带帮广庄庆库应庙废异弃弹归当录彻径忆忧怀态总恋恶惊惨惯愿战户扑执扩扫扬扰抚报担拟择挂挥损换摆摇敌数断旧显晓晕暂术杀杂权条杨杰极构枪柜标栏样桥梦检楼欢欧残毁毕气汇汉汤沟没泪泽洁浅浆测济浑浓涛涨渐渔温湾湿满滚滞潜灭灯灵灾烂烟烦烧热爱爷牵犹独狮猎献环现画畅疗盐监盖盘矿码础确碍礼祸离种积称稳穷窃竞笔筑签简类粮紧红约级纪纯纲纳纵纷纸线练组细织终绍经结绕绘给络绝统继绩续绳维绵绿缓编缘网罗罚罢职联肃肠肤胆脉脑脚脸艰艺节芦苍苏荐药莲获营萧蓝虑虚虽蚕补装规视览觉触计订讨训议讯记讲许设访评诉词译试诗诚询详误谁谈谋谓谢谦谨谱贝负贡财责贤败货质贩贪贫购贯贵贸费贺资赏赐赞赢赵赶趋跃践踪轨轮软轻载较辅辈输辞边辽达迁迈违连迟递遗邻郑酿释针钟钢钱铁铜银铺链销锁锋错锦镇闭闲闻阅阔队阳阴阵阶际陆陈险随隐难雾韩页顶项顺须顾顿预领频题颜额风飞饭饮饰馆驱驻骑鱼鲜鸡鸣鸭鸿鹤黄齐齿龙龟")
# 非臺灣教育部標準字形的異體字 → 標準字
VARIANTS = {"内": "內", "户": "戶", "吴": "吳", "説": "說", "悦": "悅", "脱": "脫", "税": "稅", "锐": "銳", "兑": "兌",
            "鷄": "雞", "峯": "峰", "敎": "教", "淸": "清", "靑": "青", "眞": "真", "卽": "即", "旣": "既", "産": "產",
            "鄕": "鄉", "争": "爭", "爲": "為", "裏": "裡", "衆": "眾", "着": "著", "温": "溫", "吕": "呂", "彦": "彥",
            "綫": "線", "麽": "麼", "強": None}
VARIANTS = {k: v for k, v in VARIANTS.items() if v}


def pair_problem(x):
    """一筆 [原文, 語譯] 的問題；沒有問題時回傳 None。"""
    if not (isinstance(x, list) and len(x) == 2 and all(isinstance(s, str) for s in x)):
        return '格式應為 ["原文", "語譯"]'
    if not x[0].strip() and not x[1].strip():
        return "原文與語譯都是空的"
    if not x[0].strip():
        return "原文是空的"
    if not x[1].strip():
        return "語譯是空的"
    return None


def texts_of(p):
    yield "title", p["title"]
    if p.get("source"):
        yield "source", p["source"]
    if p.get("preface"):
        yield "preface", "".join(p["preface"])
    for b, block in enumerate(p["body"]):
        for i, pair in enumerate(block):
            yield f"body[{b}][{i}]", "".join(pair)
    for n in p["notes"]:
        yield f"note:{n['term']}", n["term"] + n.get("in", "") + n["note"]
    for k in ("background", "analysis"):
        for i, t in enumerate(D.as_list(p[k])):
            yield f"{k}[{i}]", t
    for i, t in enumerate(p.get("edition") or []):
        yield f"edition[{i}]", t
    for i, t in enumerate(p.get("references") or []):
        yield f"references[{i}]", t


# 有些字在繁體文言中本來就有獨立用法，只在這些詞裡放行（其他地方出現仍視為簡體字）
TRAD_OK = ["敲扑", "曰扑", "鞭扑", "愿而恭", "謹愿", "鄉愿", "愿，", "愿：", "「愿」"]


def check_chars(where, text, errs):
    for w in TRAD_OK:
        text = text.replace(w, "")
    bad = sorted({c for c in text if c in SIMPLIFIED})
    if bad:
        errs.append(f"{where}: 疑似簡體字 {''.join(bad)}")
    var = sorted({c for c in text if c in VARIANTS})
    if var:
        errs.append(f"{where}: 非標準字形 " + "、".join(f"{c}→{VARIANTS[c]}" for c in var))


def note_status(n, full, title):
    """一則註釋標不標得到原文，回傳 (等級, 標籤, 說明)。資料檢查與網頁編輯器的註釋狀態共用這一份規則。
    等級：err 錯誤（擋下儲存）、warn 提醒、hint 只在網頁編輯器顯示的小提示、ok 沒有問題。
    full 是整篇原文（poemdata.full_text），title 是題目。"""
    term, ctx, note = (n.get(k, "") for k in ("term", "in", "note"))
    if not term:
        return "err", "未填詞", "請填寫要註解的詞"
    if ctx:
        if term not in ctx:
            return "err", "前後文不含詞", "「前後文」（in）裡必須包含這個詞"
        cnt = full.count(ctx)
        if cnt == 0:
            return "err", "找不到前後文", f"原文中找不到「{ctx}」，請確認一字不差"
        if cnt > 1:
            return "err", f"前後文出現 {cnt} 次", f"「{ctx}」在原文出現不只一次，請多抄幾個字，讓它只出現一次"
        found = "ok", "找到", "已用前後文指定位置，閱讀頁會標在這個位置"
    elif term not in full:
        if term not in title:
            return "err", "找不到", "原文和題目都沒有這個詞，請確認用字一字不差"
        found = "warn", "只在題目", "這個詞只出現在題目中，閱讀頁會把底線標在標題上"
    elif len(term) == 1 and full.count(term) > 1:
        found = ("hint", "出現多次", "這個字在原文出現不只一次，底線會標在第一次出現的地方；"
                 "要標在別處，請在「前後文」填入它所在的一小段原文")
    else:
        found = "ok", "找到", "原文中找得到這個詞，閱讀頁會在它下面標底線"
    if not note:
        return "err", "未填解釋", "請填寫這個詞的解釋"
    return found


AUTHOR_FIELDS ={"name": "名稱", "dynasty": "朝代", "years": "生卒年（不詳請寫「生卒年不詳」）", "intro": "介紹"}


def check_author(a):
    """一位作者（或出處）的資料問題；網頁編輯器、稿件工具與資料檢查共用。介紹可以是一段（字串）或多段（陣列）。"""
    errs = [f"作者{label}不能空白" for k, label in AUTHOR_FIELDS.items() if not a.get(k)]
    if a.get("dynasty") and a["dynasty"] not in DYNASTIES:
        errs.append(f"作者朝代不在清單：{a['dynasty']}")
    check_chars("作者", a.get("name", "") + "".join(D.as_list(a.get("intro") or "")), errs)
    return errs


def check(data, authors_all, name):
    errs, warns = [], []
    for aid, a in data.get("authors", {}).items():
        if not AUTHOR_ID_RE.fullmatch(aid):
            errs.append(f"[{name}] 作者代號只能用英文小寫與數字：{aid}")
        errs += [f"[{name}] 作者 {aid}: {e}" for e in check_author(a)]
    for p in data["poems"]:
        tag = f"[{name}] {p.get('id', '?')} {p.get('title', '')}"
        missing = [k for k in ("id", "title", "author", "type", "form", "tags", "body", "notes", "background", "analysis") if k not in p]
        if missing:
            errs.append(f"{tag}: 缺 {'、'.join(missing)}")
            continue
        if not ID_RE.fullmatch(p["id"]):
            errs.append(f"{tag}: 代號只能用英文小寫、數字與 -：{p['id']}")
        if p["author"] not in authors_all:
            errs.append(f"{tag}: 找不到作者 {p['author']}")
        if p["form"] not in FORMS:
            errs.append(f"{tag}: 體裁不在清單：{p['form']}")
        if p["type"] not in D.TYPES:
            errs.append(f"{tag}: type 只能是 {' 或 '.join(D.TYPES)}：{p['type']}")
        refs = p.get("references")
        if refs is not None and (not isinstance(refs, list) or not all(isinstance(r, str) and r.strip() for r in refs)):
            errs.append(f"{tag}: references 要是字串陣列，每筆一項參考資料")
        ed = p.get("edition")
        if ed is not None and (not isinstance(ed, list) or not all(isinstance(r, str) and r.strip() for r in ed)):
            errs.append(f"{tag}: edition 要是字串陣列，每筆一段版本說明")
        if p.get("preface") is not None and pair_problem(p["preface"]):
            errs.append(f"{tag}: 小序的{pair_problem(p['preface'])}")
        body = p["body"]
        if not isinstance(body, list) or not body:
            errs.append(f"{tag}: 原文與語譯（body）不能是空的")
            continue
        bad = False
        for b, block in enumerate(body):
            if not isinstance(block, list) or not block:
                errs.append(f"{tag}: 第 {b + 1} 段是空的"); bad = True; continue
            for i, pair in enumerate(block):
                prob = pair_problem(pair)
                if prob:
                    errs.append(f"{tag}: 第 {b + 1} 段第 {i + 1} 句的{prob}"); bad = True
        if bad:
            continue
        full = D.full_text(p)
        for n in p["notes"]:
            level, label, why = note_status(n, full, p["title"])
            msg = f"{tag}: 註釋「{n.get('term') or n.get('note', '')[:10]}」{label}：{why}"
            if level == "err":
                errs.append(msg)
            elif level == "warn":
                warns.append(msg)
        # 同一處原文被兩則註釋重疊時，App 只能標出其中一則（另一則點不到）
        plain = [n["term"] for n in p["notes"] if n.get("term") and not n.get("in")]
        for a in plain:
            for b2 in plain:
                if a != b2 and a in b2 and full.count(a) == full.count(b2):
                    warns.append(f"{tag}: 註釋「{a}」完全包在註釋「{b2}」裡，App 標不出「{a}」；請合併或改用 in 指定位置")
        if len(p["analysis"]) < 3:
            warns.append(f"{tag}: 賞析只有 {len(p['analysis'])} 段")
        for where, text in texts_of(p):
            check_chars(f"{tag} {where}", text, errs)
    return errs, warns


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "check" and len(sys.argv) >= 3:
        base, out, files = None, None, sys.argv[2:]
    elif mode == "merge" and len(sys.argv) >= 5:
        base, out, files = Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4:]
    else:
        print(__doc__)
        sys.exit(2)
    merged = D.read_json(base) if base else {"authors": {}, "poems": []}
    batches = [(Path(f).name, D.read_json(f)) for f in files]

    authors_all = dict(merged["authors"])
    errs = []
    for name, d in batches:
        for aid, a in d.get("authors", {}).items():
            if aid in authors_all:
                errs.append(f"[{name}] 作者代號重複：{aid}")
            authors_all[aid] = a
    ids = [p["id"] for p in merged["poems"]] + [p["id"] for _, d in batches for p in d["poems"]]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        errs.append(f"作品代號重複：{', '.join(dup)}")

    warns = []
    for name, d in batches:
        e, w = check(d, authors_all, name)
        errs += e
        warns += w
    print(f"作品 {len(ids)} 篇，作者／出處 {len(authors_all)} 筆")
    if D.print_report(errs, warns):
        sys.exit(1)
    if out:
        merged["authors"] = authors_all
        merged["poems"] += [p for _, d in batches for p in d["poems"]]
        if out.resolve() == D.DATA.resolve():   # 寫回網站資料時和其他工具一樣：先備份，寫入後更新簡體版
            backup, hans = D.save(merged)
            print(f"已寫入 {out}（原資料備份在 {backup.relative_to(D.ROOT)}）")
            print(hans)
        else:
            D.write_json(merged, out)
            print("已寫入", out)


if __name__ == "__main__":
    main()
