'use strict';
/* 古詩文編輯器：讀取 /api/data，編輯後經 /api/save 寫回 public/data/poems.json（由 scripts/editor.py 提供） */

const $ = s => document.querySelector(s);
let DATA = null, DYNASTIES = [], FORMS = [];
let originalId = null;   // 正在編輯的作品原本的代號；新增時為 null
let dirty = false;

/* ---------- 小工具 ---------- */
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'tip') { e.dataset.tip = v; if (!attrs['aria-label']) e.setAttribute('aria-label', v); }
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}
async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, opt);
  return r.json();
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), 2600);
}
const paras = s => s.split(/\n\s*\n/).map(x => x.replace(/\s*\n\s*/g, '').trim()).filter(Boolean);
const joinParas = v => (Array.isArray(v) ? v : v ? [v] : []).join('\n\n');
const oneOrMany = arr => (arr.length === 1 ? arr[0] : arr);
const SENT = /[^。！？]*[。！？]+[」』]*|[^。！？]+$/g;
const markDirty = () => { dirty = true; };
addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- 作品清單 ---------- */
/* 調整順序模式：order 是作品代號的暫存順序，按「儲存順序」才寫回 */
let order = null;
const dynastyOf = id => DATA.authors[DATA.poems.find(p => p.id === id).author].dynasty;

function renderList() {
  if (order) return renderOrderList();
  const q = $('#listSearch').value.trim();
  const list = $('#list'); list.replaceChildren();
  const rank = d => { const i = DYNASTIES.indexOf(d); return i < 0 ? 999 : i; };
  const items = DATA.poems.map((p, i) => ({ p, i, a: DATA.authors[p.author] }))
    .filter(({ p, a }) => !q || [p.title, p.id, a.name].some(s => s.includes(q)))
    .sort((x, y) => rank(x.a.dynasty) - rank(y.a.dynasty) || x.i - y.i);
  let last = null;
  for (const { p, a } of items) {
    if (a.dynasty !== last) { list.append(el('div', { class: 'list-group' }, a.dynasty)); last = a.dynasty; }
    list.append(el('button', { type: 'button', class: 'list-item' + (p.id === originalId ? ' on' : ''), onclick: () => confirmLeave() && openWork(p.id) },
      el('span', {}, p.title), el('small', {}, a.name)));
  }
  if (!items.length) list.append(el('div', { class: 'list-group' }, '找不到符合的作品'));
}

/* 依朝代分組顯示 order；只能在同一朝代內移動（閱讀器一律先依朝代排列） */
function orderedGroups() {
  const rank = d => { const i = DYNASTIES.indexOf(d); return i < 0 ? 999 : i; };
  const groups = new Map();
  for (const id of order) {
    const d = dynastyOf(id);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(id);
  }
  return [...groups.entries()].sort((x, y) => rank(x[0]) - rank(y[0]));
}

function moveInOrder(id, delta) {
  const groups = orderedGroups();
  const g = groups.find(([, ids]) => ids.includes(id))[1];
  const i = g.indexOf(id), j = i + delta;
  if (j < 0 || j >= g.length) return;
  [g[i], g[j]] = [g[j], g[i]];
  order = groups.flatMap(([, ids]) => ids);
  renderOrderList(id);
}

