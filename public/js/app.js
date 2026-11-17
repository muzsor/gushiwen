'use strict';

/* ---------- 偏好設定（存在本機，讀寫失敗也不影響使用） ---------- */
const PREF_KEY = 'gushiwen-prefs';
const prefs = Object.assign({ fs: 20, layout: 'h', inlineTrans: true }, load());
function load() { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } }
function save() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} }

const $ = s => document.querySelector(s);
const app = $('#app');
let DATA = null;
let listState = { q: '', dynasty: '', form: '', author: '', page: 1 };
const PAGE_SIZE = 10;   // 目錄每頁顯示幾篇

/* 排列順序：目錄依朝代先後排列；篩選選項也照這個順序，不在清單中的值排在最後 */
const DYNASTY_ORDER = ['先秦', '秦', '漢', '三國', '魏晉', '南北朝', '隋', '唐', '五代', '宋', '元', '明', '清', '臺灣'];
const FORM_ORDER = [
  '四言詩', '樂府詩', '五言古詩', '七言古詩', '雜言古詩', '五言絕句', '七言絕句', '五言律詩', '七言律詩',
  '詞', '散曲',
  '史傳', '論說', '奏議', '雜記', '辭賦', '序跋', '小說'
];
const rankOf = (list, v) => { const i = list.indexOf(v); return i < 0 ? 999 : i; };

const authorOf = p => DATA.authors[p.author];
const paras = v => (Array.isArray(v) ? v : [v]).map(t => `<p>${esc(t)}</p>`).join('');

/* ---------- 工具 ---------- */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2400);
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
/* 三種篩選：朝代、體裁、作者／出處。value 是比對用的值，label 是顯示文字 */
const FILTERS = [
  { key: 'dynasty', name: '朝代', value: p => authorOf(p).dynasty, order: DYNASTY_ORDER },
  { key: 'form', name: '體裁', value: p => p.form, order: FORM_ORDER },
  { key: 'author', name: '作者／出處', value: p => p.author, label: v => DATA.authors[v].name }
];

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
    FILTERS.every(f => f.key === skip || !listState[f.key] || f.value(p) === listState[f.key]));
}

function filterOptions(f) {
  const all = [...new Set(DATA.poems.map(f.value))];
  if (f.order) all.sort((a, b) => rankOf(f.order, a) - rankOf(f.order, b));
  const pool = filtered(f.key);
  return all.map(v => ({ v, label: f.label ? f.label(v) : v, n: pool.filter(p => f.value(p) === v).length }));
}

/* 目錄頁分成兩部分：搜尋框只建立一次（重建會打斷注音、拼音等輸入法的選字），
   篩選、清單、分頁每次條件改變時重畫在 #listBody。 */
function renderList() {
  setTop('中國古詩文', false);
  setTransBtn(false);
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
  }
  renderListBody();
}

