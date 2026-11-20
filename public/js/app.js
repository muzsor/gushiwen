'use strict';

/* ---------- 偏好設定（存在本機，讀寫失敗也不影響使用） ---------- */
const PREF_KEY = 'gushiwen-prefs';
const prefs = Object.assign({ fs: 20, layout: 'h', inlineTrans: true, script: 'hant', fabOpen: false }, load());
function load() { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } }
function save() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} }

/* ---------- 書籤與已讀紀錄（和偏好設定一樣只存在本機，不會在裝置之間同步；正體、簡體共用） ---------- */
const LIB_KEY = 'gushiwen-library';
const lib = loadLib();
function loadLib() {
  let v = {};
  try { v = JSON.parse(localStorage.getItem(LIB_KEY)) || {}; } catch {}
  return { bookmarks: new Set(v.bookmarks || []), read: new Set(v.read || []) };
}
function saveLib() {
  try { localStorage.setItem(LIB_KEY, JSON.stringify({ bookmarks: [...lib.bookmarks], read: [...lib.read] })); } catch {}
}
// 加入或移除一篇，回傳之後是否在清單中
function toggleIn(set, id) {
  if (set.has(id)) set.delete(id); else set.add(id);
  saveLib();
  return set.has(id);
}

/* ---------- 正體／簡體 ----------
   簡體版的作品資料由 scripts/make_hans.py 事先轉好（data/poems.hans.json，注音已轉成拼音）。
   介面文字用 js/hans-ui.js 的逐字對照表轉換；作品內容已是簡體，不再轉換，
   註釋與各區塊內文（#sheetNote、.section-body）中刻意保留正體的異文寫法也就不會被改掉。 */
let HANS = prefs.script === 'hans' && !!self.HANS_UI;   // 切換時不重新載入頁面，直接改這個值再重畫
const T = s => HANS ? [...String(s)].map(c => self.HANS_UI[c] || c).join('') : s;
const UI_SKIP = '.section-body, #sheetNote, .original';
const UI_ATTRS = ['placeholder', 'aria-label', 'data-tip', 'title'];
// 轉成簡體前的原文：切回正體時用來還原頁面上固定的介面文字（設定面板、使用說明、按鈕提示等）
const ORIG = new WeakMap();
function convertUI(root) {
  if (!HANS || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement && n.parentElement.closest(UI_SKIP)) continue;
    const v = T(n.nodeValue);
    if (v !== n.nodeValue) { ORIG.set(n, n.nodeValue); n.nodeValue = v; }
  }
  const els = root.querySelectorAll ? [root, ...root.querySelectorAll('[placeholder],[aria-label],[data-tip],[title]')] : [];
  for (const el of els) {
    if (!el.getAttribute) continue;
    for (const a of UI_ATTRS) {
      const v = el.getAttribute(a);
      if (v && T(v) !== v) {
        const o = ORIG.get(el) || {};
        o[a] = v; ORIG.set(el, o);
        el.setAttribute(a, T(v));
      }
    }
  }
}
function revertUI(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (ORIG.has(n)) { n.nodeValue = ORIG.get(n); ORIG.delete(n); }
  }
  for (const el of [root, ...root.querySelectorAll('*')]) {
    const o = ORIG.get(el);
    if (!o) continue;
    for (const a in o) el.setAttribute(a, o[a]);
    ORIG.delete(el);
  }
}

const $ = s => document.querySelector(s);
const app = $('#app');
let DATA = null;
let listState = { q: '', dynasty: '', form: '', author: '', mine: '', page: 1 };
const PAGE_SIZE = 10;   // 目錄每頁顯示幾篇

/* 排列順序：目錄依朝代先後排列；篩選選項也照這個順序，不在清單中的值排在最後 */
const DYNASTY_ORDER = ['先秦', '秦', '漢', '三國', '魏晉', '南北朝', '隋', '唐', '五代', '宋', '元', '明', '清', '臺灣'];
const FORM_ORDER = [
  '四言詩', '樂府詩', '五言古詩', '七言古詩', '雜言古詩', '五言絕句', '七言絕句', '五言律詩', '七言律詩',
  '詞', '散曲', '雜劇',
  '史傳', '論說', '奏議', '雜記', '辭賦', '序跋', '小說'
];
// 簡體模式下資料中的朝代、體裁是簡體，比對前把清單也轉成簡體
const rankOf = (list, v) => { const i = list.map(T).indexOf(v); return i < 0 ? 999 : i; };

const authorOf = p => DATA.authors[p.author];
const paras = v => (Array.isArray(v) ? v : [v]).map(t => `<p>${esc(t)}</p>`).join('');

/* ---------- 工具 ---------- */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* 浮動面板（設定、篩選選單、註釋與說明面板、遮罩）的開關：收起時先加 .leaving 播放收起動畫，播完才隱藏；
   收起途中又打開，就取消收起。isOpen 只把「顯示中且不是正在收起」當成打開 */
function showPanel(el) {
  clearTimeout(el.leaveTimer);
  el.classList.remove('leaving');
  el.hidden = false;
}
function hidePanel(el, ms = 200) {
  if (el.hidden || el.classList.contains('leaving')) return;
  el.classList.add('leaving');
  el.leaveTimer = setTimeout(() => { el.hidden = true; el.classList.remove('leaving'); }, ms);
}
const isOpen = el => !el.hidden && !el.classList.contains('leaving');