let dragId = null;
function renderOrderList(focusId) {
  const list = $('#list'); list.replaceChildren();
  for (const [dyn, ids] of orderedGroups()) {
    list.append(el('div', { class: 'list-group' }, dyn));
    ids.forEach((id, k) => {
      const p = DATA.poems.find(x => x.id === id), a = DATA.authors[p.author];
      const item = el('div', {
        class: 'list-item order-item', draggable: 'true', 'data-id': id, 'data-dyn': dyn,
        ondragstart: e => { dragId = id; e.dataTransfer.effectAllowed = 'move'; item.classList.add('dragging'); },
        ondragend: () => { dragId = null; item.classList.remove('dragging'); document.querySelectorAll('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after')); },
        ondragover: e => {
          if (!dragId || dragId === id || dynastyOf(dragId) !== dyn) return;
          e.preventDefault();
          const after = e.offsetY > item.offsetHeight / 2;
          item.classList.toggle('drop-after', after); item.classList.toggle('drop-before', !after);
        },
        ondragleave: () => item.classList.remove('drop-before', 'drop-after'),
        ondrop: e => {
          if (!dragId || dragId === id || dynastyOf(dragId) !== dyn) return;
          e.preventDefault();
          const after = item.classList.contains('drop-after');
          order = order.filter(x => x !== dragId);
          order.splice(order.indexOf(id) + (after ? 1 : 0), 0, dragId);
          renderOrderList(dragId);
        },
      },
        el('span', { class: 'grip', 'aria-hidden': 'true' }, '⠿'),
        el('span', { class: 'order-title' }, p.title, ' ', el('small', {}, a.name)),
        el('button', { type: 'button', class: 'icon-btn', title: '在同一朝代內往前移一位', 'aria-label': `上移〈${p.title}〉`, disabled: k === 0, onclick: () => moveInOrder(id, -1) }, '↑'),
        el('button', { type: 'button', class: 'icon-btn', title: '在同一朝代內往後移一位', 'aria-label': `下移〈${p.title}〉`, disabled: k === ids.length - 1, onclick: () => moveInOrder(id, 1) }, '↓'));
      list.append(item);
      if (id === focusId) requestAnimationFrame(() => item.scrollIntoView({ block: 'nearest' }));
    });
  }
}

function setOrderMode(on) {
  order = on ? DATA.poems.map(p => p.id) : null;
  $('#orderBtn').hidden = on;
  $('#orderTools').hidden = $('#orderHint').hidden = !on;
  $('#listSearch').disabled = on;
  renderList();
}

async function saveOrder() {
  const res = await api('/api/reorder', { order });
  if (!res.ok) { showReport(res); return; }
  await reload();
  setOrderMode(false);
  toast(res.unchanged ? '順序沒有變動' : '已儲存順序');
  if (!res.unchanged) showReport({}, `已儲存順序（原資料備份在 ${res.backup}）。`);
}

function confirmLeave() {
  return !dirty || confirm('目前的修改還沒儲存，確定要離開嗎？');
}

/* ---------- 表單：填入 ---------- */
function fillSelects() {
  $('#f-form').replaceChildren(...FORMS.map(f => el('option', { value: f }, f)));
  $('#a-dynasty').replaceChildren(...DYNASTIES.map(d => el('option', { value: d }, d)));
  const rank = d => DYNASTIES.indexOf(d);
  const authors = Object.entries(DATA.authors).sort((x, y) => rank(x[1].dynasty) - rank(y[1].dynasty));
  $('#a-select').replaceChildren(
    el('option', { value: '__new' }, '＋ 新增作者…'),
    ...authors.map(([id, a]) => el('option', { value: id }, `${a.dynasty}・${a.name}（${id}）`)));
}

function fillAuthor(id) {
  const a = DATA.authors[id];
  const isNew = !a;
  $('#a-select').value = isNew ? '__new' : id;
  $('#a-id').value = isNew ? '' : id;
  $('#a-id').readOnly = !isNew;
  $('#a-name').value = a?.name || '';
  $('#a-dynasty').value = a?.dynasty || '唐';
  $('#a-years').value = a?.years || '';
  $('#a-source').checked = a?.kind === 'source';
  $('#a-intro').value = joinParas(a?.intro || '');
  const n = isNew ? 0 : DATA.poems.filter(p => p.author === id).length;
  $('#a-hint').textContent = isNew ? '新作者：請填寫代號、名稱、朝代、生卒年與介紹。'
    : `修改作者資料會套用到這位作者的全部 ${n} 篇作品。`;
}