function renderListBody() {
  const { poems, authors } = DATA;
  const shown = filtered();
  const active = FILTERS.some(f => listState[f.key]);
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
    ${active ? `<div class="filter-status">符合 ${shown.length} 篇<button class="filter-clear" id="clearFilters" data-tip="取消所有篩選條件" data-tip-pos="above-left">清除篩選</button></div>` : ''}
    ${shown.length ? `<ul class="list">${pageItems.map(p => {
      const a = authors[p.author];
      return `<li><a class="card" href="#/poem/${p.id}">
        <div class="card-head"><span class="card-title">${esc(p.title)}</span>
        <span class="card-meta">${esc(a.dynasty)}・${esc(a.name)}・${esc(p.form)}</span></div>
        <div class="card-first">${esc(firstWords(p))}</div>
      </a></li>`;
    }).join('')}</ul>` : `<div class="empty">找不到符合的作品</div>`}
    ${pagerHTML(listState.page, pages)}
    <footer class="footnote">
      <p class="footnote-count">共 ${poems.length} 篇</p>
      <p><span>作品原文屬公有領域；</span><span>語譯、註釋、賞析、作者介紹與創作背景均為自行編撰。</span></p>
      <p><span>以上內容僅供學習參考，</span><span>雖力求正確，仍可能有疏漏，</span><span>也不代表教科書或考試的標準解釋。</span><span>引用時請查證原典與權威資料。</span></p>
    </footer>`;

  body.querySelectorAll('.filter').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    if (menu.owner === b) closeMenu(); else openMenu(b);
  }));
  const clear = $('#clearFilters');
  if (clear) clear.addEventListener('click', () => {
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
  menu.innerHTML = item('', `全部${f.name}`, null) +
    '<div class="menu-sep" role="separator"></div>' +
    filterOptions(f).map(o => item(o.v, o.label, o.n)).join('');
  menu.setAttribute('aria-label', f.name);
  menu.hidden = false;
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
  if (menu.owner) menu.owner.setAttribute('aria-expanded', 'false');
  menu.hidden = true;
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
document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
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
  // 每句原文下（直排時在左側）附語譯，右下角「譯」按鈕可開關
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
    <div class="original ${prose ? 'prose' : ''} inline ${prefs.inlineTrans ? '' : 'no-trans'} ${prefs.layout === 'v' ? 'vertical' : ''}" lang="zh-Hant">
      ${original}
    </div>
    <div class="hint">點一下有底線的字詞，查看註釋；右下角「譯」可開關語譯</div>
    ${section('賞析', paras(p.analysis))}
    ${section(isSource ? '出處' : '作者', `<p><strong>${esc(a.name)}</strong><span class="author-years">${esc(a.dynasty)}・${esc(a.years)}</span></p>${paras(a.intro)}`)}
    ${section('創作背景', paras(p.background))}
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
  setTransBtn(true);
  window.scrollTo(0, 0);
}

/* ---------- 語譯開關（閱讀頁右下角的浮動按鈕） ---------- */
const transBtn = $('#transBtn');
function setTransBtn(show) {
  transBtn.hidden = !show;
  app.classList.toggle('has-fab', show);   // 底部多留空間，最下方的內容才不會被按鈕蓋住
  transBtn.setAttribute('aria-pressed', String(prefs.inlineTrans));
  transBtn.setAttribute('aria-label', prefs.inlineTrans ? '隱藏語譯' : '顯示語譯');
  transBtn.dataset.tip = prefs.inlineTrans ? '隱藏語譯' : '顯示語譯';
}
transBtn.addEventListener('click', () => {
  const o = app.querySelector('.original.inline');
  if (!o) return;
  // 切換前記下畫面頂端附近的那一句，切換後讓它留在原位，閱讀位置才不會跳動
  const anchor = [...o.querySelectorAll('.unit')].find(u => u.getBoundingClientRect().bottom > 80) || o;
  const before = anchor.getBoundingClientRect().top;
  prefs.inlineTrans = !prefs.inlineTrans;
  save();
  o.classList.toggle('no-trans', !prefs.inlineTrans);
  setTransBtn(true);
  window.scrollBy(0, anchor.getBoundingClientRect().top - before);
});

/* ---------- 使用說明 ---------- */
function openHelp() {
  $('#settings').hidden = true;
  $('#helpSheet').hidden = false; $('#sheetBackdrop').hidden = false;
  $('#helpClose').focus();
}
function closeHelp() { $('#helpSheet').hidden = true; if ($('#sheet').hidden) $('#sheetBackdrop').hidden = true; }
$('#helpBtn').addEventListener('click', e => { e.stopPropagation(); openHelp(); });
$('#helpClose').addEventListener('click', closeHelp);

/* ---------- 註釋面板 ---------- */
function openSheet(n) {
  $('#sheetTerm').textContent = n.term;
  $('#sheetNote').textContent = n.note;
  $('#sheet').hidden = false; $('#sheetBackdrop').hidden = false;
}
function closeSheet() {
  $('#sheet').hidden = true; $('#sheetBackdrop').hidden = true;
  app.querySelectorAll('.term.active').forEach(x => x.classList.remove('active'));
}
$('#sheetBackdrop').addEventListener('click', () => { closeSheet(); closeHelp(); });
$('#sheet').addEventListener('click', closeSheet);
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSheet(); closeHelp(); } });

/* ---------- 頂部列與設定 ---------- */
function setTop(title, showBack) {
  $('#topTitle').textContent = title;
  $('#backBtn').hidden = !showBack;
  document.title = showBack ? `${title}｜中國古詩文` : '中國古詩文';
}
$('#backBtn').addEventListener('click', () => { location.hash = '#/'; });
$('#settingsBtn').addEventListener('click', e => { e.stopPropagation(); $('#settings').hidden = !$('#settings').hidden; });
// 點設定面板以外的地方就關閉
document.addEventListener('click', e => {
  const s = $('#settings');
  if (!s.hidden && !s.contains(e.target)) s.hidden = true;
});

/* 字級：16–32px，每級 2px，共 9 級。中間的小圓點顯示目前是第幾級，到頭時按鈕變淡、不能再按 */
const FS_MIN = 16, FS_MAX = 32, FS_STEP = 2;
function applyFontLevel() {
  const levels = (FS_MAX - FS_MIN) / FS_STEP + 1, cur = (prefs.fs - FS_MIN) / FS_STEP + 1;
  const box = $('#fontLevel');
  box.replaceChildren(...Array.from({ length: levels }, (_, i) => {
    const dot = document.createElement('i');
    if (i < cur) dot.className = 'on';
    return dot;
  }));
  box.setAttribute('aria-label', `字級：第 ${cur} 級，共 ${levels} 級`);
  box.dataset.tip = `第 ${cur} 級，共 ${levels} 級`;
  for (const b of document.querySelectorAll('[data-font]')) {
    const up = b.dataset.font === '1';
    const atEnd = up ? prefs.fs >= FS_MAX : prefs.fs <= FS_MIN;
    b.disabled = atEnd;
    b.dataset.tip = atEnd ? (up ? '已經是最大字級' : '已經是最小字級') : (up ? '放大原文的字' : '縮小原文的字');
  }
}

function applyPrefs() {
  document.documentElement.style.setProperty('--fs', prefs.fs + 'px');
  applyFontLevel();
  document.querySelectorAll('#layoutSeg button').forEach(b => b.classList.toggle('on', b.dataset.layout === prefs.layout));
}
document.querySelectorAll('[data-font]').forEach(b => b.addEventListener('click', () => {
  prefs.fs = Math.min(FS_MAX, Math.max(FS_MIN, prefs.fs + Number(b.dataset.font) * FS_STEP));
  save(); applyPrefs();
}));
document.querySelectorAll('[data-layout]').forEach(b => b.addEventListener('click', () => {
  prefs.layout = b.dataset.layout; save(); applyPrefs();
  if (location.hash.startsWith('#/poem/')) { const y = scrollY; route(); scrollTo(0, y); }
}));

/* ---------- 路由 ---------- */
function route() {
  closeSheet();
  closeMenu();
  const m = location.hash.match(/^#\/poem\/([\w-]+)/);
  if (m) renderPoem(m[1]); else renderList();
}
window.addEventListener('hashchange', route);

/* ---------- 啟動 ---------- */
(async function start() {
  applyPrefs();
  try {
    const res = await fetch('data/poems.json');
    DATA = await res.json();
    // 依朝代先後排列（同朝代維持資料檔中的順序），目錄與上下篇都照這個順序
    DATA.poems = DATA.poems
      .map((p, i) => ({ p, i, r: rankOf(DYNASTY_ORDER, authorOf(p).dynasty) }))
      .sort((x, y) => x.r - y.r || x.i - y.i)
      .map(x => x.p);
    route();
  } catch (e) {
    app.innerHTML = '<div class="empty">資料載入失敗。第一次使用請先連上網路開啟一次。</div>';
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
