'use strict';
/* 古詩文編輯器：讀取 /api/data，編輯後經 /api/save 寫回 public/data/poems.json（由 scripts/editor.py 提供）。
   這裡只負責畫面：表單送出的是填寫的原始文字，分段、去空白、註釋狀態、快速貼上的切句都交給伺服器，
   和稿件工具共用同一套 Python 程式（scripts/poemdata.py、validate_poems.py）；朝代、體裁、類型的清單也由伺服器提供。 */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let DATA = null, DYNASTIES = [], FORMS = [], TYPES = {};
let originalId = null;   // 正在編輯的作品原本的代號；新增時為 null
let dirty = false;

/* ---------- 小工具 ---------- */
/* 建立元素：class、tip（即時提示，也當作無障礙名稱）、value（輸入框的內容）、on* 事件，其餘當作屬性 */
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'value') e.value = v ?? '';
    else if (k === 'tip') { if (v) { e.dataset.tip = v; if (!attrs['aria-label']) e.setAttribute('aria-label', v); } }
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}

/* 列表裡的小按鈕（上移、下移、插入、刪除）；提示預設往左展開，因為按鈕都在右側 */
const iconBtn = (label, tip, onclick, attrs = {}) =>
  el('button', { type: 'button', class: 'icon-btn', 'data-tip-pos': 'left', tip, onclick, ...attrs }, label);

/* 隨內容自動長高的文字框 */
function growing(ta) {
  const fit = () => { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight + 2) + 'px'; };
  ta.addEventListener('input', fit);
  requestAnimationFrame(fit);
  return ta;
}

/* 重建下拉選單並保留目前的選擇（重新載入資料後，表單上已選的值不會被重設） */
function setOptions(select, pairs) {
  const v = select.value;
  select.replaceChildren(...pairs.map(([value, label]) => el('option', { value }, label)));
  if (v) select.value = v;
}

/* 呼叫 editor.py。伺服器回的 {error} 和連線失敗都統一成 {ok: false, errors: […]}，呼叫端只要看 ok 與 errors */
async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  try {
    const res = await (await fetch(path, opt)).json();
    return res.error ? { ok: false, errors: [res.error] } : res;
  } catch (e) {
    return { ok: false, errors: [`連不上編輯器的伺服器，請確認 python -I scripts/editor.py 還在執行（${e.message}）`] };
  }
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

/* 等使用者停手一下才執行（打字時不必每個字都問一次伺服器） */
function debounce(fn, ms) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

const val = (s, root = document) => root.querySelector(s).value;
// 資料中的多段文字（字串或陣列）在表單上以空行分段顯示；存回時由伺服器的 poemdata.paragraphs 分段
const joinParas = v => (Array.isArray(v) ? v : v ? [v] : []).join('\n\n');

/* 資料查詢 */
const rankDynasty = d => { const i = DYNASTIES.indexOf(d); return i < 0 ? DYNASTIES.length : i; };   // 和 poemdata.dynasty_rank 相同：不在清單的排最後
const poemById = id => DATA.poems.find(p => p.id === id);
const dynastyOf = id => DATA.authors[poemById(id).author].dynasty;
const isVerse = () => $('#f-type').value === 'verse';

/* 修改狀態：打字由 #form 的 input 事件統一標記；用按鈕增刪、移動時呼叫 changed() */
const markDirty = () => { dirty = true; };
addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

function changed() { renumber(); updateNoteStatus(); markDirty(); }

/* 和前一個（dir < 0）或後一個同層元素對調位置：句子、段落、註釋共用 */
function moveEl(node, dir) {
  const sib = dir < 0 ? node.previousElementSibling : node.nextElementSibling;
  if (!sib) return;
  if (dir < 0) sib.before(node); else sib.after(node);
  changed();
}
function removeEl(node) { node.remove(); changed(); }
/* 在清單最後加一列，並把游標放進指定的欄位 */
function addRow(list, row, focus) { list.append(row); changed(); if (focus) row.querySelector(focus).focus(); }

function confirmLeave() {
  return !dirty || confirm('目前的修改還沒儲存，確定要離開嗎？');
}

/* ---------- 作品清單 ---------- */
/* 調整順序模式：order 是作品代號的暫存順序，按「儲存順序」才寫回 */
let order = null;