function fillForm(p, authorOverride) {
  $('#formTitle').textContent = originalId ? `編輯：${p.title || ''}` : '新增作品';
  $('#f-title').value = p.title || '';
  $('#f-id').value = p.id || '';
  $('#f-type').value = p.type || 'verse';
  $('#f-form').value = p.form || FORMS[0];
  $('#f-tags').value = (p.tags || []).join('、');
  $('#f-source').value = p.source || '';
  if (authorOverride) {
    fillAuthor('__none__');
    $('#a-id').value = p.author || ''; $('#a-id').readOnly = false;
    $('#a-name').value = authorOverride.name || '';
    $('#a-dynasty').value = authorOverride.dynasty || '唐';
    $('#a-years').value = authorOverride.years || '';
    $('#a-source').checked = authorOverride.kind === 'source';
    $('#a-intro').value = joinParas(authorOverride.intro || '');
  } else {
    fillAuthor(p.author);
  }
  $('#p-has').checked = !!p.preface;
  $('#p-fields').hidden = !p.preface;
  $('#p-src').value = p.preface?.[0] || '';
  $('#p-tr').value = p.preface?.[1] || '';
  $('#blocks').replaceChildren(...(p.body?.length ? p.body : [[['', '']]]).map(blockCard));
  $('#notes').replaceChildren(...(p.notes || []).map(noteRow));
  $('#f-background').value = joinParas(p.background || '');
  $('#f-analysis').value = joinParas(p.analysis || []);
  renumber(); updateNoteStatus();
  $('#deleteBtn').hidden = $('#exportBtn').hidden = $('#previewBtn').hidden = !originalId;
  $('#report').replaceChildren();
  dirty = false;
  renderList();
  window.scrollTo(0, 0);
}