/* 提示訊息：從頂部彈開（.in），2.4 秒後縮回（.out），動畫播完才隱藏。連續觸發時重新播放彈開動畫 */
function toast(msg) {
  const t = $('#toast');
  clearTimeout(toast.timer); clearTimeout(toast.hideTimer);
  t.innerHTML = `<span class="toast-text">${esc(T(msg))}</span>`;
  t.hidden = false;
  t.classList.remove('in', 'out');
  void t.offsetWidth;   // 重新觸發動畫
  t.classList.add('in');
  document.body.classList.add('toasting');
  toast.timer = setTimeout(() => {
    t.classList.replace('in', 'out');
    document.body.classList.remove('toasting');
    toast.hideTimer = setTimeout(() => { t.hidden = true; t.classList.remove('out'); }, 340);
  }, 2400);
}

/* 在原文中標出有註釋的詞。segs 是原文各段（小序、各句或各段）。
   每則註釋在全文只標一次：有 in（前後文片段）時標在該片段中，否則標在第一次出現且不與其他註釋重疊的位置。
   先處理有 in 的註釋，再依詞長由長到短處理，避免短詞搶走長詞的位置。 */
function markText(segs, notes, only) {
  const taken = segs.map(s => new Array(s.length).fill(false));
  const hits = segs.map(() => []);
  const free = (si, at, end) => !taken[si].slice(at, end).some(Boolean);
  const claim = (si, at, end, i) => {
    for (let k = at; k < end; k++) taken[si][k] = true;
    hits[si].push({ at, end, i });
  };
  notes.map((n, i) => ({ ...n, i }))
    .filter(n => !only || only.has(n.i))
    .sort((a, b) => (b.in ? 1 : 0) - (a.in ? 1 : 0) || b.term.length - a.term.length)
    .forEach(n => {
      for (let si = 0; si < segs.length; si++) {
        const s = segs[si];
        if (n.in) {
          const ctx = s.indexOf(n.in);
          if (ctx < 0) continue;
          const at = ctx + n.in.indexOf(n.term);
          if (at >= ctx && free(si, at, at + n.term.length)) claim(si, at, at + n.term.length, n.i);
          return;
        }
        let from = 0, at;
        while ((at = s.indexOf(n.term, from)) !== -1) {
          if (free(si, at, at + n.term.length)) { claim(si, at, at + n.term.length, n.i); return; }
          from = at + 1;
        }
      }
    });
  const out = segs.map((s, si) => {
    let html = '', pos = 0;
    for (const h of hits[si].sort((a, b) => a.at - b.at)) {
      html += esc(s.slice(pos, h.at)) + `<span class="term" role="button" tabindex="0" data-note="${h.i}">${esc(s.slice(h.at, h.end))}</span>`;
      pos = h.end;
    }
    return html + esc(s.slice(pos));
  });
  out.hit = new Set(hits.flat().map(h => h.i));
  out.hits = hits;
  return out;
}

/* 取出一段原文中 [a, b) 範圍的 HTML，保留落在範圍內的註釋底線（跨範圍的註釋詞兩邊都標） */
function sliceMarked(s, hits, a, b) {
  let html = '', pos = a;
  for (const h of hits) {
    if (h.end <= a || h.at >= b) continue;
    const s0 = Math.max(h.at, a), e0 = Math.min(h.end, b);
    html += esc(s.slice(pos, s0)) + `<span class="term" role="button" tabindex="0" data-note="${h.i}">${esc(s.slice(s0, e0))}</span>`;
    pos = e0;
  }
  return html + esc(s.slice(pos, b));
}

/* 詞牌與題目、組詩與篇次之間有「・」時分成兩行，例如「定風波」／「莫聽穿林打葉聲」。
   notes／only：在題目上標出指定的註釋（原文中標不到、只出現在題目裡的詞） */
function titleHTML(title, notes = [], only = new Set()) {
  const i = title.indexOf('・');
  const parts = i < 0 ? [title] : [title.slice(0, i), title.slice(i + 1)];
  const [main, sub] = only.size ? markText(parts, notes, only) : parts.map(esc);
  return sub === undefined ? main : `${main}<small>${sub}</small>`;
}

/* ---------- 作品資料 ----------
   preface：["小序原文", "小序語譯"]（選填）
   body：段（散文）或章／片（詩詞）的陣列；每段是 [原文, 語譯] 的陣列，一對一句（或幾句）。 */
const blockText = block => block.map(pair => pair[0]).join('');
// 詩句原文中的換行字元（\n）用來分開律詩一聯的上下句等；搜尋與摘句時去掉
const fullText = p => ((p.preface ? p.preface[0] : '') + p.body.map(blockText).join('')).replace(/\n/g, '');

/* 目錄卡片上的開頭摘句：第一段的原文 */
const firstWords = p => blockText(p.body[0]).replace(/\n/g, '');

/* ---------- 目錄頁 ---------- */
/* 四種篩選：朝代、體裁、作者／出處、閱讀紀錄。value 是比對用的值，label 是顯示文字。
   閱讀紀錄的選項固定（書籤、已讀、未讀），一篇可以同時符合書籤與已讀，所以用 test 判斷，不用 value 比對 */
const FILTERS = [
  { key: 'dynasty', name: '朝代', value: p => authorOf(p).dynasty, order: DYNASTY_ORDER },
  { key: 'form', name: '體裁', value: p => p.form, order: FORM_ORDER },
  { key: 'author', name: '作者／出處', value: p => p.author, label: v => DATA.authors[v].name },
  { key: 'mine', name: '閱讀紀錄', all: '全部作品',
    options: [['bookmark', '書籤'], ['read', '已讀'], ['unread', '未讀']],
    test: (p, v) => v === 'bookmark' ? lib.bookmarks.has(p.id) : v === 'read' ? lib.read.has(p.id) : !lib.read.has(p.id) }
];
const fits = (f, p, v) => f.test ? f.test(p, v) : f.value(p) === v;