function renderList() {
  if (order) return renderOrderList();
  const q = $('#listSearch').value.trim();
  const list = $('#list'); list.replaceChildren();
  const items = DATA.poems.map((p, i) => ({ p, i, a: DATA.authors[p.author] }))
    .filter(({ p, a }) => !q || [p.title, p.id, a.name].some(s => s.includes(q)))
    .sort((x, y) => rankDynasty(x.a.dynasty) - rankDynasty(y.a.dynasty) || x.i - y.i);
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
  const groups = new Map();
  for (const id of order) {
    const d = dynastyOf(id);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(id);
  }
  return [...groups.entries()].sort((x, y) => rankDynasty(x[0]) - rankDynasty(y[0]));
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
      const p = poemById(id), a = DATA.authors[p.author];
      const canDrop = () => dragId && dragId !== id && dynastyOf(dragId) === dyn;
      const item = el('div', {
        class: 'list-item order-item', draggable: 'true', 'data-id': id, 'data-dyn': dyn,
        ondragstart: e => { dragId = id; e.dataTransfer.effectAllowed = 'move'; item.classList.add('dragging'); },
        ondragend: () => { dragId = null; item.classList.remove('dragging'); $$('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after')); },
        ondragover: e => {
          if (!canDrop()) return;
          e.preventDefault();
          const after = e.offsetY > item.offsetHeight / 2;
          item.classList.toggle('drop-after', after); item.classList.toggle('drop-before', !after);
        },
        ondragleave: () => item.classList.remove('drop-before', 'drop-after'),
        ondrop: e => {
          if (!canDrop()) return;
          e.preventDefault();
          const after = item.classList.contains('drop-after');
          order = order.filter(x => x !== dragId);
          order.splice(order.indexOf(id) + (after ? 1 : 0), 0, dragId);
          renderOrderList(dragId);
        },
      },
        el('span', { class: 'grip', 'aria-hidden': 'true' }, '⠿'),
        el('span', { class: 'order-title' }, p.title, ' ', el('small', {}, a.name)),
        // 清單會捲動，浮動提示會被裁掉，所以這兩個按鈕用瀏覽器內建的 title 提示
        iconBtn('↑', null, () => moveInOrder(id, -1), { title: '在同一朝代內往前移一位', 'aria-label': `上移〈${p.title}〉`, disabled: k === 0 }),
        iconBtn('↓', null, () => moveInOrder(id, 1), { title: '在同一朝代內往後移一位', 'aria-label': `下移〈${p.title}〉`, disabled: k === ids.length - 1 }));
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
  if (!res.ok) return showReport(res);
  if (!(await reload())) return;
  setOrderMode(false);
  if (res.unchanged) return toast('順序沒有變動');
  toast('已儲存順序');
  showReport({}, savedMsg(res, '已儲存順序'));
}

/* ---------- 表單：填入 ---------- */
function fillSelects() {
  const same = list => list.map(x => [x, x]);
  setOptions($('#f-type'), Object.entries(TYPES));
  setOptions($('#f-form'), same(FORMS));
  setOptions($('#a-dynasty'), same(DYNASTIES));
  const authors = Object.entries(DATA.authors).sort((x, y) => rankDynasty(x[1].dynasty) - rankDynasty(y[1].dynasty));
  setOptions($('#a-select'), [['__new', '＋ 新增作者…'], ...authors.map(([id, a]) => [id, `${a.dynasty}・${a.name}（${id}）`])]);
}

/* 作者欄位：已有的作者帶入資料並鎖住代號；新作者留空，或帶入匯入稿件裡的作者資料（draft） */
function fillAuthor(id, draft) {
  const a = DATA.authors[id], isNew = !a;
  $('#a-select').value = isNew ? '__new' : id;
  $('#a-id').value = isNew && !draft ? '' : id || '';
  $('#a-id').readOnly = !isNew;
  const f = a || draft || {};
  $('#a-name').value = f.name || '';
  $('#a-dynasty').value = f.dynasty || '唐';
  $('#a-years').value = f.years || '';
  $('#a-source').checked = f.kind === 'source';
  $('#a-intro').value = joinParas(f.intro);
  $('#a-hint').textContent = isNew ? '新作者：請填寫代號、名稱、朝代、生卒年與介紹。'
    : `修改作者資料會套用到這位作者的全部 ${DATA.poems.filter(p => p.author === id).length} 篇作品。`;
}

