"""檢查 public/data/poems.json 的格式與內容。

用法：
  python -I scripts/validate_poems.py check public/data/poems.json
  python -I scripts/validate_poems.py merge <現有.json> <輸出.json> <新增1.json> [新增2.json ...]   檢查後合併

檢查項目：必要欄位、作者對應、朝代與體裁是否在清單內、原文與語譯是否成對、
註釋是否標得到原文、是否混入簡體字或非教育部標準字形。
有「錯誤」時結束代碼為 1；「提醒」不影響結果。
"""
import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

DYNASTIES = ["先秦", "秦", "漢", "三國", "魏晉", "南北朝", "隋", "唐", "五代", "宋", "元", "明", "清", "臺灣"]
FORMS = ["四言詩", "樂府詩", "五言古詩", "七言古詩", "雜言古詩", "五言絕句", "七言絕句", "五言律詩", "七言律詩",
         "詞", "散曲", "史傳", "論說", "奏議", "雜記", "辭賦", "序跋", "小說"]
# 常見簡體字（排除正體文言中也會用的字，如云、后、余、于、只、台、里、范、采）
SIMPLIFIED = set("们这为时东门见发来国学个书长马鸟问间关观对开头实变让认进运还过无语说请读调论证识话该车军张亲树电乐乡兴举义从众会传伤体儿兰写农决净凤击刘则刚创别剑剧劝办务动劳势区医华单卖卫历压县参双叶号听启员响团园围图圆圣场坏块坚坛声处备复够夺奋奖妇妈孙宁宝审宫宽宾寻导寿将尔尘尝尽层岁岂岛岭师帅帐帘带帮广庄庆库应庙废异弃弹归当录彻径忆忧怀态总恋恶惊惨惯愿战户扑执扩扫扬扰抚报担拟择挂挥损换摆摇敌数断旧显晓晕暂术杀杂权条杨杰极构枪柜标栏样桥梦检楼欢欧残毁毕气汇汉汤沟没泪泽洁浅浆测济浑浓涛涨渐渔温湾湿满滚滞潜灭灯灵灾烂烟烦烧热爱爷牵犹独狮猎献环现画畅疗盐监盖盘矿码础确碍礼祸离种积称稳穷窃竞笔筑签简类粮紧红约级纪纯纲纳纵纷纸线练组细织终绍经结绕绘给络绝统继绩续绳维绵绿缓编缘网罗罚罢职联肃肠肤胆脉脑脚脸艰艺节芦苍苏荐药莲获营萧蓝虑虚虽蚕补装规视览觉触计订讨训议讯记讲许设访评诉词译试诗诚询详误谁谈谋谓谢谦谨谱贝负贡财责贤败货质贩贪贫购贯贵贸费贺资赏赐赞赢赵赶趋跃践踪轨轮软轻载较辅辈输辞边辽达迁迈违连迟递遗邻郑酿释针钟钢钱铁铜银铺链销锁锋错锦镇闭闲闻阅阔队阳阴阵阶际陆陈险随隐难雾韩页顶项顺须顾顿预领频题颜额风飞饭饮饰馆驱驻骑鱼鲜鸡鸣鸭鸿鹤黄齐齿龙龟")
# 非台灣教育部標準字形的異體字 → 標準字
VARIANTS = {"内": "內", "户": "戶", "吴": "吳", "説": "說", "悦": "悅", "脱": "脫", "税": "稅", "锐": "銳", "兑": "兌",
            "鷄": "雞", "峯": "峰", "敎": "教", "淸": "清", "靑": "青", "眞": "真", "卽": "即", "旣": "既", "産": "產",
            "鄕": "鄉", "争": "爭", "爲": "為", "裏": "裡", "衆": "眾", "着": "著", "温": "溫", "吕": "呂", "彦": "彥",
            "綫": "線", "麽": "麼", "強": None}
VARIANTS = {k: v for k, v in VARIANTS.items() if v}