function matchQuery(p, q) {
  if (!q) return true;
  const a = authorOf(p);
  return [p.title, a.name, a.dynasty, p.form, p.source || '', fullText(p), ...p.tags]
    .some(s => s.includes(q));
}

/* 符合目前條件的作品；skip 用來計算某一種篩選的選項數量時，忽略它自己 */
function filtered(skip) {
  const q = listState.q.trim();
  return DATA.poems.filter(p => matchQuery(p, q) &&
    FILTERS.every(f => f.key === skip || !listState[f.key] || fits(f, p, listState[f.key])));
}

function filterOptions(f) {
  const pool = filtered(f.key);
  if (f.options) return f.options.map(([v, label]) => ({ v, label, n: pool.filter(p => f.test(p, v)).length }));
  const all = [...new Set(DATA.poems.map(f.value))];
  if (f.order) all.sort((a, b) => rankOf(f.order, a) - rankOf(f.order, b));
  return all.map(v => ({ v, label: f.label ? f.label(v) : v, n: pool.filter(p => f.value(p) === v).length }));
}

/* 書籤圖示：目錄卡片上的標記與頂部標題旁的小圖示共用 */
const BOOKMARK_PATH = 'M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v15.5l-6.5-4.4-6.5 4.4V5A1.5 1.5 0 0 1 7 3.5z';

/* 目錄頁分成兩部分：搜尋框只建立一次（重建會打斷注音、拼音等輸入法的選字），
   篩選、清單、分頁每次條件改變時重畫在 #listBody。 */
function renderList() {
  setTop('中國古詩文', false);
  setFab(null);
  if (!$('#q') || !$('#listBody')) {
    app.innerHTML = `
      <input class="search" id="q" type="search" placeholder="搜尋詩題、作者、詩句…" value="${esc(listState.q)}" autocomplete="off" enterkeyhint="search">
      <div id="listBody"></div>`;
    const input = $('#q');
    const update = () => {
      if (input.value === listState.q) return;
      listState.q = input.value;
      listState.page = 1;
      renderListBody();
    };
    input.addEventListener('input', e => { if (!e.isComposing) update(); });   // 選字中不更新
    input.addEventListener('compositionend', update);                         // 選完字再搜尋
    convertUI(app);
  }
  renderListBody();
}