function fillForm(p, authorDraft) {
  $('#formTitle').textContent = originalId ? `編輯：${p.title || ''}` : '新增作品';
  $('#f-title').value = p.title || '';
  $('#f-id').value = p.id || '';
  $('#f-type').value = p.type || 'verse';
  $('#f-form').value = p.form || FORMS[0];
  $('#f-tags').value = (p.tags || []).join('、');
  $('#f-source').value = p.source || '';
  fillAuthor(p.author, authorDraft);
  $('#p-has').checked = !!p.preface;
  $('#p-fields').hidden = !p.preface;
  $('#p-src').value = p.preface?.[0] || '';
  $('#p-tr').value = p.preface?.[1] || '';
  $('#blocks').replaceChildren(...(p.body?.length ? p.body : [[['', '']]]).map(blockCard));
  $('#notes').replaceChildren(...(p.notes || []).map(noteRow));
  $('#f-background').value = joinParas(p.background);
  $('#f-analysis').value = joinParas(p.analysis);
  $('#f-edition').value = joinParas(p.edition);
  $('#f-references').value = (p.references || []).join('\n');
  renumber(); updateNoteStatus();
  $('#deleteBtn').hidden = $('#exportBtn').hidden = $('#previewBtn').hidden = !originalId;
  $('#report').replaceChildren();
  dirty = false;
  renderList();
  window.scrollTo(0, 0);
}

/* ---------- 原文與語譯 ---------- */
function pairRow([src, tr] = ['', '']) {
  const row = el('div', { class: 'pair-row' },
    el('span', { class: 'pair-num' }),
    growing(el('textarea', { class: 'input src', rows: 1, placeholder: '原文', value: src, oninput: updateNoteStatus })),
    growing(el('textarea', { class: 'input tr', rows: 1, placeholder: '語譯', value: tr })),
    el('div', { class: 'pair-tools' },
      iconBtn('↑', '把這一句往上移', () => moveEl(row, -1)),
      iconBtn('↓', '把這一句往下移', () => moveEl(row, 1)),
      iconBtn('＋', '在這一句下面插入一個空白句', () => { row.after(pairRow()); changed(); }),
      iconBtn('✕', '刪除這一句（原文與語譯）', () => removeEl(row))));
  return row;
}

function blockCard(pairs = [['', '']]) {
  const rows = el('div', { class: 'rows' }, ...pairs.map(pairRow));
  const card = el('div', { class: 'block-card' },
    el('div', { class: 'block-head' },
      el('span', { class: 'block-name' }),
      el('span', { class: 'spacer' }),
      iconBtn('↑ 上移', '把整段移到上一段之前', () => moveEl(card, -1)),
      iconBtn('↓ 下移', '把整段移到下一段之後', () => moveEl(card, 1)),
      iconBtn('✕ 刪除段落', '刪除這一段的所有句子（會先確認）', () => confirm('刪除這一段的所有句子？') && removeEl(card))),
    rows,
    el('button', { type: 'button', class: 'btn small', tip: '在這一段的最後加一個空白句', onclick: () => addRow(rows, pairRow(), '.src') }, '＋ 新增一句'));
  return card;
}

function renumber() {
  const verse = isVerse();
  $$('.block-card').forEach((c, i) => {
    c.querySelector('.block-name').textContent = verse ? `第 ${i + 1} 章／片` : `第 ${i + 1} 段`;
    c.querySelectorAll('.pair-row .pair-num').forEach((n, j) => (n.textContent = j + 1));
  });
}

/* ---------- 註釋 ---------- */
function noteRow(n = {}) {
  const row = el('div', { class: 'note-row' },
    el('input', { class: 'input n-term', placeholder: '詞', value: n.term }),
    el('input', { class: 'input n-in', placeholder: '前後文片段', value: n.in }),
    growing(el('textarea', { class: 'input n-note', rows: 1, placeholder: '解釋', value: n.note })),
    el('div', { class: 'note-status-wrap' }, el('div', { class: 'note-status' }),
      iconBtn('↑', '把這則註釋往上移（註釋依原文出現的順序排列）', () => moveEl(row, -1)),
      iconBtn('↓', '把這則註釋往下移', () => moveEl(row, 1)),
      iconBtn('✕', '刪除這則註釋', () => removeEl(row))));
  row.addEventListener('input', updateNoteStatus);
  return row;
}

/* 註釋狀態：由伺服器用和儲存檢查相同的規則判斷（validate_poems.note_status），停止輸入 0.2 秒後更新。
   只採用最後一次的結果，較早送出、較晚回來的舊結果直接丟掉 */
let noteSeq = 0;
const updateNoteStatus = debounce(async () => {
  const seq = ++noteSeq;
  const res = await api('/api/notes', collect());
  if (seq !== noteSeq || !res.ok) return;
  $$('.note-row').forEach((row, i) => {
    const [level, label, tip] = res.statuses[i] || [];
    if (level) row.querySelector('.note-status').replaceChildren(el('span', { class: 'tag ' + level, tip, 'data-tip-pos': 'left', tabindex: 0 }, label));
  });
}, 200);