def is_pair(x):
    return isinstance(x, list) and len(x) == 2 and all(isinstance(s, str) and s.strip() for s in x)


def full_text(p):
    return (p["preface"][0] if p.get("preface") else "") + "".join(pair[0] for block in p["body"] for pair in block)


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
        v = p[k]
        for i, t in enumerate(v if isinstance(v, list) else [v]):
            yield f"{k}[{i}]", t


def check_chars(where, text, errs):
    bad = sorted({c for c in text if c in SIMPLIFIED})
    if bad:
        errs.append(f"{where}: 疑似簡體字 {''.join(bad)}")
    var = sorted({c for c in text if c in VARIANTS})
    if var:
        errs.append(f"{where}: 非標準字形 " + "、".join(f"{c}→{VARIANTS[c]}" for c in var))


def check(data, authors_all, name):
    errs, warns = [], []
    for aid, a in data.get("authors", {}).items():
        for k in ("name", "dynasty", "years", "intro"):
            if not a.get(k):
                errs.append(f"[{name}] 作者 {aid} 缺 {k}")
        if a.get("dynasty") not in DYNASTIES:
            errs.append(f"[{name}] 作者 {aid} 朝代不在清單：{a.get('dynasty')}")
        check_chars(f"[{name}] 作者 {aid}", a.get("name", "") + a.get("intro", ""), errs)
    for p in data["poems"]:
        tag = f"[{name}] {p.get('id', '?')} {p.get('title', '')}"
        missing = [k for k in ("id", "title", "author", "type", "form", "tags", "body", "notes", "background", "analysis") if k not in p]
        if missing:
            errs.append(f"{tag}: 缺 {'、'.join(missing)}")
            continue
        if p["author"] not in authors_all:
            errs.append(f"{tag}: 找不到作者 {p['author']}")
        if p["form"] not in FORMS:
            errs.append(f"{tag}: 體裁不在清單：{p['form']}")
        if p["type"] not in ("verse", "prose"):
            errs.append(f"{tag}: type 只能是 verse 或 prose：{p['type']}")
        def pair_problem(x):
            if not (isinstance(x, list) and len(x) == 2 and all(isinstance(s, str) for s in x)):
                return "格式應為 [\"原文\", \"語譯\"]"
            if not x[0].strip() and not x[1].strip():
                return "原文與語譯都是空的"
            if not x[0].strip():
                return "原文是空的"
            if not x[1].strip():
                return "語譯是空的"
            return None

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
        full = full_text(p)
        for n in p["notes"]:
            t = n.get("term", "")
            if not t or not n.get("note"):
                errs.append(f"{tag}: 註釋缺 term 或 note：{n}")
                continue
            if n.get("in"):
                cnt = full.count(n["in"])
                if cnt != 1:
                    errs.append(f"{tag}: 註釋「{t}」的 in 片段出現 {cnt} 次（須唯一）：{n['in']}")
                if t not in n["in"]:
                    errs.append(f"{tag}: 註釋「{t}」不在 in 片段中")
            elif t not in full:
                if t in p["title"]:
                    warns.append(f"{tag}: 註釋「{t}」只在題目中（會標在標題上）")
                else:
                    errs.append(f"{tag}: 註釋「{t}」在原文與題目中都找不到")
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
    merged = json.loads(base.read_text(encoding="utf-8")) if base else {"authors": {}, "poems": []}
    batches = [(Path(f).name, json.loads(Path(f).read_text(encoding="utf-8"))) for f in files]

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
    for w in warns:
        print("提醒", w)
    for e in errs:
        print("錯誤", e)
    print("錯誤數", len(errs))
    if errs:
        sys.exit(1)
    if out:
        merged["authors"] = authors_all
        merged["poems"] += [p for _, d in batches for p in d["poems"]]
        out.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("已寫入", out)


if __name__ == "__main__":
    main()