function renderListBody() {
  const { poems, authors } = DATA;
  const shown = filtered();
  const active = FILTERS.some(f => listState[f.key]);
  const readCount = poems.filter(p => lib.read.has(p.id)).length;
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  listState.page = Math.min(Math.max(1, listState.page), pages);
  const pageItems = shown.slice((listState.page - 1) * PAGE_SIZE, listState.page * PAGE_SIZE);

  const pill = f => {
    const cur = listState[f.key];
    const curLabel = cur ? (filterOptions(f).find(o => o.v === cur) || {}).label : '';
    return `<button class="filter ${cur ? 'on' : ''}" data-key="${f.key}" aria-haspopup="listbox" aria-expanded="false" aria-label="依${f.name}篩選：${esc(cur ? curLabel : '全部')}" data-tip="依${f.name}篩選" data-tip-pos="below">
      <span>${esc(cur ? curLabel : f.name)}</span>
      <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>`;
  };

  const body = $('#listBody');
  body.innerHTML = `
    <div class="filters" role="group" aria-label="篩選">
      ${FILTERS.map(pill).join('')}
    </div>
    <div class="filter-status"><span>${active ? `符合 ${shown.length} 篇` : `共 ${poems.length} 篇`}</span><button class="filter-clear${active ? '' : ' is-off'}" id="clearFilters" type="button" ${active ? 'data-tip="取消所有篩選條件" data-tip-pos="above-left"' : 'tabindex="-1" aria-hidden="true"'}>清除篩選</button></div>
    ${shown.length ? `<ul class="list">${pageItems.map(p => {
      const a = authors[p.author];
      const marks = (lib.bookmarks.has(p.id) ? `<span class="mark-bookmark" role="img" aria-label="已加入書籤"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="${BOOKMARK_PATH}" fill="currentColor"/></svg></span>` : '') +
        (lib.read.has(p.id) ? '<span class="mark-read">已讀</span>' : '');
      return `<li><a class="card" href="#/poem/${p.id}">
        <div class="card-head"><span class="card-title">${esc(p.title)}</span>
        <span class="card-meta">${esc(a.dynasty)}・${esc(a.name)}・${esc(p.form)}</span>${marks ? `<span class="card-marks">${marks}</span>` : ''}</div>
        <div class="card-first">${esc(firstWords(p))}</div>
      </a></li>`;
    }).join('')}</ul>` : `<div class="empty">找不到符合的作品</div>`}
    ${pagerHTML(listState.page, pages)}
    <footer class="footnote">
      <p class="footnote-count">共 ${poems.length} 篇・已讀 ${readCount} 篇</p>
      <p><span>作品原文屬公有領域；</span><span>語譯、註釋、賞析、作者介紹、創作背景與版本說明</span><span>依古籍原典與歷代注本編撰，並逐篇核對出處。</span></p>
      <p><span>讀音與字義以教育部《重編國語辭典修訂本》為準，</span><span>出處標示</span><span>見<a href="licenses/moe-dict.html">授權與出處說明</a>。</span></p>
      <p><span>以上內容僅供學習參考，</span><span>雖力求正確，仍可能有疏漏，</span><span>也不代表教科書或考試的標準解釋。</span><span>引用時請查證原典與權威資料。</span></p>
      ${HANS ? '<p><span>簡體版由正體自動轉換，</span><span>讀音改以拼音標示；</span><span>註釋中說明版本差異的寫法保留正體。</span></p>' : ''}
    </footer>`;
  convertUI(body);

  body.querySelectorAll('.filter').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    if (menu.owner === b) closeMenu(); else openMenu(b);
  }));
  const clear = $('#clearFilters');
  if (active) clear.addEventListener('click', () => {
    FILTERS.forEach(f => (listState[f.key] = '')); listState.page = 1; renderList();
  });
  body.querySelectorAll('.pages [data-page]').forEach(b => b.addEventListener('click', () => {
    listState.page = Number(b.dataset.page);
    renderList();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
}

/* 分頁列：頁數少時全部列出；頁數多時只列第一頁、最後一頁與目前頁前後各一頁，中間以「…」表示 */
function pagerHTML(cur, total) {
  if (total <= 1) return '';
  const nums = [];
  for (let i = 1; i <= total; i++) {
    if (total <= 7 || i === 1 || i === total || Math.abs(i - cur) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  const arrow = (to, label, d) => `<button class="page-btn page-arrow" ${to < 1 || to > total ? 'disabled' : `data-page="${to}"`} aria-label="${label}" data-tip="${label}">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  return `<nav class="pages" aria-label="分頁">
    ${arrow(cur - 1, '上一頁', 'M15 5l-7 7 7 7')}
    ${nums.map(n => n === '…' ? '<span class="page-gap">…</span>'
      : `<button class="page-btn ${n === cur ? 'on' : ''}" data-page="${n}" ${n === cur ? 'aria-current="page"' : ''} aria-label="第 ${n} 頁">${n}</button>`).join('')}
    ${arrow(cur + 1, '下一頁', 'M9 5l7 7-7 7')}
  </nav>`;
}

/* ---------- 篩選選單（玻璃浮動選單，取代原生下拉框） ---------- */
const menu = $('#filterMenu');
const CHECK = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function openMenu(btn) {
  closeMenu();
  const f = FILTERS.find(x => x.key === btn.dataset.key);
  const cur = listState[f.key];
  const item = (v, label, n) => {
    const on = v === cur, off = n === 0 && !on;
    return `<button class="menu-item ${on ? 'on' : ''}" role="option" aria-selected="${on}" data-v="${esc(v)}" ${off ? 'disabled' : ''}>
      <span class="menu-check">${on ? CHECK : ''}</span><span class="menu-label">${esc(label)}</span>${n == null ? '' : `<span class="menu-count">${n}</span>`}
    </button>`;
  };
  menu.innerHTML = item('', f.all || `全部${f.name}`, null) +
    '<div class="menu-sep" role="separator"></div>' +
    filterOptions(f).map(o => item(o.v, o.label, o.n)).join('');
  menu.setAttribute('aria-label', f.name);
  convertUI(menu);
  showPanel(menu);
  menu.owner = btn;
  btn.setAttribute('aria-expanded', 'true');

  // 放在按鈕正下方，左右不超出畫面
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth, gap = 16;
  menu.style.left = Math.max(gap, Math.min(r.left, innerWidth - w - gap)) + 'px';
  menu.style.top = (r.bottom + 8) + 'px';
  menu.style.transformOrigin = `${r.left + r.width / 2 - parseFloat(menu.style.left)}px top`;

  menu.querySelectorAll('.menu-item').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    listState[f.key] = b.dataset.v;
    listState.page = 1;
    closeMenu();
    renderList();
    const again = app.querySelector(`.filter[data-key="${f.key}"]`);
    if (again) again.focus({ preventScroll: true });
  }));
  (menu.querySelector('.menu-item.on') || menu.querySelector('.menu-item')).focus({ preventScroll: true });
}

function closeMenu() {
  if (!isOpen(menu)) return;   // 捲動、換頁時都會呼叫，選單沒開就不做事
  if (menu.owner) menu.owner.setAttribute('aria-expanded', 'false');
  hidePanel(menu, 160);
  menu.owner = null;
}

menu.addEventListener('keydown', e => {
  const items = [...menu.querySelectorAll('.menu-item:not([disabled])')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[n].focus();
  } else if (e.key === 'Escape' || e.key === 'Tab') {
    const owner = menu.owner;
    closeMenu();
    if (owner && e.key === 'Escape') owner.focus();
  }
});
document.addEventListener('click', e => { if (isOpen(menu) && !menu.contains(e.target)) closeMenu(); });
addEventListener('resize', closeMenu);
addEventListener('scroll', closeMenu, { passive: true });

/* ---------- 閱讀頁 ---------- */
function renderPoem(id) {
  const { poems, authors } = DATA;
  const idx = poems.findIndex(p => p.id === id);
  if (idx < 0) { location.hash = '#/'; return; }
  const p = poems[idx], a = authors[p.author];
  const prev = poems[idx - 1], next = poems[idx + 1];
  setTop(p.title, true);

  const section = (title, body, open = false) =>
    `<details class="section" ${open ? 'open' : ''}><summary>${title}</summary><div class="section-body">${body}</div></details>`;

  // 原文：以段（散文）或章／片（詩詞）為單位標註釋，再逐句切開，跨句的註釋詞也標得到
  const segs = [...(p.preface ? [p.preface[0]] : []), ...p.body.map(blockText)];
  const marked = markText(segs, p.notes);
  const titleOnly = new Set(p.notes.map((_, i) => i).filter(i => !marked.hit.has(i)));
  const o = p.preface ? 1 : 0;
  const prose = p.type === 'prose';
  // 每句原文下（直排時在左側）附語譯，右下角閱讀工具裡的「譯」可開關
  const unit = (src, tr, cls = '') => `<div class="unit${cls}"><p class="unit-src">${src}</p><p class="unit-tr">${esc(tr)}</p></div>`;
  const original = (p.preface ? unit(marked[0], p.preface[1], ' is-preface') : '') + p.body.map((block, k) => {
    let pos = 0;
    return `<div class="block">${block.map(([src, tr]) => {
      const a = pos; pos += src.length;
      return unit(sliceMarked(segs[k + o], marked.hits[k + o], a, pos), tr);
    }).join('')}</div>`;
  }).join('');
  const isSource = a.kind === 'source';

  app.innerHTML = `
    <div class="poem-head">
      <h2 class="poem-title">${titleHTML(p.title, p.notes, titleOnly)}</h2>
      <div class="poem-by">${esc(a.dynasty)}・${esc(a.name)}　<span class="form">${esc(p.form)}</span></div>
      ${p.source ? `<div class="poem-source">選自${esc(p.source)}</div>` : ''}
      <div class="tags">${p.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    </div>
    <div class="original ${prose ? 'prose' : ''} inline ${prefs.inlineTrans ? '' : 'no-trans'} ${prefs.layout === 'v' ? 'vertical' : ''}" lang="${HANS ? 'zh-Hans' : 'zh-Hant'}">
      ${original}
    </div>
    <div class="hint"><span>點一下有底線的字詞，查看註釋；</span><span>右下角的按鈕可加入書籤、標為已讀、開關語譯</span></div>
    ${section('賞析', paras(p.analysis))}
    ${section(isSource ? '出處' : '作者', `<p><strong>${esc(a.name)}</strong><span class="author-years">${esc(a.dynasty)}・${esc(a.years)}</span></p>${paras(a.intro)}`)}
    ${section('創作背景', paras(p.background))}
    ${p.edition?.length ? section('版本', paras(p.edition)) : ''}
    ${p.references?.length ? section('參考資料', `<ul class="refs">${p.references.map(r => `<li>${esc(r)}</li>`).join('')}</ul>`) : ''}
    <nav class="pager">
      ${prev ? `<a href="#/poem/${prev.id}">上一篇<span>${esc(prev.title)}</span></a>` : '<div class="spacer"></div>'}
      ${next ? `<a class="next" href="#/poem/${next.id}">下一篇<span>${esc(next.title)}</span></a>` : '<div class="spacer"></div>'}
    </nav>`;

  app.querySelectorAll('.term').forEach(b => {
    const open = () => {
      app.querySelectorAll('.term.active').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      openSheet(p.notes[b.dataset.note]);
    };
    b.addEventListener('click', open);
    b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  convertUI(app);
  setFab(p.id);
  window.scrollTo(0, 0);
}

/* ---------- 閱讀工具（閱讀頁右下角）：主按鈕往上展開書籤、已讀、語譯 ----------
   展開或收起會記住（prefs.fabOpen）：常開關語譯的人展開後就保持展開，一按就能切換。
   所以點原文或其他地方不會收起，只有再點主按鈕才收起。
   這篇已加入書籤或已讀時，頂部標題膠囊的題目後面顯示小圖示（不放在按鈕上，以免看起來像通知） */
const fab = $('#fab'), fabMain = $('#fabMain');
const bookmarkBtn = $('#bookmarkBtn'), readBtn = $('#readBtn'), transBtn = $('#transBtn');
let currentId = null;   // 目前閱讀頁的作品；在目錄頁時是 null，按鈕隱藏

function setPressed(b, on, label) {
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', T(label));
  b.dataset.tip = T(label);
}
function updateFab() {
  if (!currentId) return;
  const bm = lib.bookmarks.has(currentId), rd = lib.read.has(currentId), open = !!prefs.fabOpen;
  setPressed(bookmarkBtn, bm, bm ? '移除書籤' : '加入書籤');
  setPressed(readBtn, rd, rd ? '已讀，點一下改回未讀' : '標為已讀');
  setPressed(transBtn, prefs.inlineTrans, prefs.inlineTrans ? '隱藏語譯' : '顯示語譯');
  fab.classList.toggle('open', open);
  fabMain.setAttribute('aria-expanded', String(open));
  setTopMarks(bm, rd);
  const state = [bm && '已加入書籤', rd && '已讀'].filter(Boolean).join('、');
  fabMain.setAttribute('aria-label', T(`${open ? '收起' : '展開'}閱讀工具：書籤、已讀、語譯${state ? `（這篇${state}）` : ''}`));
  fabMain.dataset.tip = T(open ? '收起' : '書籤、已讀、語譯');
}
const MARK_ICON = {
  bookmark: `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="${BOOKMARK_PATH}" fill="currentColor"/></svg>`,
  read: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};
function setTopMarks(bm, rd) {
  const box = $('#topMarks');
  box.hidden = !(bm || rd);
  box.innerHTML = (bm ? MARK_ICON.bookmark : '') + (rd ? MARK_ICON.read : '');
  const label = [bm && '已加入書籤', rd && '已讀'].filter(Boolean).join('、');
  if (label) box.setAttribute('aria-label', T(label)); else box.removeAttribute('aria-label');
  box.setAttribute('role', 'img');
}
function setFab(id) {
  currentId = id;
  fab.hidden = !id;
  if (!id) setTopMarks(false, false);
  app.classList.toggle('has-fab', !!id);   // 底部多留空間，最下方的內容才不會被按鈕蓋住
  updateFab();
}
fabMain.addEventListener('click', () => {
  prefs.fabOpen = !prefs.fabOpen;
  save();
  // 收起時先播放縮回的動畫（CSS 的 .closing），播完才把三個按鈕隱藏
  clearTimeout(fab.closeTimer); clearTimeout(fab.toggleTimer);
  fab.classList.toggle('closing', !prefs.fabOpen);
  if (!prefs.fabOpen) fab.closeTimer = setTimeout(() => fab.classList.remove('closing'), 300);
  // 只有點主按鈕時才播放展開動畫與圖示旋轉（.toggling），打開作品時不重播
  fab.classList.remove('toggling'); void fab.offsetWidth; fab.classList.add('toggling');
  fab.toggleTimer = setTimeout(() => fab.classList.remove('toggling'), 450);
  updateFab();
});
bookmarkBtn.addEventListener('click', () => {
  if (!currentId) return;
  const on = toggleIn(lib.bookmarks, currentId);
  updateFab();
  toast(on ? '已加入書籤' : '已移除書籤');
});
readBtn.addEventListener('click', () => {
  if (!currentId) return;
  const on = toggleIn(lib.read, currentId);
  updateFab();
  toast(on ? '已標為已讀' : '已改回未讀');
});

/* ---------- 確認視窗：玻璃風格，取代瀏覽器內建的 confirm()。回傳 Promise，按「確定」為 true ----------
   取消、點視窗外、按 Esc 都算取消；預設焦點在「取消」，避免誤按清除 */
const dialog = $('#confirmDialog'), dialogBackdrop = $('#dialogBackdrop');
let dialogDone = null;
function askConfirm(title, msg, okLabel) {
  if (dialogDone) dialogDone(false);
  return new Promise(resolve => {
    $('#dialogTitle').textContent = T(title);
    $('#dialogMsg').textContent = T(msg);
    $('#dialogOk').textContent = T(okLabel);
    clearTimeout(askConfirm.timer);
    dialog.classList.remove('out'); dialogBackdrop.classList.remove('out');
    dialog.hidden = dialogBackdrop.hidden = false;
    $('#dialogCancel').focus({ preventScroll: true });
    dialogDone = ok => {
      dialogDone = null;
      dialog.classList.add('out'); dialogBackdrop.classList.add('out');
      askConfirm.timer = setTimeout(() => {
        dialog.hidden = dialogBackdrop.hidden = true;
        dialog.classList.remove('out'); dialogBackdrop.classList.remove('out');
      }, 180);
      resolve(ok);
    };
  });
}
$('#dialogOk').addEventListener('click', () => dialogDone && dialogDone(true));
$('#dialogCancel').addEventListener('click', () => dialogDone && dialogDone(false));
dialogBackdrop.addEventListener('click', () => dialogDone && dialogDone(false));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && dialogDone) dialogDone(false); });
// 視窗打開時，Tab 只在「取消」「清除」之間切換，不會跑到後面的頁面
dialog.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  ($('#dialogCancel') === document.activeElement ? $('#dialogOk') : $('#dialogCancel')).focus();
});

/* 清除所有書籤與已讀紀錄（設定面板），先確認一次 */
$('#clearLibBtn').addEventListener('click', async e => {
  e.stopPropagation();
  // 只計算目前收錄的作品（作品改代號或刪除後，舊紀錄仍留在清單中，一併清除）
  const count = set => DATA ? DATA.poems.filter(p => set.has(p.id)).length : set.size;
  const nb = count(lib.bookmarks), nr = count(lib.read);
  if (!lib.bookmarks.size && !lib.read.size) { toast('目前沒有書籤或已讀紀錄'); return; }
  hidePanel($('#settings'), 160);
  if (!await askConfirm('清除閱讀紀錄', `要清除 ${nb} 個書籤和 ${nr} 篇已讀紀錄嗎？\n清除後無法復原。`, '清除')) return;
  lib.bookmarks.clear(); lib.read.clear(); saveLib();
  if (currentId) updateFab();
  else { listState.mine = ''; listState.page = 1; renderList(); }
  toast('已清除書籤與已讀紀錄');
});

/* 語譯開關 */
transBtn.addEventListener('click', () => {
  const o = app.querySelector('.original.inline');
  if (!o) return;
  // 切換前記下畫面頂端附近的那一句，切換後讓它留在原位，閱讀位置才不會跳動
  const anchor = [...o.querySelectorAll('.unit')].find(u => u.getBoundingClientRect().bottom > 80) || o;
  const before = anchor.getBoundingClientRect().top;
  prefs.inlineTrans = !prefs.inlineTrans;
  save();
  o.classList.toggle('no-trans', !prefs.inlineTrans);
  updateFab();
  window.scrollBy(0, anchor.getBoundingClientRect().top - before);
});

/* ---------- 使用說明 ---------- */
function openHelp() {
  hidePanel($('#settings'), 160);
  showPanel($('#helpSheet')); showPanel($('#sheetBackdrop'));
  $('#helpClose').focus();
}
function closeHelp() {
  hidePanel($('#helpSheet'));
  if (!isOpen($('#sheet'))) hidePanel($('#sheetBackdrop'));
}
$('#helpBtn').addEventListener('click', e => { e.stopPropagation(); openHelp(); });
$('#helpClose').addEventListener('click', closeHelp);

/* ---------- 註釋面板 ---------- */
function openSheet(n) {
  $('#sheetTerm').textContent = n.term;
  // 分項的註釋（①②…）每項各占一行：圓圈數字前面是「。；：」（後面可以接引號、括號）時才換行，
  // 「語譯從①」這類句中引用不換行
  $('#sheetNote').innerHTML = esc(n.note).replace(/([。；：][」』）〉》]*)\s*(?=[①-⑩])/g, '$1<br>');
  showPanel($('#sheet')); showPanel($('#sheetBackdrop'));
}
function closeSheet() {
  hidePanel($('#sheet'));
  if (!isOpen($('#helpSheet'))) hidePanel($('#sheetBackdrop'));
  app.querySelectorAll('.term.active').forEach(x => x.classList.remove('active'));
}
$('#sheetBackdrop').addEventListener('click', () => { closeSheet(); closeHelp(); });
$('#sheet').addEventListener('click', closeSheet);
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSheet(); closeHelp(); } });

/* ---------- 頂部列與設定 ---------- */
function setTop(title, showBack) {
  $('#topTitle').textContent = T(title);
  $('#backBtn').hidden = !showBack;
  document.title = T(showBack ? `${title}｜中國古詩文` : '中國古詩文');
}
$('#backBtn').addEventListener('click', () => { markNav('pop'); location.hash = '#/'; });
$('#settingsBtn').addEventListener('click', e => {
  e.stopPropagation();
  const s = $('#settings');
  if (isOpen(s)) hidePanel(s, 160); else showPanel(s);
});
// 點設定面板以外的地方就關閉
document.addEventListener('click', e => {
  const s = $('#settings');
  if (isOpen(s) && !s.contains(e.target)) hidePanel(s, 160);
});

/* 字級：16–32px 的拖拉條，只改原文（題目、說明文字的大小固定）。拖的時候即時套用 */
const fontRange = $('#fontRange');
const FS_MIN = Number(fontRange.min), FS_MAX = Number(fontRange.max);
function applyFontLevel() {
  fontRange.value = prefs.fs;
  fontRange.style.setProperty('--p', `${(prefs.fs - FS_MIN) / (FS_MAX - FS_MIN) * 100}%`);
  fontRange.setAttribute('aria-valuetext', T(`${prefs.fs} 像素`));
}

function applyPrefs() {
  document.documentElement.style.setProperty('--fs', prefs.fs + 'px');
  applyFontLevel();
  document.querySelectorAll('#layoutSeg button').forEach(b => b.classList.toggle('on', b.dataset.layout === prefs.layout));
  document.querySelectorAll('#scriptSeg button').forEach(b => b.classList.toggle('on', b.dataset.script === (HANS ? 'hans' : 'hant')));
}
/* 切換正體／簡體：不重新載入頁面（重新載入會閃一下）。先載入另一份作品資料，成功後再換掉介面文字、
   重畫目前的頁面並留在原來的捲動位置；目錄的篩選條件也換成另一種文字的寫法 */
let switching = false;
document.querySelectorAll('[data-script]').forEach(b => b.addEventListener('click', async () => {
  const hans = b.dataset.script === 'hans';
  if (hans === HANS || switching || (hans && !self.HANS_UI)) return;
  switching = true;
  let next;
  try {
    next = await loadData(hans);
  } catch {
    switching = false;
    toast(hans ? '簡體版資料載入失敗，第一次切換到簡體時請先連上網路' : '資料載入失敗，請先連上網路');
    return;
  }
  // 篩選中的朝代、體裁是文字（例如「七言律詩」「七言律诗」），換成新資料中同一篇作品的寫法
  const FIELD = { dynasty: (d, p) => d.authors[p.author].dynasty, form: (d, p) => p.form };
  for (const [k, get] of Object.entries(FIELD)) {
    if (!listState[k]) continue;
    const old = DATA && DATA.poems.find(p => get(DATA, p) === listState[k]);
    const np = old && next.poems.find(p => p.id === old.id);
    listState[k] = np ? get(next, np) : '';
  }
  prefs.script = hans ? 'hans' : 'hant'; save();
  keepReadingPosition(() => {
    revertUI(document.body);
    HANS = hans; DATA = next;
    document.documentElement.lang = HANS ? 'zh-Hans' : 'zh-Hant';
    convertUI(document.body);
    applyPrefs();
    route();
  });
  switching = false;
}));

/* 重畫目前頁面（切換正簡、橫直排）後留在原來的閱讀位置。
   原文段落用 content-visibility 延後排版（畫面外的段落先用估計高度），只記捲動距離會跳到別處，
   所以改記畫面頂端附近的那一句，重畫後把同一句捲回原來的位置；目錄頁沒有原文，仍記捲動距離 */
function keepReadingPosition(update) {
  const units = [...app.querySelectorAll('.original .unit')];
  const i = units.findIndex(u => u.getBoundingClientRect().bottom > 80);
  if (i < 0) { const y = scrollY; update(); scrollTo(0, y); return; }
  const before = units[i].getBoundingClientRect().top;
  update();
  const u = app.querySelectorAll('.original .unit')[i];
  if (u) scrollBy(0, u.getBoundingClientRect().top - before);
}
fontRange.addEventListener('input', () => {
  prefs.fs = Math.min(FS_MAX, Math.max(FS_MIN, Number(fontRange.value)));
  applyPrefs();
});
fontRange.addEventListener('change', save);   // 放開時才寫入本機
document.querySelectorAll('[data-layout]').forEach(b => b.addEventListener('click', () => {
  prefs.layout = b.dataset.layout; save(); applyPrefs();
  if (location.hash.startsWith('#/poem/')) keepReadingPosition(route);
}));

/* ---------- 路由 ---------- */
let listScrollY = 0;   // 從目錄點進作品時記下目錄的捲動位置，返回時回到原處
function route() {
  closeSheet();
  closeMenu();
  const m = location.hash.match(/^#\/poem\/([\w-]+)/);
  const fromPoem = !!currentId;
  if (m) {
    if (!fromPoem) listScrollY = scrollY;
    renderPoem(m[1]);
  } else {
    renderList();
    if (fromPoem) scrollTo(0, listScrollY);
  }
}

/* ---------- 換頁動畫 ----------
   只有在 App 裡點作品卡片、左上角返回、上一篇／下一篇時播放（瀏覽器的上一頁手勢自己就有動畫，不重複播）。
   用瀏覽器內建的 View Transitions：只拍下目前看得到的畫面來做動畫，作品再長也不增加負擔；
   不支援的瀏覽器（例如 iOS 18 以前）直接換頁。方向：push 從右邊滑入，pop 往右滑出 */
let pendingNav = null;
function markNav(dir) { pendingNav = { dir, at: performance.now() }; }
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a[href^="#/"]');
  if (!a || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const toPoem = a.getAttribute('href').startsWith('#/poem/');
  const inPager = !!a.closest('.pager');
  markNav(inPager ? (a.classList.contains('next') ? 'push' : 'pop') : (toPoem ? 'push' : 'pop'));
});
window.addEventListener('hashchange', () => {
  const nav = pendingNav && performance.now() - pendingNav.at < 1000 ? pendingNav.dir : null;
  pendingNav = null;
  // 頁面不在前景時瀏覽器不會播放轉場，換頁也可能被延後，直接換頁
  if (!nav || !document.startViewTransition || document.hidden) { route(); return; }
  document.documentElement.dataset.nav = nav;
  document.startViewTransition(route).finished.finally(() => delete document.documentElement.dataset.nav);
});

/* ---------- 轉向補救 ----------
   狀態列用 default 樣式時，iPhone 橫向會隱藏狀態列；轉回直向後 WebKit 的觸控座標可能停在橫向的位置，
   按鈕要點偏一點才按得到。等畫面尺寸穩定後，把 viewport-fit 暫時切成 auto 再切回 cover，強迫重新計算版面。 */
function installRotationFix() {
  const meta = document.querySelector('meta[name="viewport"]');
  if (!meta || !meta.content.includes('viewport-fit=cover')) return;
  const original = meta.content;
  // 切回 cover 用 setTimeout 而不是 requestAnimationFrame：頁面不在前景時 rAF 會暫停，meta 就會卡在 auto
  const kick = () => {
    const y = window.scrollY;
    meta.content = original.replace('viewport-fit=cover', 'viewport-fit=auto');
    setTimeout(() => {
      meta.content = original;
      const root = document.documentElement;
      root.style.height = window.innerHeight + 'px';
      void root.offsetHeight;
      root.style.height = '';
      window.scrollTo(0, y);
    }, 50);
  };
  let poll = null;
  const onRotate = () => {
    clearInterval(poll);
    let last = null, stable = 0, ticks = 0;
    poll = setInterval(() => {
      const now = `${window.innerWidth}x${window.innerHeight}`;
      stable = now === last ? stable + 1 : 0;
      last = now;
      ticks++;
      if (stable >= 2 || ticks > 20) {
        clearInterval(poll);
        poll = null;
        kick();
        setTimeout(kick, 400);
      }
    }, 100);
  };
  window.addEventListener('orientationchange', onRotate);
  if (screen.orientation) screen.orientation.addEventListener('change', onRotate);
}

/* 載入正體或簡體的作品資料，依朝代先後排列（同朝代維持資料檔中的順序），目錄與上下篇都照這個順序 */
async function loadData(hans) {
  const res = await fetch(hans ? 'data/poems.hans.json' : 'data/poems.json');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  const was = HANS;
  HANS = hans;   // rankOf 要用資料本身的文字比對朝代名稱
  try {
    d.poems = d.poems
      .map((p, i) => ({ p, i, r: rankOf(DYNASTY_ORDER, d.authors[p.author].dynasty) }))
      .sort((x, y) => x.r - y.r || x.i - y.i)
      .map(x => x.p);
  } finally {
    HANS = was;
  }
  return d;
}

/* ---------- 啟動 ---------- */
(async function start() {
  if (HANS) {
    document.documentElement.lang = 'zh-Hans';
    convertUI(document.body);
    document.title = T(document.title);
  }
  applyPrefs();
  installRotationFix();
  try {
    DATA = await loadData(HANS);
    route();
  } catch (e) {
    app.innerHTML = `<div class="empty">${T(HANS ? '簡體版資料載入失敗。第一次切換到簡體時請先連上網路。' : '資料載入失敗。第一次使用請先連上網路開啟一次。')}</div>`;
  }

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      // 第一次安裝完成時提示可以離線使用
      if (!navigator.serviceWorker.controller) {
        const sw = reg.installing || reg.waiting;
        if (sw) sw.addEventListener('statechange', () => {
          if (sw.state === 'activated') toast('已下載完成，之後不連網也能閱讀');
        });
      }
      // 有新版本時提示
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (nw && navigator.serviceWorker.controller) nw.addEventListener('statechange', () => {
          if (nw.state === 'activated') toast('內容已更新，重新開啟即可看到新版');
        });
      });
    } catch {}
  }
})();