/* ---------- 表單：讀出 ---------- */
/* 表單上填寫的原始文字，欄位名稱和 poemdata.make_record 相同；整理成資料由伺服器負責 */
function collect() {
  const fields = {
    id: val('#f-id'), title: val('#f-title'), author: val('#a-id'), source: val('#f-source'),
    type: val('#f-type'), form: val('#f-form'), tags: val('#f-tags'),
    preface: $('#p-has').checked ? [val('#p-src'), val('#p-tr')] : null,
    body: $$('.block-card').map(c => [...c.querySelectorAll('.pair-row')].map(r => [val('.src', r), val('.tr', r)])),
    notes: $$('.note-row').map(r => ({ term: val('.n-term', r), in: val('.n-in', r), note: val('.n-note', r) })),
    background: val('#f-background'), analysis: val('#f-analysis'), edition: val('#f-edition'), references: val('#f-references'),
    author_name: val('#a-name'), dynasty: val('#a-dynasty'), years: val('#a-years'), intro: val('#a-intro'),
    kind: $('#a-source').checked ? 'source' : '',
  };
  return { originalId, fields };
}

/* ---------- 檢查、儲存、刪除 ---------- */
function showReport(res, okMsg) {
  const r = $('#report'); r.replaceChildren();
  const list = (cls, title, items) => items?.length && r.append(el('div', { class: cls }, `${title} ${items.length} 項：`), el('ul', { class: cls }, ...items.map(e => el('li', {}, e))));
  list('err', '錯誤', res.errors);
  list('warn', '提醒', res.warnings);
  if (!res.errors?.length && okMsg) r.prepend(el('div', { class: 'ok' }, okMsg));
}

/* 寫入成功後的說明：備份檔的位置，以及簡體版的更新結果（沒有安裝 OpenCC 或轉換有問題時會在這裡看到） */
const savedMsg = (res, what) => `${what}（原資料備份在 ${res.backup}）。` + (res.hans ? '\n' + res.hans : '');

async function check() {
  const res = await api('/api/check', collect());
  showReport(res, '檢查通過，可以儲存。');
  return res;
}

async function save() {
  const res = await api('/api/save', collect());
  if (!res.ok) { showReport(res); toast('有錯誤，尚未儲存'); return; }
  if (!(await reload())) return;
  originalId = res.id;
  fillForm(poemById(originalId));
  showReport(res, savedMsg(res, '已儲存') + '\n發布前記得更新 public/sw.js 的版本號並推上 GitHub。');
  toast('已儲存');
}

async function remove() {
  const p = poemById(originalId);
  if (!p || !confirm(`確定要刪除〈${p.title}〉嗎？（原資料會先備份到 .backup/）`)) return;
  const res = await api('/api/delete', { id: originalId });
  if (!res.ok) return showReport(res);
  if (!(await reload())) return;
  newWork(true);
  const gone = res.removedAuthors?.length ? `\n這位作者已沒有其他作品，作者資料一併移除：${res.removedAuthors.join('、')}` : '';
  showReport({}, savedMsg(res, `已刪除〈${p.title}〉`) + gone);
  toast(`已刪除〈${p.title}〉`);
}

/* 重新讀取資料；失敗時（例如伺服器已關閉）顯示原因並回傳 false */
async function reload() {
  const res = await api('/api/data');
  if (!res.data) { showReport(res); toast('讀取資料失敗'); return false; }
  ({ data: DATA, dynasties: DYNASTIES, forms: FORMS, types: TYPES } = res);
  fillSelects();
  return true;
}

function openWork(id) {
  originalId = id;
  fillForm(poemById(id));
}

function newWork(force) {
  if (!force && !confirmLeave()) return;
  originalId = null;
  fillForm({});
}

/* ---------- 對話框：快速貼上、匯入、匯出 ---------- */
function dialog(title, hint, content, actions) {
  $('#dlgTitle').textContent = title;
  $('#dlgHint').textContent = hint;
  $('#dlgContent').replaceChildren(content);
  $('#dlgActions').replaceChildren(...actions, el('button', { class: 'btn', value: 'cancel' }, '關閉'));
  $('#dlg').showModal();
}