/* ---------- 原文與語譯 ---------- */
function autoGrow(t) { t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px'; }

function pairRow([src, tr] = ['', '']) {
  const s = el('textarea', { class: 'input src', rows: 1, placeholder: '原文' }); s.value = src;
  const t = el('textarea', { class: 'input tr', rows: 1, placeholder: '語譯' }); t.value = tr;
  const row = el('div', { class: 'pair-row' },
    el('span', { class: 'pair-num' }),
    s, t,
    el('div', { class: 'pair-tools' },
      el('button', { type: 'button', class: 'icon-btn', 'data-tip-pos': 'left', tip: '把這一句往上移', onclick: () => { row.previousElementSibling?.classList.contains('pair-row') && row.previousElementSibling.before(row); renumber(); markDirty(); } }, '↑'),
      el('button', { type: 'button', class: 'icon-btn', 'data-tip-pos': 'left', tip: '把這一句往下移', onclick: () => { row.nextElementSibling?.classList.contains('pair-row') && row.nextElementSibling.after(row); renumber(); markDirty(); } }, '↓'),
      el('button', { type: 'button', class: 'icon-btn', 'data-tip-pos': 'left', tip: '在這一句下面插入一個空白句', onclick: () => { row.after(pairRow()); renumber(); markDirty(); } }, '＋'),
      el('button', { type: 'button', class: 'icon-btn', 'data-tip-pos': 'left', tip: '刪除這一句（原文與語譯）', onclick: () => { row.remove(); renumber(); markDirty(); updateNoteStatus(); } }, '✕')));
  for (const ta of [s, t]) {
    ta.addEventListener('input', () => { autoGrow(ta); markDirty(); if (ta === s) updateNoteStatus(); });
    requestAnimationFrame(() => autoGrow(ta));
  }
  return row;
}

function blockCard(pairs = [['', '']]) {
  const rows = el('div', { class: 'rows' }, ...pairs.map(pairRow));
  const card = el('div', { class: 'block-card' },
    el('div', { class: 'block-head' },
      el('span', { class: 'block-name' }),
      el('span', { class: 'spacer' }),
      el('button', { type: 'button', class: 'icon-btn', 'data-tip-pos': 'left', tip: '把整段移到上一段之前', onclick: () => { card.previousElementSibling && card.previousElementSibling.before(card); renumber(); markDirty(); } }, '↑ 上移'),
      el('button', { type: 'button', class: 'icon-btn', 'data-tip-pos': 'left', tip: '把整段移到下一段之後', onclick: () => { card.nextElementSibling && card.nextElementSibling.after(card); renumber(); markDirty(); } }, '↓ 下移'),
      el('button', { type: 'button', class: 'icon-btn', 'data-tip-pos': 'left', tip: '刪除這一段的所有句子（會先確認）', onclick: () => { if (confirm('刪除這一段的所有句子？')) { card.remove(); renumber(); markDirty(); updateNoteStatus(); } } }, '✕ 刪除段落')),
    rows,
    el('button', { type: 'button', class: 'btn small', tip: '在這一段的最後加一個空白句', onclick: () => { rows.append(pairRow()); renumber(); markDirty(); rows.lastElementChild.querySelector('.src').focus(); } }, '＋ 新增一句'));
  return card;
}

function renumber() {
  const verse = $('#f-type').value === 'verse';
  [...document.querySelectorAll('.block-card')].forEach((c, i) => {
    c.querySelector('.block-name').textContent = verse ? `第 ${i + 1} 章／片` : `第 ${i + 1} 段`;
    [...c.querySelectorAll('.pair-row')].forEach((r, j) => (r.querySelector('.pair-num').textContent = j + 1));
  });
}

/* ---------- 註釋 ---------- */
function noteRow(n = { term: '', note: '' }) {
  const term = el('input', { class: 'input n-term', placeholder: '詞' }); term.value = n.term || '';
  const ctx = el('input', { class: 'input n-in', placeholder: '前後文片段' }); ctx.value = n.in || '';
  const note = el('textarea', { class: 'input n-note', rows: 1, placeholder: '解釋' }); note.value = n.note || '';
  const status = el('div', { class: 'note-status' });
  const row = el('div', { class: 'note-row' }, term, ctx, note,
    el('div', { class: 'note-status-wrap' }, status,
      el('button', { type: 'button', class: 'icon-btn', 'data-tip-pos': 'left', tip: '把這則註釋往上移（註釋依原文出現的順序排列）', onclick: () => { row.previousElementSibling && row.previousElementSibling.before(row); markDirty(); } }, '↑'),
      el('button', { type: 'button', class: 'icon-btn', 'data-tip-pos': 'left', tip: '刪除這則註釋', onclick: () => { row.remove(); markDirty(); } }, '✕')));
  for (const i of [term, ctx, note]) i.addEventListener('input', () => { markDirty(); if (i === note) autoGrow(note); else updateNoteStatus(); });
  requestAnimationFrame(() => autoGrow(note));
  return row;
}

function fullText() {
  const pre = $('#p-has').checked ? $('#p-src').value : '';
  return (pre + [...document.querySelectorAll('.pair-row .src')].map(t => t.value).join('')).replace(/\n/g, '');
}

function updateNoteStatus() {
  const full = fullText(), title = $('#f-title').value;
  for (const row of document.querySelectorAll('.note-row')) {
    const term = row.querySelector('.n-term').value.trim(), ctx = row.querySelector('.n-in').value.trim();
    let cls = 'ok', label = '找到', tip = '原文中找得到這個詞，閱讀頁會在它下面標底線';
    if (!term) { cls = 'err'; label = '未填詞'; tip = '請填寫要註解的詞'; }
    else if (ctx) {
      const n = full.split(ctx).length - 1;
      if (!ctx.includes(term)) { cls = 'err'; label = '前後文不含詞'; tip = '「前後文」裡必須包含這個詞'; }
      else if (n !== 1) {
        cls = 'err'; label = n ? `前後文出現 ${n} 次` : '找不到前後文';
        tip = n ? '「前後文」在原文出現不只一次，請多抄幾個字，讓它只出現一次' : '原文中找不到這段「前後文」，請確認一字不差';
      } else tip = '已用前後文指定位置，閱讀頁會標在這個位置';
    } else if (!full.includes(term)) {
      if (title.includes(term)) { cls = 'warn'; label = '只在題目'; tip = '這個詞只出現在題目中，閱讀頁會把底線標在標題上'; }
      else { cls = 'err'; label = '找不到'; tip = '原文和題目都沒有這個詞，請確認用字一字不差'; }
    } else if (full.split(term).length - 1 > 1 && term.length === 1) {
      cls = 'warn'; label = '出現多次';
      tip = '這個字在原文出現不只一次，底線會標在第一次出現的地方；要標在別處，請在「前後文」填入它所在的一小段原文';
    }
    row.querySelector('.note-status').replaceChildren(el('span', { class: 'tag ' + cls, tip, 'data-tip-pos': 'left', tabindex: 0 }, label));
  }
}

/* ---------- 表單：讀出 ---------- */
function collect() {
  const body = [...document.querySelectorAll('.block-card')].map(c =>
    [...c.querySelectorAll('.pair-row')]
      .map(r => [r.querySelector('.src').value.trim(), r.querySelector('.tr').value.trim()])
      .filter(([s, t]) => s || t))
    .filter(b => b.length);
  const poem = { id: $('#f-id').value.trim(), title: $('#f-title').value.trim() };
  poem.author = $('#a-id').value.trim();
  const source = $('#f-source').value.trim();
  if (source) poem.source = source;
  poem.type = $('#f-type').value;
  poem.form = $('#f-form').value;
  poem.tags = $('#f-tags').value.split(/[、，,\s]+/).filter(Boolean);
  if ($('#p-has').checked) poem.preface = [$('#p-src').value.trim(), $('#p-tr').value.trim()];
  poem.body = body;
  poem.notes = [...document.querySelectorAll('.note-row')].map(r => {
    const n = { term: r.querySelector('.n-term').value.trim() };
    const ctx = r.querySelector('.n-in').value.trim();
    if (ctx) n.in = ctx;
    n.note = r.querySelector('.n-note').value.trim();
    return n;
  }).filter(n => n.term || n.note);
  poem.background = oneOrMany(paras($('#f-background').value));
  poem.analysis = paras($('#f-analysis').value);
  const author = {
    id: poem.author, name: $('#a-name').value.trim(), dynasty: $('#a-dynasty').value,
    years: $('#a-years').value.trim(), intro: oneOrMany(paras($('#a-intro').value)),
  };
  if ($('#a-source').checked) author.kind = 'source';
  return { originalId, poem, author };
}

/* ---------- 檢查、儲存、刪除 ---------- */
function showReport(res, okMsg) {
  const r = $('#report'); r.replaceChildren();
  if (res.errors?.length) r.append(el('div', { class: 'err' }, `錯誤 ${res.errors.length} 項：`), el('ul', { class: 'err' }, ...res.errors.map(e => el('li', {}, e))));
  if (res.warnings?.length) r.append(el('div', { class: 'warn' }, `提醒 ${res.warnings.length} 項：`), el('ul', { class: 'warn' }, ...res.warnings.map(e => el('li', {}, e))));
  if (!res.errors?.length && okMsg) r.prepend(el('div', { class: 'ok' }, okMsg));
}

async function check() {
  const res = await api('/api/check', collect());
  showReport(res, '檢查通過，可以儲存。');
  return res;
}

async function save() {
  const payload = collect();
  const res = await api('/api/save', payload);
  if (!res.ok) { showReport(res); toast('有錯誤，尚未儲存'); return; }
  await reload();
  originalId = payload.poem.id;
  dirty = false;
  fillForm(DATA.poems.find(p => p.id === originalId));
  showReport(res, `已儲存（原資料備份在 ${res.backup}）。發布前記得更新 public/sw.js 的版本號並推上 GitHub。`);
  toast('已儲存');
}

async function remove() {
  const p = DATA.poems.find(x => x.id === originalId);
  if (!p || !confirm(`確定要刪除〈${p.title}〉嗎？（原資料會先備份到 .backup/）`)) return;
  const res = await api('/api/delete', { id: originalId });
  if (!res.ok) { showReport(res); return; }
  await reload();
  newWork(true);
  toast(`已刪除〈${p.title}〉`);
}

async function reload() {
  const res = await api('/api/data');
  DATA = res.data; DYNASTIES = res.dynasties; FORMS = res.forms;
  fillSelects();
}

function openWork(id) {
  originalId = id;
  fillForm(DATA.poems.find(p => p.id === id));
}

function newWork(force) {
  if (!force && !confirmLeave()) return;
  originalId = null;
  fillForm({ type: 'verse', body: [[['', '']]], tags: [], notes: [], analysis: [] }, null);
  fillAuthor('__new');
}

/* ---------- 對話框：快速貼上、匯入、匯出 ---------- */
function dialog(title, hint, content, actions) {
  $('#dlgTitle').textContent = title;
  $('#dlgHint').textContent = hint;
  $('#dlgContent').replaceChildren(content);
  $('#dlgActions').replaceChildren(...actions, el('button', { class: 'btn', value: 'cancel' }, '關閉'));
  $('#dlg').showModal();
}

/* 把整篇原文與整篇語譯切成逐句的配對：
   詩詞依行切，到句號、問號、驚嘆號才算一句（同一句的幾行保留分行）；散文依標點切句。空行代表換段。 */
function splitSource(text, verse) {
  return text.split(/\n\s*\n/).map(block => {
    if (verse) {
      const out = []; let cur = [];
      for (const l of block.split('\n').map(s => s.trim()).filter(Boolean)) {
        cur.push(l);
        if (/[。！？][」』]*$/.test(l)) { out.push(cur.join('\n')); cur = []; }
      }
      if (cur.length) out.push(cur.join('\n'));
      return out;
    }
    return block.replace(/\s+/g, '').match(SENT) || [];
  }).filter(b => b.length);
}
const splitTrans = text => text.split(/\n\s*\n/).map(b => b.replace(/\s*\n\s*/g, '').match(SENT) || []).filter(b => b.length);

function quickPaste() {
  const src = el('textarea', { class: 'input', rows: 8, placeholder: '貼上整篇原文。空一行代表換段；詩詞請一行一句。' });
  const tr = el('textarea', { class: 'input', rows: 8, placeholder: '貼上整篇語譯，段落與原文對應，空一行換段。' });
  const info = el('p', { class: 'hint' });
  const preview = () => {
    const verse = $('#f-type').value === 'verse';
    const S = splitSource(src.value, verse), T = splitTrans(tr.value);
    const ns = S.flat().length, nt = T.flat().length;
    info.textContent = `原文 ${S.length} 段 ${ns} 句；語譯 ${T.length} 段 ${nt} 句。` + (ns && nt && ns !== nt ? '句數不同：會依順序配對，多出來的放在最後，請在表格中調整。' : '');
  };
  src.addEventListener('input', preview); tr.addEventListener('input', preview);
  dialog('快速貼上整篇', '依句號、問號、驚嘆號自動切句並配對。貼上後會取代目前的「原文與語譯」。',
    el('div', { class: 'pair-grid' }, src, tr), [
      info,
      el('button', { class: 'btn primary', value: 'ok', onclick: e => {
        const verse = $('#f-type').value === 'verse';
        const S = splitSource(src.value, verse), T = splitTrans(tr.value).flat();
        if (!S.length) { e.preventDefault(); info.textContent = '請先貼上原文。'; return; }
        let k = 0;
        const blocks = S.map(b => b.map(s => [s, T[k++] || '']));
        if (k < T.length) blocks[blocks.length - 1].push(['', T.slice(k).join('')]);
        $('#blocks').replaceChildren(...blocks.map(blockCard));
        renumber(); updateNoteStatus(); markDirty();
      } }, '套用')]);
}

function importDraft() {
  const ta = el('textarea', { class: 'input', rows: 16, placeholder: '貼上稿件內容（格式見 templates/作品稿件範本.txt）' });
  dialog('匯入稿件', '貼上用文字寫好的稿件，會填入表單，確認後再按「儲存」。', ta, [
    el('button', { class: 'btn primary', value: 'ok', onclick: async e => {
      e.preventDefault();
      const res = await api('/api/import', { text: ta.value });
      if (!res.ok) { showReport(res); $('#dlg').close(); return; }
      $('#dlg').close();
      const exists = DATA.poems.some(p => p.id === res.poem.id);
      originalId = exists ? res.poem.id : null;
      const known = DATA.authors[res.poem.author];
      fillForm(res.poem, known ? null : (res.author || {}));
      markDirty();
      toast(exists ? '已匯入，將取代同代號的作品' : '已匯入，請檢查後儲存');
    } }, '匯入')]);
}

async function exportDraft() {
  const res = await api('/api/export?id=' + encodeURIComponent(originalId));
  const ta = el('textarea', { class: 'input', rows: 18, readonly: true }); ta.value = res.text || res.error;
  dialog('匯出稿件', '可以複製或下載成文字檔保存。', ta, [
    el('button', { type: 'button', class: 'btn', onclick: () => { navigator.clipboard.writeText(ta.value); toast('已複製'); } }, '複製'),
    el('button', { type: 'button', class: 'btn primary', onclick: () => {
      const a = el('a', { href: URL.createObjectURL(new Blob([ta.value], { type: 'text/plain;charset=utf-8' })), download: `${originalId}.txt` });
      a.click(); URL.revokeObjectURL(a.href);
    } }, '下載')]);
}

/* ---------- 啟動 ---------- */
(async function start() {
  await reload();
  $('#listSearch').addEventListener('input', renderList);
  $('#orderBtn').addEventListener('click', () => setOrderMode(true));
  $('#orderCancel').addEventListener('click', () => setOrderMode(false));
  $('#orderSave').addEventListener('click', saveOrder);
  $('#newBtn').addEventListener('click', () => newWork());
  $('#importBtn').addEventListener('click', importDraft);
  $('#helpBtn').addEventListener('click', () => $('#helpDlg').showModal());
  $('#addBlock').addEventListener('click', () => { $('#blocks').append(blockCard()); renumber(); markDirty(); });
  $('#pasteBtn').addEventListener('click', quickPaste);
  $('#addNote').addEventListener('click', () => { $('#notes').append(noteRow()); markDirty(); $('#notes').lastElementChild.querySelector('.n-term').focus(); });
  $('#checkBtn').addEventListener('click', check);
  $('#saveBtn').addEventListener('click', save);
  $('#deleteBtn').addEventListener('click', remove);
  $('#exportBtn').addEventListener('click', exportDraft);
  $('#previewBtn').addEventListener('click', () => window.open(`/site/#/poem/${originalId}`, '_blank', 'noopener'));
  $('#p-has').addEventListener('change', () => { $('#p-fields').hidden = !$('#p-has').checked; markDirty(); updateNoteStatus(); });
  $('#f-type').addEventListener('change', renumber);
  $('#f-title').addEventListener('input', updateNoteStatus);
  $('#a-select').addEventListener('change', e => { fillAuthor(e.target.value); markDirty(); });
  $('#form').addEventListener('input', markDirty);
  const first = DATA.poems[0];
  if (first) openWork(first.id); else newWork(true);
  // 第一次打開編輯器時自動顯示使用說明（之後可隨時按右上角「？ 使用說明」）
  try {
    if (!localStorage.getItem('gushiwen-editor-help-seen')) {
      $('#helpDlg').showModal();
      localStorage.setItem('gushiwen-editor-help-seen', '1');
    }
  } catch {}
})();