/* 快速貼上：切句與配對由伺服器處理（editor.py 的 paste_pairs），這裡只顯示句數和套用結果 */
function quickPaste() {
  const src = el('textarea', { class: 'input', rows: 8, placeholder: '貼上整篇原文。空一行代表換段；詩詞請一行一句。' });
  const tr = el('textarea', { class: 'input', rows: 8, placeholder: '貼上整篇語譯，段落與原文對應，空一行換段。' });
  const info = el('p', { class: 'hint' });
  const split = () => api('/api/split', { source: src.value, translation: tr.value, verse: isVerse() });
  const preview = debounce(async () => {
    const r = await split();
    if (!r.ok) return (info.textContent = r.errors.join('；'));
    const differ = r.srcSentences && r.trSentences && r.srcSentences !== r.trSentences;
    info.textContent = `原文 ${r.srcBlocks} 段 ${r.srcSentences} 句；語譯 ${r.trBlocks} 段 ${r.trSentences} 句。` +
      (differ ? '句數不同：會依順序配對，多出來的放在最後，請在表格中調整。' : '');
  }, 200);
  src.addEventListener('input', preview); tr.addEventListener('input', preview);
  dialog('快速貼上整篇', '依句號、問號、驚嘆號自動切句並配對。貼上後會取代目前的「原文與語譯」。',
    el('div', { class: 'pair-grid' }, src, tr), [
      info,
      el('button', { class: 'btn primary', value: 'ok', onclick: async e => {
        e.preventDefault();
        const r = await split();
        if (!r.ok) return (info.textContent = r.errors.join('；'));
        if (!r.blocks.length) return (info.textContent = '請先貼上原文。');
        $('#dlg').close();
        $('#blocks').replaceChildren(...r.blocks.map(blockCard));
        changed();
      } }, '套用')]);
}

function importDraft() {
  const ta = el('textarea', { class: 'input', rows: 16, placeholder: '貼上稿件內容（格式見 templates/作品稿件範本.txt）' });
  dialog('匯入稿件', '貼上用文字寫好的稿件，會填入表單，確認後再按「儲存」。', ta, [
    el('button', { class: 'btn primary', value: 'ok', onclick: async e => {
      e.preventDefault();
      const res = await api('/api/import', { text: ta.value });
      $('#dlg').close();
      if (!res.ok) return showReport(res);
      const exists = !!poemById(res.poem.id);
      originalId = exists ? res.poem.id : null;
      fillForm(res.poem, DATA.authors[res.poem.author] ? null : (res.author || {}));
      markDirty();
      toast(exists ? '已匯入，將取代同代號的作品' : '已匯入，請檢查後儲存');
    } }, '匯入')]);
}

async function exportDraft() {
  const res = await api('/api/export?id=' + encodeURIComponent(originalId));
  if (res.errors) return showReport(res);
  const ta = el('textarea', { class: 'input', rows: 18, readonly: true, value: res.text });
  dialog('匯出稿件', '可以複製或下載成文字檔保存。', ta, [
    el('button', { type: 'button', class: 'btn', onclick: () => { navigator.clipboard.writeText(ta.value); toast('已複製'); } }, '複製'),
    el('button', { type: 'button', class: 'btn primary', onclick: () => {
      const a = el('a', { href: URL.createObjectURL(new Blob([ta.value], { type: 'text/plain;charset=utf-8' })), download: `${originalId}.txt` });
      a.click(); URL.revokeObjectURL(a.href);
    } }, '下載')]);
}

/* ---------- 啟動 ---------- */
(async function start() {
  if (!(await reload())) return;
  $('#listSearch').addEventListener('input', renderList);
  $('#orderBtn').addEventListener('click', () => setOrderMode(true));
  $('#orderCancel').addEventListener('click', () => setOrderMode(false));
  $('#orderSave').addEventListener('click', saveOrder);
  $('#newBtn').addEventListener('click', () => newWork());
  $('#importBtn').addEventListener('click', importDraft);
  $('#helpBtn').addEventListener('click', () => $('#helpDlg').showModal());
  $('#addBlock').addEventListener('click', () => addRow($('#blocks'), blockCard()));
  $('#pasteBtn').addEventListener('click', quickPaste);
  $('#addNote').addEventListener('click', () => addRow($('#notes'), noteRow(), '.n-term'));
  $('#checkBtn').addEventListener('click', check);
  $('#saveBtn').addEventListener('click', save);
  $('#deleteBtn').addEventListener('click', remove);
  $('#exportBtn').addEventListener('click', exportDraft);
  $('#previewBtn').addEventListener('click', () => window.open(`/site/#/poem/${originalId}`, '_blank', 'noopener'));
  $('#p-has').addEventListener('change', () => { $('#p-fields').hidden = !$('#p-has').checked; updateNoteStatus(); });
  $('#f-type').addEventListener('change', renumber);
  $('#f-title').addEventListener('input', updateNoteStatus);
  $('#p-src').addEventListener('input', updateNoteStatus);
  $('#a-select').addEventListener('change', e => fillAuthor(e.target.value));
  $('#form').addEventListener('input', markDirty);   // 表單裡的打字、勾選、下拉選單都會觸發 input
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
