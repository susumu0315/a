/* resqmej 受注・発注管理
 * データの流れ：受注（お客様発注No.・自社受注No.）→ 発注書（発注No.）→ 納品書（納品書No.）
 * すべての書類は「自社受注」を軸に紐付けられます。
 * Google Apps Script から配信されたときはスプレッドシートに、ファイルを直接開いたときはブラウザ（localStorage）に保存します。
 */
'use strict';

const APP_TITLE = 'resqmej 受注・発注管理';
const STORE_KEY = 'resqmej-data-v1';
const REMOTE = typeof google !== 'undefined' && !!google.script?.run;
const LOGO_SRC = 'img/logo.png'; // Apps Script 用のビルドでは data URI に置き換わる
const KIND_LABEL = { customer: '顧客', supplier: '仕入先', both: '顧客・仕入先' };
// 発注書・納品書の状態：下書き → 発行済（内容を確定）→ 取消（削除せずに残す）
const DOC_STATE = { draft: { label: '下書き', cls: 'st-new' }, issued: { label: '発行済', cls: 'st-done' }, void: { label: '取消', cls: 'st-ng' } };
const stateOf = d => d.status || 'draft';
const isLive = d => stateOf(d) !== 'void';
const BILLING = { 未処理: 'st-new', 発行済: 'st-po', 送付済: 'st-partial', 入金確認済: 'st-done' };
const JUDGE = { OK: 'st-done', 要発注: 'st-new', 在庫不足: 'st-ng' };
const STATUS = {
  new: { label: '未発注', cls: 'st-new' },
  po: { label: '発注済・納品待ち', cls: 'st-po' },
  partial: { label: '一部納品', cls: 'st-partial' },
  done: { label: '納品完了', cls: 'st-done' },
};

// ---------- utilities ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const toNum = v => (v === '' || v == null || isNaN(Number(v)) ? 0 : Number(v));
const num = v => toNum(v).toLocaleString('ja-JP', { maximumFractionDigits: 2 });
const yen = v => '¥' + Math.round(toNum(v)).toLocaleString('ja-JP');
const clone = o => JSON.parse(JSON.stringify(o));

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const today = () => ymd(new Date());
function addDays(s, n) { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); }
function daysUntil(s) { return Math.round((new Date(s + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000); }
function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-');
  return `${y}年${+m}月${+d}日`;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' is-error' : '');
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function download(filename, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- data ----------
// 自社情報の初期値（見積書雛形の差出人欄より）
const COMPANY_DEFAULT = {
  name: 'ミカド電子株式会社', dept: '防災事業部', zip: '366-0052', address: '埼玉県深谷市上柴町西1-21-13',
  tel: '048-573-6200', fax: '', email: '', invoiceNo: '', person: '',
};
const SAMPLE_COMPANY_NAME = '株式会社サンプル商事';

// 取引先の初期値（見積書雛形・防災品受注管理表より）
const PARTNERS_DEFAULT = [
  '株式会社ボウエキ', '株式会社ジーエム', '相日防災株式会社', '株式会社三和製作所',
  '株式会社ライズ', '久下小学校', 'くらし企画', 'SIAソリューション',
].map(name => ({ name, kind: 'customer', honorific: '御中', zip: '', address: '', tel: '', contact: '' }));

// 商品・色マスタの初期値（色は防災品受注管理表のマスタより）
const PRODUCTS_DEFAULT = [{ name: 'レスキューミー', unit: '個', price: 1250, useColor: true }];
const COLORS_DEFAULT = ['イエロー', 'レッド', 'ブラック', 'オレンジ', 'ブルー', 'グリーン', 'ピンク', 'ホワイト', 'アーミーグリーン', '蓄光イエロー', 'アソート'];
const STAFF_DEFAULT = ['瀬山', '小林', '小澤'];

function defaultData() {
  return {
    version: 5,
    settings: {
      company: { ...COMPANY_DEFAULT },
      showLogo: true,
      paymentTerms: '月末締め翌月末現金振込',
      taxRate: 10,
      prefix: { order: 'JO', po: 'PO', dn: 'DN', inv: 'IV', rc: 'RC' },
      dueWarnDays: 3, // 納期まで何日以内で警告するか
      bankAccount: '', // 請求書に印字する振込先
      receiptFor: '防災用品代として', // 領収書の但し書き
    },
    partners: PARTNERS_DEFAULT.map(p => ({ id: uid(), ...p })),
    products: PRODUCTS_DEFAULT.map(p => ({ id: uid(), ...p })),
    colors: [...COLORS_DEFAULT],
    staff: [...STAFF_DEFAULT],
    stock: { opening: {}, reorder: {} }, // 色ごとの期首在庫・発注点
    orders: [],
    pos: [],
    deliveries: [],
    receipts: [], // 入庫記録
    prospects: [], // 見込み案件
    logs: [], // 書類の発行・取消の操作履歴
  };
}

function normalize(d) {
  const def = defaultData();
  const s = d.settings || {};
  let company = { ...def.settings.company, ...(s.company || {}) };
  // 旧版で自社情報が未登録（またはサンプルのまま）なら初期値の自社情報に置き換える
  if ((d.version || 1) < 2 && (!company.name || company.name === SAMPLE_COMPANY_NAME)) company = { ...COMPANY_DEFAULT };
  // 旧版のデータには、まだ登録されていない初期の取引先だけを追加する
  const partners = d.partners || [];
  if ((d.version || 1) < 3) {
    PARTNERS_DEFAULT.forEach(p => { if (!partners.some(x => x.name === p.name)) partners.push({ id: uid(), ...p }); });
  }
  const colors = d.colors || def.colors;
  if ((d.version || 1) < 5 && !colors.includes('アソート')) colors.push('アソート');
  return {
    ...def,
    ...d,
    partners,
    products: d.products || def.products,
    colors,
    staff: d.staff || def.staff,
    stock: { opening: {}, reorder: {}, ...(d.stock || {}) },
    version: def.version,
    settings: {
      ...def.settings,
      ...s,
      company,
      prefix: { ...def.settings.prefix, ...(s.prefix || {}) },
    },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (e) {
    console.error(e);
  }
  return defaultData();
}

let db = REMOTE ? defaultData() : load();

// ---------- スプレッドシートとの同期（Apps Script 配信時のみ） ----------
// レコードを持つ一覧と、1 件だけの設定値。スプレッドシートではそれぞれ 1 シートになる
const COLLS = ['partners', 'products', 'orders', 'pos', 'deliveries', 'receipts', 'prospects', 'logs'];
const CONFIG_KEYS = ['version', 'settings', 'colors', 'staff', 'stock'];
let synced = {}; // 最後にサーバーと一致していた内容 { 一覧: { id: JSON } }
let revs = {}; // サーバー側の版 { 一覧: { id: rev } }。他の人の更新との衝突検知に使う
let saveQueue = Promise.resolve();
let pending = 0;
let generation = 0;
let currentUser = '';

const callServer = (fn, arg) => new Promise((resolve, reject) => {
  google.script.run
    .withSuccessHandler(r => resolve(JSON.parse(r)))
    .withFailureHandler(reject)[fn](JSON.stringify(arg ?? null));
});

function snapshot(d) {
  const out = { config: {} };
  CONFIG_KEYS.forEach(k => { if (d[k] !== undefined) out.config[k] = JSON.stringify(d[k]); });
  COLLS.forEach(c => { out[c] = Object.fromEntries((d[c] || []).map(r => [r.id, JSON.stringify(r)])); });
  return out;
}

// スプレッドシートで見たときに内容がわかるように付ける説明
function recordLabel(coll, id, r) {
  const items = r.items ? r.items.map(it => `${it.name}${it.spec ? `（${it.spec}）` : ''}×${it.qty}`).join('、') : '';
  switch (coll) {
    case 'orders': return `${r.orderNo}｜${r.orderDate}｜${partnerName(r.customerId)}｜${items}`;
    case 'pos': return `${r.poNo || '下書き'}｜${DOC_STATE[stateOf(r)].label}｜${r.poDate}｜${partnerName(r.supplierId)}｜${items}`;
    case 'deliveries': return `${r.dnNo || '下書き'}｜${DOC_STATE[stateOf(r)].label}｜${r.deliveryDate}｜${partnerName(getOrder(r.orderId)?.customerId)}｜${items}`;
    case 'logs': return `${r.at}｜${r.action}｜${DOC_TITLE[r.docType] || ''} ${r.no}｜${r.by}${r.reason ? '｜' + r.reason : ''}`;
    case 'receipts': return `${r.date}｜${r.color}｜${r.qty}`;
    case 'prospects': return `${r.date}｜${r.company}｜${r.product}｜${r.color || ''}×${r.qty}`;
    case 'config': return id;
    default: return r.name || id;
  }
}

function setSync(text) {
  const el = $('#sync');
  if (el) el.textContent = text ?? (pending ? '保存中…' : `✓ 保存済み${currentUser ? '（' + currentUser + '）' : ''}`);
}

function save() {
  if (!REMOTE) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(db));
    } catch (e) {
      alert('保存に失敗しました：' + e.message);
    }
    return;
  }
  // 前回から変わったレコードだけをサーバーへ送る
  const cur = snapshot(db);
  const ops = [];
  Object.entries(cur).forEach(([coll, recs]) => Object.entries(recs).forEach(([id, json]) => {
    if (synced[coll]?.[id] !== json) ops.push({ coll, id, data: JSON.parse(json), label: recordLabel(coll, id, JSON.parse(json)) });
  }));
  Object.entries(synced).forEach(([coll, recs]) => Object.keys(recs).forEach(id => {
    if (!(id in (cur[coll] || {}))) ops.push({ coll, id, del: true });
  }));
  synced = cur;
  if (ops.length) pushOps(ops);
}

function pushOps(ops) {
  const gen = generation;
  pending++;
  setSync();
  saveQueue = saveQueue.then(async () => {
    if (gen !== generation) return; // 読み込み直した後は古い変更を送らない
    ops.forEach(op => { op.baseRev = revs[op.coll]?.[op.id] || ''; });
    const res = await callServer('apiSave', { ops });
    if (!res.ok) throw new Error(res.message);
    res.revs.forEach(({ coll, id, rev }) => {
      revs[coll] = revs[coll] || {};
      if (rev) revs[coll][id] = rev;
      else delete revs[coll][id];
    });
  }).catch(async err => {
    alert(`保存できませんでした。\n${err.message || err}\n\n最新の内容を読み込み直します。`);
    try { await reload(); } catch (e) { console.error(e); }
    route();
  }).finally(() => {
    pending--;
    setSync();
  });
}

async function reload() {
  const res = await callServer('apiLoad');
  generation++;
  currentUser = res.user || '';
  revs = {};
  const raw = {};
  Object.entries(res.data).forEach(([coll, list]) => {
    revs[coll] = Object.fromEntries(list.map(r => [r.id, r.rev]));
    if (coll === 'config') list.forEach(r => { raw[r.id] = r.data; });
    else raw[coll] = list.map(r => r.data);
  });
  const empty = !res.data.config?.length;
  synced = empty ? {} : snapshot(raw);
  db = empty ? defaultData() : normalize(clone(raw));
  migrateIssued();
  save(); // 空のスプレッドシートには初期データを、旧版のデータには移行結果を書き込む
  setSync();
}

// バックアップからの復元・全削除：スプレッドシートの内容をまるごと置き換える
async function replaceAll(next) {
  if (!REMOTE) {
    db = next;
    migrateIssued();
    save();
    return;
  }
  await saveQueue;
  const data = {};
  Object.entries(snapshot(next)).forEach(([coll, recs]) => {
    data[coll] = Object.entries(recs).map(([id, json]) => ({ id, data: JSON.parse(json), label: '' }));
  });
  db = next; // 説明文の取引先名を引けるように先に差し替える
  Object.entries(data).forEach(([coll, list]) => list.forEach(r => { r.label = recordLabel(coll, r.id, r.data); }));
  const res = await callServer('apiReplaceAll', { data });
  if (!res.ok) throw new Error(res.message);
  await reload();
}

// 他の人の変更を取り込む（入力中の画面では行わない）
async function refreshIfIdle() {
  if (!REMOTE || pending || document.hidden) return;
  if (/[/?](new|edit)\b|^#\/(masters|settings)/.test(location.hash) || document.activeElement?.matches('input, textarea, select')) return;
  const before = JSON.stringify(snapshot(db));
  try { await reload(); } catch (e) { return console.error(e); }
  if (JSON.stringify(snapshot(db)) !== before) {
    const y = window.scrollY;
    route();
    window.scrollTo(0, y);
  }
}

const NO_FIELD = { order: 'orderNo', po: 'poNo', dn: 'dnNo' };
const listOf = kind => ({ order: db.orders, po: db.pos, dn: db.deliveries }[kind]);

// 「接頭辞-西暦-連番」で次の番号を採番（例：JO-2026-0001）
function nextNo(kind) {
  const prefix = db.settings.prefix[kind] || kind.toUpperCase();
  const year = new Date().getFullYear();
  const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-' + year + '-(\\d+)$');
  let max = 0;
  listOf(kind).forEach(x => {
    const m = re.exec(x[NO_FIELD[kind]]);
    if (m) max = Math.max(max, +m[1]);
  });
  return `${prefix}-${year}-${String(max + 1).padStart(4, '0')}`;
}

const getOrder = id => db.orders.find(o => o.id === id);
const getPo = id => db.pos.find(p => p.id === id);
const getDn = id => db.deliveries.find(d => d.id === id);
const getPartner = id => db.partners.find(p => p.id === id);
const partnerName = id => getPartner(id)?.name || '（未設定）';
const posOf = orderId => db.pos.filter(p => p.orderId === orderId).sort(byField('poNo'));
const dnsOf = orderId => db.deliveries.filter(d => d.orderId === orderId).sort(byField('dnNo'));

function byField(f, desc = false) {
  return (a, b) => (desc ? -1 : 1) * String(a[f] || '').localeCompare(String(b[f] || ''), 'ja', { numeric: true });
}
function byDateNoDesc(dateF, noF) {
  return (a, b) => String(b[dateF] || '').localeCompare(String(a[dateF] || '')) || byField(noF, true)(a, b);
}

const lineAmount = it => Math.round(toNum(it.qty) * toNum(it.price));
function calc(doc) {
  const sub = (doc.items || []).reduce((s, it) => s + lineAmount(it), 0);
  const rate = doc.taxRate ?? db.settings.taxRate;
  const tax = Math.floor(sub * toNum(rate) / 100);
  return { sub, tax, total: sub + tax, rate };
}

// 受注明細ごとの納品済数量 { 明細id: 数量 }
function deliveredMap(orderId, excludeDnId) {
  const map = {};
  dnsOf(orderId).forEach(d => {
    if (d.id === excludeDnId || !isLive(d)) return;
    d.items.forEach(it => { if (it.ref) map[it.ref] = (map[it.ref] || 0) + toNum(it.qty); });
  });
  return map;
}

function orderStatus(o) {
  const items = o.items.filter(it => toNum(it.qty) > 0);
  const dmap = deliveredMap(o.id);
  const any = Object.values(dmap).some(v => v > 0);
  const all = items.length > 0 && items.every(it => (dmap[it.id] || 0) >= toNum(it.qty));
  const key = all ? 'done' : any ? 'partial' : posOf(o.id).some(isLive) ? 'po' : 'new';
  return { key, ...STATUS[key] };
}

// 回答納期があればそれを、なければ希望納期を納期として扱う
const dueOf = o => o.answerDate || o.dueDate || '';
const billingBadge = b => (b ? `<span class="badge ${BILLING[b] || ''}">${esc(b)}</span>` : '<span class="muted">—</span>');
const leftText = n => (n < 0 ? `${-n}日超過` : n === 0 ? '本日' : `あと${n}日`);

// 納期が近い（または過ぎた）未完了の受注と、その受注のための発注書
function dueAlerts() {
  const days = toNum(db.settings.dueWarnDays);
  const list = [];
  const open = new Map(db.orders.map(o => [o.id, orderStatus(o).key !== 'done']));
  db.orders.forEach(o => {
    const due = dueOf(o);
    if (!due || !open.get(o.id) || daysUntil(due) > days) return;
    list.push({ kind: '受注', cls: 'is-order', no: o.orderNo, name: partnerName(o.customerId), what: itemsSummary(o.items), due, left: daysUntil(due), href: `#/orders/${o.id}` });
  });
  db.pos.forEach(p => {
    if (!p.dueDate || !isLive(p) || !open.get(p.orderId) || daysUntil(p.dueDate) > days) return;
    list.push({ kind: '発注書', cls: 'is-po', no: p.poNo || '下書き', name: partnerName(p.supplierId), what: '仕入先からの納期', due: p.dueDate, left: daysUntil(p.dueDate), href: `#/pos/${p.id}` });
  });
  return list.sort((a, b) => a.left - b.left);
}

function dueAlertsListHTML(list) {
  return `<ul class="alert-list">${list.map(x => `<li><a href="${x.href}">
    <span class="badge ${x.left < 0 ? 'st-ng' : 'st-new'}">${x.left < 0 ? '超過' : '間近'}</span>
    <span class="muted">${x.kind}</span> ${tag(x.no, x.cls)} <b>${esc(x.name)}</b> <span class="muted">${esc(x.what)}</span>
    <span class="due-soon">${esc(x.due)}（${leftText(x.left)}）</span></a></li>`).join('')}</ul>`;
}

// 画面上部の警告（どの画面にも表示）
let alertOpen = false;
function renderAlerts() {
  const el = $('#alerts');
  if (!el) return;
  const list = dueAlerts();
  const over = list.filter(x => x.left < 0).length;
  el.innerHTML = list.length ? `<details class="alert-bar" ${alertOpen ? 'open' : ''}>
    <summary>⚠ 納期が近い・過ぎている案件が <b>${list.length} 件</b> あります${over ? `（うち <b>${over} 件は納期超過</b>）` : ''}
      <span class="muted">納期まで ${num(db.settings.dueWarnDays)} 日以内 ／ 押すと一覧を表示</span></summary>
    ${dueAlertsListHTML(list)}</details>` : '';
  $('details', el)?.addEventListener('toggle', e => { alertOpen = e.target.open; });
}

// 起動したときに 1 日 1 回、納期の警告をポップアップで表示する
function popupAlerts() {
  const list = dueAlerts();
  if (!list.length) return;
  const key = 'resqmej-due-alert-' + today();
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch (e) { /* 保存できない環境では毎回表示する */ }
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog alert-dialog';
  dlg.innerHTML = `<h2>⚠ 納期の確認</h2>
    <p>納期が近い（${num(db.settings.dueWarnDays)} 日以内）、または過ぎている案件が <b>${list.length} 件</b> あります。</p>
    ${dueAlertsListHTML(list)}
    <div class="dialog-actions"><button class="btn btn-primary" type="button">確認しました</button></div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('click', e => { if (e.target.closest('a, button')) dlg.close(); });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
}

// 請求書・領収書は納品書 1 件ごとに発行する。番号は納品書の番号の頭文字を変えたもの（DN-2026-0001 → IV-2026-0001）
function relatedNo(d, kind) {
  const m = /^[^-]+-(.+)$/.exec(d.dnNo || '');
  return `${db.settings.prefix[kind]}-${m ? m[1] : d.dnNo}`;
}
function endOfNextMonth(s) {
  if (!s) return '';
  const d = new Date(s + 'T00:00:00');
  return ymd(new Date(d.getFullYear(), d.getMonth() + 2, 0));
}
const invoiceInfo = d => {
  const date = d.invoiceDate || d.deliveryDate;
  return { no: relatedNo(d, 'inv'), date, payDue: d.payDue || endOfNextMonth(date) };
};
const receiptInfo = d => ({ no: relatedNo(d, 'rc'), date: d.receiptDate || d.deliveryDate, for: d.receiptFor || db.settings.receiptFor });

// 色別在庫：現在庫＝期首在庫＋入庫累計－出荷済（納品書）／有効在庫＝現在庫－引当（受注のうち未納品の数量）
function stockRows(excludeDnId) {
  const z = () => ({ received: 0, shipped: 0, allocated: 0 });
  const map = {};
  const at = c => (map[c] = map[c] || z());
  db.colors.forEach(at);
  db.receipts.forEach(r => { at(r.color).received += toNum(r.qty); });
  db.deliveries.forEach(d => {
    if (d.id === excludeDnId || !isLive(d)) return;
    d.items.forEach(it => { if (it.spec) at(it.spec).shipped += toNum(it.qty); });
  });
  db.orders.forEach(o => {
    const dmap = deliveredMap(o.id, excludeDnId);
    o.items.forEach(it => {
      const rest = toNum(it.qty) - (dmap[it.id] || 0);
      if (it.spec && rest > 0) at(it.spec).allocated += rest;
    });
  });
  Object.keys(db.stock.opening).forEach(at);
  return Object.entries(map).map(([color, v]) => {
    const opening = toNum(db.stock.opening[color]);
    const reorder = toNum(db.stock.reorder[color]);
    const current = opening + v.received - v.shipped;
    const available = current - v.allocated;
    const judge = available < 0 ? '在庫不足' : available <= reorder ? '要発注' : 'OK';
    return { color, opening, ...v, current, available, reorder, judge };
  });
}

const badge = st => `<span class="badge ${st.cls}">${st.label}</span>`;
const tag = (no, cls) => (no ? `<span class="no-tag ${cls}">${esc(no)}</span>` : '<span class="muted">—</span>');
const findProduct = name => db.products.find(p => p.name === name);

// 新しい明細行。品名はマスタの先頭の商品（レスキューミー）を初期選択する
function blankItem(withPrice = false) {
  const p = db.products[0];
  return { id: uid(), name: p?.name || '', spec: '', qty: 1, unit: p?.unit || '個', price: withPrice && p ? p.price : '' };
}

// 色を使う商品で色が未選択の行があればエラーメッセージを返す
function itemsError(items) {
  const i = items.findIndex(it => findProduct(it.name)?.useColor && !it.spec);
  return i < 0 ? '' : `${i + 1}行目の色を選択してください`;
}

function productOptions(selected) {
  const names = db.products.map(p => p.name);
  if (selected && !names.includes(selected)) names.push(selected);
  return (selected ? '' : '<option value="">— 品名を選択 —</option>') +
    names.map(n => `<option ${n === selected ? 'selected' : ''}>${esc(n)}</option>`).join('');
}

function colorOptions(selected) {
  const list = [...db.colors];
  if (selected && !list.includes(selected)) list.push(selected);
  return '<option value="">— 色を選択 —</option>' +
    list.map(c => `<option ${c === selected ? 'selected' : ''}>${esc(c)}</option>`).join('');
}

function cleanItems(items) {
  return items
    .filter(it => String(it.name || '').trim())
    .map(it => ({ ...it, name: it.name.trim(), spec: (it.spec || '').trim(), qty: toNum(it.qty), price: it.price === '' ? '' : toNum(it.price) }));
}

// 受注明細のうち、まだ納品していない分を納品書の明細にする
function remainingItems(order, excludeDnId) {
  const dmap = deliveredMap(order.id, excludeDnId);
  return order.items
    .map(it => ({ it, rest: toNum(it.qty) - (dmap[it.id] || 0) }))
    .filter(x => x.rest > 0)
    .map(({ it, rest }) => ({ id: uid(), ref: it.id, name: it.name, spec: it.spec, qty: rest, unit: it.unit, price: it.price }));
}

// ---------- routing ----------
const routes = [
  [/^\/$/, viewDashboard],
  [/^\/orders$/, (m, q) => viewOrderList(q)],
  [/^\/orders\/new$/, (m, q) => viewOrderForm(null, q.get('customer'), q.get('prospect'))],
  [/^\/orders\/([^/]+)\/edit$/, m => viewOrderForm(m[1])],
  [/^\/orders\/([^/]+)$/, m => viewOrderDetail(m[1])],
  [/^\/pos$/, () => viewDocList('po')],
  [/^\/pos\/new$/, (m, q) => viewPoForm(null, q.get('order'), q.get('supplier'))],
  [/^\/pos\/([^/]+)\/edit$/, m => viewPoForm(m[1])],
  [/^\/pos\/([^/]+)$/, m => viewDocDetail('po', m[1])],
  [/^\/deliveries$/, () => viewDocList('dn')],
  [/^\/deliveries\/new$/, (m, q) => viewDnForm(null, q.get('order'))],
  [/^\/deliveries\/([^/]+)\/edit$/, m => viewDnForm(m[1])],
  [/^\/deliveries\/([^/]+)\/set$/, m => viewDocSet(m[1])],
  [/^\/deliveries\/([^/]+)\/(inv|rc)\/(\d+)$/, m => viewSubDoc(m[1], m[2], m[3])],
  [/^\/deliveries\/([^/]+)$/, m => viewDocDetail('dn', m[1])],
  [/^\/partners$/, viewPartners],
  [/^\/partners\/([^/]+)$/, m => viewPartnerDetail(m[1])],
  [/^\/stock$/, viewStock],
  [/^\/prospects$/, (m, q) => viewProspects(q.get('edit'))],
  [/^\/masters$/, viewMasters],
  [/^\/settings$/, viewSettings],
  [/^\/search$/, (m, q) => viewSearch(q.get('q') || '')],
];

function route() {
  const h = location.hash.slice(1) || '/';
  const i = h.indexOf('?');
  const path = i < 0 ? h : h.slice(0, i);
  const q = new URLSearchParams(i < 0 ? '' : h.slice(i + 1));
  document.title = APP_TITLE;
  const section = path.split('/')[1] || 'home';
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === section));
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      fn(m, q);
      renderAlerts();
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = '#/';
}

const render = html => { $('#view').innerHTML = html; };
const go = hash => { location.hash = hash; };

function notFound() {
  render(`<div class="card empty">データが見つかりませんでした。<br><a class="btn" href="#/">ホームへ戻る</a></div>`);
}

// ---------- shared UI ----------
function partnerOptions(kind, selected) {
  const main = [];
  const other = [];
  [...db.partners].sort(byField('name')).forEach(p => (p.kind === kind || p.kind === 'both' ? main : other).push(p));
  const opts = list => list.map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  return `<option value="">— 選択してください —</option>` +
    (other.length ? `<optgroup label="${KIND_LABEL[kind]}">${opts(main)}</optgroup><optgroup label="その他の取引先">${opts(other)}</optgroup>` : opts(main));
}

// 顧客として登録した取引先を仕入先に使った（またはその逆）場合は「両方」に切り替える
function linkPartnerKind(id, kind) {
  const p = getPartner(id);
  if (p && p.kind !== kind && p.kind !== 'both') p.kind = 'both';
}

const partnerLink = id => (getPartner(id) ? `<a href="#/partners/${id}">${esc(partnerName(id))}</a>` : esc(partnerName(id)));

function orderOptions(selected, emptyLabel) {
  const list = [...db.orders].sort(byDateNoDesc('orderDate', 'orderNo'));
  return `<option value="">${emptyLabel}</option>` +
    list.map(o => `<option value="${o.id}" ${o.id === selected ? 'selected' : ''}>${esc(o.orderNo)}｜${esc(partnerName(o.customerId))}${o.subject ? '｜' + esc(o.subject) : ''}</option>`).join('');
}

function partnerSelectField(name, label, kind, selected) {
  return `<div class="field">
    <label>${label} <span class="req">必須</span></label>
    <div class="with-btn">
      <select name="${name}">${partnerOptions(kind, selected)}</select>
      <button type="button" class="btn btn-sm" data-new-partner="${kind}" data-target="${name}">＋ 新規</button>
    </div>
  </div>`;
}

function bindPartnerButtons(form) {
  $$('[data-new-partner]', form).forEach(btn => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.newPartner;
      const p = await openPartnerDialog(null, kind);
      if (p) form.elements[btn.dataset.target].innerHTML = partnerOptions(kind, p.id);
    });
  });
}

function openPartnerDialog(partner, kind) {
  return new Promise(resolve => {
    const dlg = $('#partner-dialog');
    const form = $('#partner-form');
    form.reset();
    const data = partner || { kind: kind || 'customer', honorific: '御中' };
    for (const el of form.elements) if (el.name && data[el.name] != null) el.value = data[el.name];
    $('#partner-dialog-title').textContent = partner ? '取引先を編集' : '取引先を登録';

    let done = false;
    const finish = v => {
      if (done) return;
      done = true;
      form.onsubmit = null;
      dlg.onclose = null;
      resolve(v);
    };
    form.onsubmit = e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      f.name = f.name.trim();
      if (!f.name) return toast('会社名・氏名を入力してください', 'error');
      let rec;
      if (partner) rec = Object.assign(partner, f);
      else db.partners.push(rec = { id: uid(), ...f });
      save();
      toast('取引先を保存しました');
      finish(rec);
      dlg.close();
    };
    dlg.onclose = () => finish(null);
    $('[data-act=cancel]', form).onclick = () => dlg.close();
    dlg.showModal();
    form.elements.name.focus();
  });
}

// 受注 → 発注書 → 納品書 の紐付けを一目で表示
function chainHTML(o, { currentId, withAdd = true } = {}) {
  const pos = posOf(o.id);
  const dns = dnsOf(o.id);
  const cur = id => (id === currentId ? ' is-current' : '');
  return `<div class="chain">
    <div class="chain-col">
      <div class="chain-label">① 受注（お客様から）</div>
      <a class="chain-card is-order${cur(o.id)}" href="#/orders/${o.id}">
        <b>${esc(o.orderNo)}</b>
        <span>お客様発注No.：${esc(o.customerPoNo || '—')}</span>
        <span>${esc(partnerName(o.customerId))}</span>
      </a>
    </div>
    <div class="chain-arrow">→</div>
    <div class="chain-col">
      <div class="chain-label">② 発注書（仕入先へ）</div>
      ${pos.map(p => `<a class="chain-card is-po${cur(p.id)}${isLive(p) ? '' : ' is-void-card'}" href="#/pos/${p.id}">
          <b>${docTag('po', p)}</b><span>${esc(partnerName(p.supplierId))}</span><span>${fmtDate(p.poDate)}　${yen(calc(p).total)}</span>
        </a>`).join('') || '<div class="chain-empty">発注書はまだありません</div>'}
      ${withAdd ? `<a class="chain-add is-po" href="#/pos/new?order=${o.id}">＋ この受注の発注書を作る</a>` : ''}
    </div>
    <div class="chain-arrow">→</div>
    <div class="chain-col">
      <div class="chain-label">③ 納品書（お客様へ）</div>
      ${dns.map(d => `<a class="chain-card is-dn${cur(d.id)}${isLive(d) ? '' : ' is-void-card'}" href="#/deliveries/${d.id}">
          <b>${docTag('dn', d)}</b><span>納品日：${fmtDate(d.deliveryDate)}</span><span>${yen(calc(d).total)}</span>
        </a>`).join('') || '<div class="chain-empty">納品書はまだありません</div>'}
      ${withAdd && orderStatus(o).key !== 'done' ? `<a class="chain-add is-dn" href="#/deliveries/new?order=${o.id}">＋ この受注の納品書を作る</a>` : ''}
    </div>
  </div>`;
}

// 明細入力（行の追加・削除・金額の自動計算）
function mountItems(root, initialItems, { getRate, refInfo, autoPrice = false } = {}) {
  let items = initialItems;
  root.innerHTML = `
    <div class="items-wrap">
      <table class="items">
        <thead><tr>
          <th class="c-no">No.</th><th class="c-name">品名</th><th class="c-color">色</th>
          <th class="c-qty">数量</th><th class="c-unit">単位</th><th class="c-price">単価（税抜）</th>
          <th class="c-amt">金額</th><th class="c-del"></th>
        </tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="items-foot">
      <button type="button" class="btn btn-ghost" data-act="add-row">＋ 明細行を追加</button>
      <table class="totals"><tbody></tbody></table>
    </div>`;
  const tbody = $('table.items tbody', root);

  const updateTotals = () => {
    const t = calc({ items, taxRate: toNum(getRate ? getRate() : db.settings.taxRate) });
    $('table.totals tbody', root).innerHTML = `
      <tr><th>小計</th><td>${yen(t.sub)}</td></tr>
      <tr><th>消費税（${num(t.rate)}%）</th><td>${yen(t.tax)}</td></tr>
      <tr class="grand"><th>合計（税込）</th><td>${yen(t.total)}</td></tr>`;
  };

  const renderRows = () => {
    tbody.innerHTML = items.map((it, i) => `
      <tr data-i="${i}">
        <td class="c-no">${i + 1}</td>
        <td><select data-f="name">${productOptions(it.name)}</select></td>
        <td>${findProduct(it.name)?.useColor === false && !it.spec
          ? '<span class="muted">—</span>'
          : `<select data-f="spec">${colorOptions(it.spec)}</select>`}</td>
        <td><input data-f="qty" type="number" step="any" min="0" class="num" value="${esc(it.qty)}"></td>
        <td><input data-f="unit" value="${esc(it.unit)}" list="units"></td>
        <td><input data-f="price" type="number" step="any" class="num" value="${esc(it.price)}" placeholder="0"></td>
        <td class="c-amt">${num(lineAmount(it))}</td>
        <td class="c-del"><button type="button" class="icon-btn" data-act="del-row" title="この行を削除">✕</button></td>
      </tr>
      ${refInfo && it.ref ? `<tr class="ref-row" data-ref-for="${i}"><td></td><td colspan="7">${refInfo(it)}</td></tr>` : ''}`).join('');
    updateTotals();
  };

  tbody.addEventListener('input', e => {
    const f = e.target.dataset.f;
    const tr = e.target.closest('tr[data-i]');
    if (!f || !tr) return;
    const i = +tr.dataset.i;
    items[i][f] = e.target.value;
    if (f === 'name') {
      // 品名を変えたらマスタの単位・単価を反映
      const p = findProduct(e.target.value);
      if (p) {
        items[i].unit = p.unit;
        if (autoPrice) items[i].price = p.price;
        if (!p.useColor) items[i].spec = '';
      }
      renderRows();
      return;
    }
    $('.c-amt', tr).textContent = num(lineAmount(items[i]));
    const refRow = $(`tr[data-ref-for="${i}"] td:last-child`, tbody);
    if (refRow && refInfo) refRow.innerHTML = refInfo(items[i]);
    updateTotals();
  });
  root.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add-row') {
      items.push(blankItem(autoPrice));
      renderRows();
      $$('tr[data-i]', tbody).pop().querySelector('[data-f=spec], [data-f=qty]').focus();
    } else if (act === 'del-row') {
      const i = +e.target.closest('tr[data-i]').dataset.i;
      items.splice(i, 1);
      if (!items.length) items.push(blankItem(autoPrice));
      renderRows();
    }
  });

  renderRows();
  return {
    get items() { return items; },
    setItems(next) { items = next.length ? next : [blankItem(autoPrice)]; renderRows(); },
    refresh: renderRows,
    updateTotals,
  };
}

function itemsReadonlyHTML(doc, { progress } = {}) {
  const t = calc(doc);
  const dmap = progress ? deliveredMap(doc.id) : null;
  return `<div class="table-wrap"><table class="list">
    <thead><tr><th>No.</th><th>品名</th><th>色</th><th class="num">数量</th><th>単位</th><th class="num">単価</th><th class="num">金額</th>
      ${progress ? '<th class="num">納品済</th><th class="num">残</th><th></th>' : ''}</tr></thead>
    <tbody>${doc.items.map((it, i) => {
      const done = dmap ? dmap[it.id] || 0 : 0;
      const rate = toNum(it.qty) ? Math.min(100, done / toNum(it.qty) * 100) : 0;
      return `<tr><td>${i + 1}</td><td>${esc(it.name)}</td><td>${esc(it.spec)}</td><td class="num">${num(it.qty)}</td><td>${esc(it.unit)}</td>
        <td class="num">${it.price === '' ? '' : num(it.price)}</td><td class="num">${num(lineAmount(it))}</td>
        ${progress ? `<td class="num">${num(done)}</td><td class="num">${num(Math.max(0, toNum(it.qty) - done))}</td>
          <td><div class="progress"><span style="width:${rate}%"></span></div></td>` : ''}</tr>`;
    }).join('')}</tbody>
  </table></div>
  <div class="items-foot"><span></span><table class="totals"><tbody>
    <tr><th>小計</th><td>${yen(t.sub)}</td></tr>
    <tr><th>消費税（${num(t.rate)}%）</th><td>${yen(t.tax)}</td></tr>
    <tr class="grand"><th>合計（税込）</th><td>${yen(t.total)}</td></tr>
  </tbody></table></div>`;
}

function bindListFilter(root, extra) {
  const input = $('[data-filter]', root);
  const sel = $('[data-status-filter]', root);
  const billSel = $('[data-billing-filter]', root);
  const showVoid = $('[data-show-void]', root);
  const apply = () => {
    const q = (input?.value || '').trim().toLowerCase();
    const st = sel?.value || '';
    const bill = billSel?.value || '';
    let shown = 0;
    $$('tbody tr[data-search]', root).forEach(tr => {
      const stOk = !st || (st === 'open' ? tr.dataset.status !== 'done' : tr.dataset.status === st);
      const billOk = !bill || tr.dataset.billing === bill;
      const voidOk = !tr.dataset.void || !showVoid || showVoid.checked;
      const ok = (!q || tr.dataset.search.toLowerCase().includes(q)) && stOk && billOk && voidOk;
      tr.hidden = !ok;
      if (ok) shown++;
    });
    const cnt = $('[data-count]', root);
    if (cnt) cnt.textContent = `${shown} 件`;
  };
  input?.addEventListener('input', apply);
  sel?.addEventListener('change', apply);
  billSel?.addEventListener('change', apply);
  showVoid?.addEventListener('change', apply);
  $$('tr.clickable', root).forEach(tr => tr.addEventListener('click', e => {
    if (!e.target.closest('a,button')) go(tr.dataset.href);
  }));
  if (extra) extra();
  apply();
}

// ---------- ホーム ----------
function viewDashboard() {
  const c = db.settings.company;
  const sts = db.orders.map(o => ({ o, st: orderStatus(o) }));
  const open = sts.filter(x => x.st.key !== 'done');
  const noPo = sts.filter(x => x.st.key === 'new');
  const ym = today().slice(0, 7);
  const month = db.orders.filter(o => (o.orderDate || '').startsWith(ym));
  const monthTotal = month.reduce((s, o) => s + calc(o).total, 0);
  const days = toNum(db.settings.dueWarnDays);
  const soon = open.filter(x => dueOf(x.o) && daysUntil(dueOf(x.o)) <= days)
    .sort((a, b) => dueOf(a.o).localeCompare(dueOf(b.o)));
  const lowStock = stockRows().filter(r => r.judge !== 'OK');
  const unbilled = sts.filter(x => x.st.key === 'done' && (x.o.billing || '未処理') === '未処理');

  render(`
    ${!c.name ? `<div class="banner"><span>はじめに <b>自社情報（会社名・住所など）</b> を登録してください。発注書・納品書に印字されます。</span>
      <a class="btn btn-primary btn-sm" href="#/settings">自社情報を登録する</a></div>` : ''}
    <div class="page-head"><h1>ホーム</h1></div>

    <section class="card">
      <h2>かんたん 3 ステップ</h2>
      <div class="steps">
        <a class="step is-order" href="#/orders/new"><span class="step-num">1</span><b>受注を登録する</b>
          <span>お客様からの注文を登録。お客様の発注No.と自社受注No.を記録します。</span></a>
        <a class="step is-po" href="#/orders?status=new"><span class="step-num">2</span><b>発注書を作る</b>
          <span>受注から仕入先への発注書を作成。自社受注No.が自動で紐付きます。</span></a>
        <a class="step is-dn" href="#/orders?status=open"><span class="step-num">3</span><b>納品書を作る</b>
          <span>受注の残数から納品書を自動作成。PDFで印刷・保存できます。</span></a>
      </div>
    </section>

    <div class="tiles tiles-3">
      <a class="tile" href="#/orders"><div class="tile-label">今月の受注</div><div class="tile-value">${month.length} 件</div><div class="tile-sub">${yen(monthTotal)}（税込）</div></a>
      <a class="tile ${noPo.length ? 'is-alert' : ''}" href="#/orders?status=new"><div class="tile-label">未発注の受注</div><div class="tile-value">${noPo.length} 件</div><div class="tile-sub">発注書がまだの受注</div></a>
      <a class="tile" href="#/orders?status=open"><div class="tile-label">未納品の受注</div><div class="tile-value">${open.length} 件</div><div class="tile-sub">納品が完了していない受注</div></a>
      <a class="tile ${soon.length ? 'is-alert' : ''}" href="#/orders?status=open"><div class="tile-label">納期 ${num(days)} 日以内</div><div class="tile-value">${soon.length} 件</div><div class="tile-sub">納期超過を含む</div></a>
      <a class="tile ${lowStock.length ? 'is-alert' : ''}" href="#/stock"><div class="tile-label">要発注・在庫不足の色</div><div class="tile-value">${lowStock.length} 色</div>
        <div class="tile-sub">${lowStock.length ? lowStock.map(r => esc(r.color)).join('・') : '在庫は足りています'}</div></a>
      <a class="tile ${unbilled.length ? 'is-alert' : ''}" href="#/orders?status=done&billing=未処理"><div class="tile-label">請求書が未処理</div><div class="tile-value">${unbilled.length} 件</div><div class="tile-sub">納品完了の受注のうち</div></a>
    </div>

    <section class="card">
      <h2>納期が近い受注（未納品）</h2>
      ${soon.length ? orderTableHTML(soon.map(x => x.o)) : '<div class="empty">納期が近い未納品の受注はありません。</div>'}
    </section>
    ${!db.orders.length ? `<section class="card empty">まだ受注がありません。<br>
      <a class="btn btn-primary" href="#/orders/new">＋ 最初の受注を登録する</a>
      <button class="btn" data-act="sample">サンプルデータで試してみる</button></section>` : ''}
  `);
  bindListFilter($('#view'));
  $('[data-act=sample]')?.addEventListener('click', loadSample);
}

// ---------- 受注 ----------
function dueHTML(o, st) {
  const due = dueOf(o);
  if (!due) return '<span class="muted">—</span>';
  const d = daysUntil(due);
  const warn = st.key !== 'done' && d <= toNum(db.settings.dueWarnDays);
  return `<span class="${warn ? 'due-soon' : ''}">${warn ? '⚠ ' : ''}${esc(due)}${warn ? `（${leftText(d)}）` : ''}</span>`;
}

// 明細の品名・色・数量を一覧用に短くまとめる
const itemsSummary = items => items.map(it => `${it.spec || it.name} ${num(it.qty)}`).join('、');

function orderTableHTML(orders) {
  return `<div class="table-wrap"><table class="list">
    <thead><tr><th>自社受注No.</th><th>お客様発注No.</th><th>受注日</th><th>お客様</th><th>内容</th><th>納期</th><th>担当</th>
      <th class="num">金額（税込）</th><th>発注書</th><th>納品書</th><th>状況</th><th>請求書</th></tr></thead>
    <tbody>${orders.map(o => {
      const st = orderStatus(o);
      const pos = posOf(o.id);
      const dns = dnsOf(o.id);
      const billing = o.billing || '未処理';
      const search = [o.orderNo, o.customerPoNo, partnerName(o.customerId), o.subject, o.staff, itemsSummary(o.items), ...pos.map(p => p.poNo), ...dns.map(d => d.dnNo)].join(' ');
      return `<tr class="clickable" data-href="#/orders/${o.id}" data-search="${esc(search)}" data-status="${st.key}" data-billing="${esc(billing)}">
        <td>${tag(o.orderNo, 'is-order')}</td><td>${tag(o.customerPoNo, 'is-cust')}</td><td class="nowrap">${esc(o.orderDate)}</td>
        <td class="wide">${partnerLink(o.customerId)}</td>
        <td class="wide">${o.subject ? `<b>${esc(o.subject)}</b><br>` : ''}<span class="muted">${esc(itemsSummary(o.items))}</span></td>
        <td class="nowrap">${dueHTML(o, st)}</td><td class="nowrap">${esc(o.staff) || '<span class="muted">—</span>'}</td>
        <td class="num">${yen(calc(o).total)}</td>
        <td class="nowrap">${pos.filter(isLive).map(p => `<a href="#/pos/${p.id}">${docTag('po', p)}</a>`).join(' ') || '<span class="muted">—</span>'}</td>
        <td class="nowrap">${dns.filter(isLive).map(d => `<a href="#/deliveries/${d.id}">${docTag('dn', d)}</a>`).join(' ') || '<span class="muted">—</span>'}</td>
        <td>${badge(st)}</td><td>${billingBadge(billing)}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function viewOrderList(q) {
  const orders = [...db.orders].sort(byDateNoDesc('orderDate', 'orderNo'));
  const status = q.get('status') || '';
  const billing = q.get('billing') || '';
  render(`
    <div class="page-head">
      <div><div class="crumb">ステップ ①</div><h1>受注一覧</h1></div>
      <div class="actions"><a class="btn btn-primary" href="#/orders/new">＋ 新しい受注を登録</a></div>
    </div>
    <section class="card">
      ${orders.length ? `
      <div class="filters">
        <input type="search" data-filter placeholder="番号・お客様名・色・担当で絞り込み">
        <select data-status-filter>
          <option value="">すべての状況</option>
          <option value="open" ${status === 'open' ? 'selected' : ''}>未納品（完了以外すべて）</option>
          ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${status === k ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select>
        <select data-billing-filter>
          <option value="">請求書：すべて</option>
          ${Object.keys(BILLING).map(b => `<option ${billing === b ? 'selected' : ''}>${b}</option>`).join('')}
        </select>
        <span class="muted" data-count></span>
      </div>
      ${orderTableHTML(orders)}` : `<div class="empty">受注はまだありません。<br><a class="btn btn-primary" href="#/orders/new">＋ 新しい受注を登録</a></div>`}
    </section>`);
  bindListFilter($('#view'));
}

function staffOptions(selected) {
  const list = [...db.staff];
  if (selected && !list.includes(selected)) list.push(selected);
  return '<option value="">— 選択 —</option>' + list.map(s => `<option ${s === selected ? 'selected' : ''}>${esc(s)}</option>`).join('');
}

function viewOrderForm(id, customerParam, prospectParam) {
  const editing = id ? getOrder(id) : null;
  if (id && !editing) return notFound();
  const pr = !editing && prospectParam ? db.prospects.find(x => x.id === prospectParam) : null;
  const o = editing ? clone(editing) : {
    id: uid(), orderNo: nextNo('order'), customerPoNo: '', customerId: getPartner(customerParam) ? customerParam : '', orderDate: today(), dueDate: '',
    answerDate: '', staff: '', billing: '未処理', subject: '', taxRate: db.settings.taxRate, items: [blankItem(true)], note: '',
  };
  if (pr) {
    // 見込み案件から受注にする：会社名が一致する取引先と、品名・色・数量・納期・担当を引き継ぐ
    const p = findProduct(pr.product);
    Object.assign(o, {
      customerId: db.partners.find(x => x.name === pr.company)?.id || '', dueDate: pr.dueDate || '', answerDate: pr.answerDate || '',
      staff: pr.staff || '', note: pr.note || '',
      items: [{ id: uid(), name: pr.product, spec: pr.color || '', qty: toNum(pr.qty), unit: p?.unit || '個', price: p ? p.price : '' }],
    });
  }

  render(`
    <div class="page-head">
      <div><div class="crumb"><a href="#/orders">受注一覧</a> › ${editing ? '編集' : '新規登録'}</div>
        <h1>${editing ? `受注を編集 ${tag(o.orderNo, 'is-order')}` : '新しい受注を登録'}</h1></div>
    </div>
    <form id="doc-form" autocomplete="off">
      <section class="card">
        <h2>番号（紐付けのカギになります）</h2>
        <div class="grid-2">
          <div class="field number-field is-order">
            <label>自社受注No. <span class="req">必須</span></label>
            <input name="orderNo" value="${esc(o.orderNo)}">
            <p class="hint">自動で採番されます。変更もできます。発注書・納品書にもこの番号が入ります。</p>
          </div>
          <div class="field number-field">
            <label>お客様の発注No. <span class="opt">（注文書に記載の番号）</span></label>
            <input name="customerPoNo" value="${esc(o.customerPoNo)}" placeholder="例：PO-12345">
            <p class="hint">納品書に「貴社発注No.」として印字されます。</p>
          </div>
        </div>
      </section>
      ${pr ? `<div class="banner">見込み案件（${esc(pr.date)}｜${esc(pr.company)}）から受注を登録します。${o.customerId ? '' : '<b>お客様を選択（または「＋ 新規」で登録）してください。</b>'}</div>` : ''}
      <section class="card">
        <h2>受注内容</h2>
        <div class="grid-4">
          <div class="span-2">${partnerSelectField('customerId', 'お客様（注文元）', 'customer', o.customerId)}</div>
          <div class="field"><label>受注日</label><input type="date" name="orderDate" value="${esc(o.orderDate)}"></div>
          <div class="field"><label>担当者</label><select name="staff">${staffOptions(o.staff)}</select></div>
          <div class="field"><label>希望納期 <span class="opt">（お客様）</span></label><input type="date" name="dueDate" value="${esc(o.dueDate)}"></div>
          <div class="field"><label>回答納期 <span class="opt">（当社回答）</span></label><input type="date" name="answerDate" value="${esc(o.answerDate)}"></div>
          <div class="field"><label>請求書</label><select name="billing">${Object.keys(BILLING).map(b => `<option ${b === (o.billing || '未処理') ? 'selected' : ''}>${b}</option>`).join('')}</select></div>
          <div class="field"><label>消費税率（%）</label><input type="number" name="taxRate" value="${esc(o.taxRate)}" min="0" step="any" class="num"></div>
          <div class="field span-2"><label>件名</label><input name="subject" value="${esc(o.subject)}" placeholder="例：〇〇工事用部材一式"></div>
        </div>
        <p class="hint">納期の管理（ホームの「納期が近い受注」など）には、回答納期があれば回答納期、なければ希望納期を使います。</p>
      </section>
      <section class="card">
        <h2>明細（お客様への販売単価）</h2>
        <div id="items"></div>
      </section>
      <section class="card">
        <div class="field"><label>メモ・備考 <span class="opt">（社内用）</span></label><textarea name="note">${esc(o.note)}</textarea></div>
      </section>
      <div class="form-actions">
        <a class="btn" href="${editing ? `#/orders/${o.id}` : '#/orders'}">キャンセル</a>
        <button class="btn btn-primary" type="submit">保存する</button>
      </div>
    </form>`);

  const form = $('#doc-form');
  const ed = mountItems($('#items'), o.items, { getRate: () => form.elements.taxRate.value, autoPrice: true });
  form.elements.taxRate.addEventListener('input', ed.updateTotals);
  bindPartnerButtons(form);

  form.addEventListener('submit', e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    f.orderNo = f.orderNo.trim();
    if (!f.orderNo) return toast('自社受注No.を入力してください', 'error');
    if (db.orders.some(x => x.orderNo === f.orderNo && x.id !== o.id)) return toast('この自社受注No.は既に使われています', 'error');
    if (!f.customerId) return toast('お客様を選択してください', 'error');
    const items = cleanItems(ed.items);
    if (!items.length) return toast('明細を1行以上入力してください（品名は必須です）', 'error');
    if (itemsError(items)) return toast(itemsError(items), 'error');
    Object.assign(o, {
      orderNo: f.orderNo, customerPoNo: f.customerPoNo.trim(), customerId: f.customerId, orderDate: f.orderDate,
      dueDate: f.dueDate, answerDate: f.answerDate, staff: f.staff, billing: f.billing,
      subject: f.subject.trim(), taxRate: toNum(f.taxRate), items, note: f.note,
      updatedAt: new Date().toISOString(),
    });
    linkPartnerKind(o.customerId, 'customer');
    if (editing) db.orders[db.orders.indexOf(editing)] = o;
    else db.orders.push({ ...o, createdAt: o.updatedAt });
    if (pr) pr.orderId = o.id;
    save();
    toast('受注を保存しました');
    go(`#/orders/${o.id}`);
  });
}

function viewOrderDetail(id) {
  const o = getOrder(id);
  if (!o) return notFound();
  const st = orderStatus(o);
  const cu = getPartner(o.customerId);
  const hasPo = posOf(o.id).some(isLive);
  const next = st.key === 'done'
    ? `<div class="next-step is-done"><span>✓ この受注は納品まで完了しています。</span></div>`
    : !hasPo
      ? `<div class="next-step"><span><b>次のステップ：</b>仕入先へ発注する場合は発注書を作成してください。在庫から出す場合はそのまま納品書へ。</span>
          <span class="actions"><a class="btn btn-sm" href="#/pos/new?order=${o.id}">② 発注書を作る</a><a class="btn btn-sm" href="#/deliveries/new?order=${o.id}">③ 納品書を作る</a></span></div>`
      : `<div class="next-step"><span><b>次のステップ：</b>商品がそろったら納品書を作成してください（未納品の数量が自動で入ります）。</span>
          <a class="btn btn-sm" href="#/deliveries/new?order=${o.id}">③ 納品書を作る</a></div>`;

  render(`
    <div class="page-head">
      <div><div class="crumb"><a href="#/orders">受注一覧</a> › 詳細</div>
        <h1>受注 ${tag(o.orderNo, 'is-order')} ${badge(st)}</h1></div>
      <div class="actions">
        <a class="btn" href="#/orders/${o.id}/edit">✎ 編集</a>
        <button class="btn btn-danger" data-act="delete">削除</button>
      </div>
    </div>
    <section class="card">
      <h2>紐付け（受注 → 発注書 → 納品書）</h2>
      ${chainHTML(o, { currentId: o.id })}
      ${next}
    </section>
    <section class="card">
      <h2>受注内容</h2>
      <dl class="info">
        <div><dt>自社受注No.</dt><dd>${tag(o.orderNo, 'is-order')}</dd></div>
        <div><dt>お客様発注No.</dt><dd>${tag(o.customerPoNo, 'is-cust')}</dd></div>
        <div><dt>受注日</dt><dd>${fmtDate(o.orderDate) || '—'}</dd></div>
        <div><dt>担当者</dt><dd>${esc(o.staff) || '—'}</dd></div>
        <div><dt>希望納期</dt><dd>${fmtDate(o.dueDate) || '—'}</dd></div>
        <div><dt>回答納期</dt><dd>${fmtDate(o.answerDate) || '—'}</dd></div>
        <div><dt>納期まで</dt><dd>${dueHTML(o, st)}</dd></div>
        <div><dt>請求書</dt><dd><select data-act="billing" style="width:auto">${Object.keys(BILLING).map(b => `<option ${b === (o.billing || '未処理') ? 'selected' : ''}>${b}</option>`).join('')}</select></dd></div>
        <div class="span-2"><dt>お客様</dt><dd>${partnerLink(o.customerId)} ${cu?.contact ? `<span class="muted">／${esc(cu.contact)}</span>` : ''}</dd></div>
        <div class="span-2"><dt>件名</dt><dd>${esc(o.subject) || '—'}</dd></div>
      </dl>
      ${itemsReadonlyHTML(o, { progress: true })}
      ${o.note ? `<p class="hint" style="white-space:pre-wrap">メモ：${esc(o.note)}</p>` : ''}
    </section>`);

  $('[data-act=billing]').addEventListener('change', e => {
    o.billing = e.target.value;
    save();
    toast(`請求書を「${o.billing}」にしました`);
  });
  $('[data-act=delete]').addEventListener('click', () => {
    const n = posOf(o.id).length + dnsOf(o.id).length;
    if (n) return alert(`この受注には発注書・納品書が ${n} 件紐付いています。\n先にそれらを削除してから受注を削除してください。`);
    if (!confirm(`受注 ${o.orderNo} を削除します。よろしいですか？`)) return;
    db.orders = db.orders.filter(x => x.id !== o.id);
    db.prospects.forEach(p => { if (p.orderId === o.id) p.orderId = ''; });
    save();
    toast('受注を削除しました');
    go('#/orders');
  });
}

// ---------- 発注書・納品書 共通 ----------
const DOC = {
  po: { label: '発注書', path: 'pos', noField: 'poNo', dateField: 'poDate', cls: 'is-po', step: '②', list: () => db.pos },
  dn: { label: '納品書', path: 'deliveries', noField: 'dnNo', dateField: 'deliveryDate', cls: 'is-dn', step: '③', list: () => db.deliveries },
};
const DOC_TITLE = { po: '発注書', dn: '納品書', inv: '請求書', rc: '領収書' };
const SUBS = { inv: 'invoices', rc: 'receipts' }; // 納品書ごとに発行する請求書・領収書
const getDoc = (type, id) => (type === 'po' ? getPo(id) : getDn(id));
const nowIso = () => new Date().toISOString();
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${ymd(d).replace(/-/g, '/')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 書類番号の表示（下書きは番号なし、再発行は「再」、取消は取り消し線）
function docTag(type, d) {
  const T = DOC[type];
  const st = stateOf(d);
  if (st === 'draft') return `<span class="no-tag is-draft">下書き</span>${d.reissueOf ? '<span class="re-mark" title="再発行">再</span>' : ''}`;
  return `<span class="no-tag ${T.cls}${st === 'void' ? ' is-void' : ''}">${esc(d[T.noField])}</span>${d.reissueOf ? '<span class="re-mark" title="再発行">再</span>' : ''}${st === 'void' ? ' <span class="badge st-ng">取消</span>' : ''}`;
}
const stateBadge = d => `<span class="badge ${DOC_STATE[stateOf(d)].cls}">${DOC_STATE[stateOf(d)].label}</span>`;

function addLog(action, type, d, extra = {}) {
  db.logs.push({ id: uid(), at: nowIso(), by: currentUser, action, docType: type, docId: d.id,
    no: extra.no ?? (DOC[type] ? d[DOC[type].noField] : ''), reason: extra.reason || '' });
}

// ---------- 書類の印字内容（発行時に保存し、以後は保存した内容で表示する） ----------
function partnerSnap(id) {
  const p = getPartner(id);
  return p ? { name: p.name, honorific: p.honorific, contact: p.contact, zip: p.zip, address: p.address } : null;
}
const companySnap = () => ({ ...db.settings.company, showLogo: !!db.settings.showLogo });

function buildModel(type, d, sub = {}) {
  const o = d.orderId ? getOrder(d.orderId) : null;
  const t = calc(d);
  const PENDING = '（発行時に採番）';
  const m = {
    type, title: DOC_TITLE[type], to: partnerSnap(type === 'po' ? d.supplierId : o?.customerId), company: companySnap(),
    items: d.items.map(({ name, spec, qty, unit, price }) => ({ name, spec, qty, unit, price })),
    sum: { sub: t.sub, tax: t.tax, total: t.total, rate: t.rate }, subject: d.subject || '', note: d.note || '', cond: [], reissue: null,
  };
  if (type === 'po') {
    m.no = d.poNo;
    m.meta = [['発注No.', d.poNo || PENDING], ['発注日', fmtDate(d.poDate)], ['納期', fmtDate(d.dueDate)], ['当社受注No.', o?.orderNo]];
    m.cond = [['納品場所', d.deliveryPlace || ''], ['支払条件', d.paymentTerms || '']];
  } else if (type === 'dn') {
    m.no = d.dnNo;
    m.meta = [['納品書No.', d.dnNo || PENDING], ['納品日', fmtDate(d.deliveryDate)], ['貴社発注No.', o?.customerPoNo], ['当社受注No.', o?.orderNo]];
  } else if (type === 'inv') {
    const inv = invoiceInfo(d);
    m.no = sub.no;
    m.meta = [['請求書No.', sub.no || PENDING], ['請求日', fmtDate(inv.date)], ['納品書No.', d.dnNo || PENDING], ['貴社発注No.', o?.customerPoNo], ['当社受注No.', o?.orderNo]];
    m.cond = [['お支払期限', fmtDate(inv.payDue)], ['お振込先', db.settings.bankAccount || '']];
  } else {
    const rc = receiptInfo(d);
    m.no = sub.no;
    m.meta = [['領収書No.', sub.no || PENDING], ['発行日', fmtDate(rc.date)], ['納品書No.', d.dnNo || PENDING], ['当社受注No.', o?.orderNo]];
    m.rcFor = rc.for;
  }
  const own = type === 'po' || type === 'dn';
  const from = own ? (d.reissueOf ? getDoc(type, d.reissueOf)?.[DOC[type].noField] : '') : sub.fromNo;
  if (from) {
    m.reissue = { version: own ? d.version || 2 : sub.version, from };
    m.meta.push(['再発行元No.', from]);
  }
  return m;
}

// 発注書・納品書の表示内容：下書きは最新のマスタから、発行後は保存した内容
const docModel = (type, d) => (stateOf(d) === 'draft' || !d.snap ? buildModel(type, d) : d.snap);

// 請求書・領収書
const subList = (d, kind) => d[SUBS[kind]] || [];
const activeSub = (d, kind) => subList(d, kind).find(x => x.status === 'issued');
function nextSub(d, kind) {
  const list = subList(d, kind);
  const version = list.length + 1;
  const base = relatedNo(d, kind);
  return { version, no: version > 1 ? `${base}-${version}` : base, fromNo: list.length ? list[list.length - 1].no : '' };
}
// 表示用：発行中のものがあればその内容、なければ次に発行する内容（下書き）
function subView(d, kind) {
  const a = activeSub(d, kind);
  if (a) return { m: a.snap, state: 'issued', entry: a };
  const n = stateOf(d) === 'issued' ? nextSub(d, kind) : { version: 1, no: '', fromNo: '' };
  return { m: buildModel(kind, d, n), state: 'draft' };
}

// ---------- 帳票の描画 ----------
function companyHTML(c) {
  return `<div class="company">
    ${c.showLogo ? `<img class="company-logo" src="${LOGO_SRC}" alt="${esc(c.name)}">` : `<div class="company-name">${esc(c.name || '（自社名未設定：設定画面で登録）')}</div>`}
    ${c.dept ? `<div class="company-dept">${esc(c.dept)}</div>` : ''}
    ${c.zip || c.address ? `<div>${c.zip ? '〒' + esc(c.zip) + '　' : ''}${esc(c.address)}</div>` : ''}
    ${c.tel || c.fax ? `<div>${c.tel ? 'TEL ' + esc(c.tel) : ''}${c.fax ? '　FAX ' + esc(c.fax) : ''}</div>` : ''}
    ${c.email ? `<div>${esc(c.email)}</div>` : ''}
    ${c.invoiceNo ? `<div>登録番号：${esc(c.invoiceNo)}</div>` : ''}
    ${c.person ? `<div>担当：${esc(c.person)}</div>` : ''}
  </div>`;
}
const metaHTML = m => `<table class="doc-meta">${m.meta.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v || '—')}</td></tr>`).join('')}</table>`;

// state：draft（下書きの透かし）／issued／void（取消の透かし）
function renderDoc(m, state) {
  const wm = state === 'void' ? '<div class="wm wm-void">取 消</div>' : state === 'draft' ? '<div class="wm wm-draft">下書き</div>' : '';
  const re = m.reissue ? `<div class="reissue-stamp" title="再発行（第${m.reissue.version}版）"><b>再</b><small>第${m.reissue.version}版</small></div>` : '';
  return wm + re + (m.type === 'rc' ? receiptBody(m) : docBody(m));
}

function receiptBody(m) {
  const t = m.sum;
  return `
    <h1 class="doc-title">${m.title}</h1>
    <div class="doc-head">
      <div class="doc-to">
        <div class="to-name">${esc(m.to?.name || '（宛先未設定）')}<span>${esc(m.to?.honorific || '御中')}</span></div>
      </div>
      <div class="doc-from">${metaHTML(m)}</div>
    </div>
    <div class="rc-amount"><span>金額</span><b>${yen(t.total)}－</b><small>（税込）</small></div>
    <p class="rc-for">但し　${esc(m.rcFor)}<br>上記正に領収いたしました。</p>
    <div class="rc-bottom">
      <table class="doc-sum">
        <tr><th>税抜金額（${num(t.rate)}%対象）</th><td>${yen(t.sub)}</td></tr>
        <tr><th>消費税額（${num(t.rate)}%）</th><td>${yen(t.tax)}</td></tr>
        <tr class="grand"><th>合計</th><td>${yen(t.total)}</td></tr>
      </table>
      ${t.sub >= 50000 ? '<div class="revenue-stamp">収入<br>印紙</div>' : ''}
      <div class="rc-from">${companyHTML(m.company)}<div class="stamps"><div class="stamp"><div>担当</div><div></div></div></div></div>
    </div>`;
}

function docBody(m) {
  const t = m.sum;
  const MIN_ROWS = 10;
  const rows = m.items.map((it, i) => `<tr>
      <td class="c">${i + 1}</td>
      <td>${esc(it.name)}</td><td class="c">${esc(it.spec)}</td>
      <td class="r">${num(it.qty)}</td><td class="c">${esc(it.unit)}</td>
      <td class="r">${it.price === '' ? '' : num(it.price)}</td><td class="r">${num(lineAmount(it))}</td></tr>`);
  for (let i = rows.length; i < MIN_ROWS; i++) rows.push('<tr><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>');
  const lead = { po: '下記の通り発注いたします。', dn: '下記の通り納品いたしました。ご査収ください。', inv: '下記の通りご請求申し上げます。' }[m.type];
  const totalLabel = { po: 'ご発注金額', dn: '合計金額', inv: 'ご請求金額' }[m.type];
  return `
    <h1 class="doc-title">${m.title}</h1>
    <div class="doc-head">
      <div class="doc-to">
        <div class="to-name">${esc(m.to?.name || '（宛先未設定）')}<span>${esc(m.to?.honorific || '御中')}</span></div>
        ${m.to?.contact ? `<div class="to-sub">${esc(m.to.contact)}</div>` : ''}
        ${m.to?.zip || m.to?.address ? `<div class="to-sub">${m.to.zip ? '〒' + esc(m.to.zip) + '　' : ''}${esc(m.to.address)}</div>` : ''}
        <p class="doc-lead">${lead}</p>
        ${m.subject ? `<div class="doc-subject"><span>件名</span><b>${esc(m.subject)}</b></div>` : ''}
        <div class="doc-total"><span>${totalLabel}（税込）</span><b>${yen(t.total)}</b></div>
      </div>
      <div class="doc-from">
        ${metaHTML(m)}
        ${companyHTML(m.company)}
        <div class="stamps">
          ${m.type === 'po' ? '<div class="stamp"><div>承認</div><div></div></div>' : ''}
          <div class="stamp"><div>担当</div><div></div></div>
        </div>
      </div>
    </div>
    <table class="doc-lines">
      <thead><tr><th style="width:9mm">No.</th><th>品名</th><th style="width:30mm">色</th><th style="width:18mm">数量</th><th style="width:14mm">単位</th>
        <th style="width:24mm">単価</th><th style="width:28mm">金額</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
    <div class="doc-bottom">
      <div class="doc-notes">
        ${m.cond.length ? `<table class="doc-cond">${m.cond.map(([k, v]) =>
          `<tr><th>${k}</th><td${m.type === 'inv' ? ' style="white-space:pre-wrap"' : ''}>${k === 'お支払期限' ? `<b>${esc(v)}</b>` : esc(v) || '&nbsp;'}</td></tr>`).join('')}</table>` : ''}
        <div class="note-box"><div class="note-label">備考</div><div class="note-body">${esc(m.note)}</div></div>
      </div>
      <table class="doc-sum">
        <tr><th>小計${m.type === 'inv' ? `（${num(t.rate)}%対象）` : ''}</th><td>${yen(t.sub)}</td></tr>
        <tr><th>消費税（${num(t.rate)}%）</th><td>${yen(t.tax)}</td></tr>
        <tr class="grand"><th>合計</th><td>${yen(t.total)}</td></tr>
      </table>
    </div>
    ${m.type !== 'dn' ? '' : `<div class="receipt"><span class="receipt-msg">上記の通り受領いたしました。</span>
      <div class="receipt-box"><div>受領印</div><div></div></div></div>`}`;
}

// ---------- 発行・取消・再発行 ----------
function askReason(what) {
  const r = prompt(`${what}を取消します。\n取消の理由を入力してください（必須）。\n取消した書類は「取消」の印付きで残り、削除はされません。`);
  if (r == null) return null;
  if (!r.trim()) {
    toast('取消の理由を入力してください', 'error');
    return null;
  }
  return r.trim();
}
const voidFields = reason => ({ status: 'void', voidAt: nowIso(), voidBy: currentUser, voidReason: reason });

function issueDoc(type, d) {
  const T = DOC[type];
  if (!confirm(`この${T.label}を発行します。\n発行すると番号が付いて内容が確定し、編集・削除はできなくなります（誤りがあった場合は「取消」して再発行します）。\nよろしいですか？`)) return;
  Object.assign(d, { [T.noField]: nextNo(type), status: 'issued', issuedAt: nowIso(), issuedBy: currentUser, version: d.version || 1 });
  d.snap = buildModel(type, d);
  const old = d.reissueOf ? getDoc(type, d.reissueOf) : null;
  if (old) old.replacedBy = d.id;
  addLog(old ? '再発行' : '発行', type, d, { reason: old ? `再発行元：${old[T.noField]}` : '' });
  save();
  toast(`${T.label} ${d[T.noField]} を発行しました`);
  route();
}

function voidDoc(type, d) {
  const T = DOC[type];
  const reason = askReason(`${T.label} ${d[T.noField]} `);
  if (!reason) return;
  Object.assign(d, voidFields(reason));
  addLog('取消', type, d, { reason });
  // 納品書を取消したら、その納品書の請求書・領収書も取消す（在庫の出荷済も戻る）
  if (type === 'dn') {
    Object.keys(SUBS).forEach(kind => {
      const a = activeSub(d, kind);
      if (!a) return;
      Object.assign(a, voidFields(`納品書 ${d.dnNo} の取消に伴う取消`));
      addLog('取消', kind, d, { no: a.no, reason: a.voidReason });
    });
    syncBilling(getOrder(d.orderId));
  }
  save();
  toast(`${T.label} ${d[T.noField]} を取消しました`);
  route();
}

// 取消した書類の内容を引き継いだ下書きを作る（発行すると「再」の印が付く）
function reissueDoc(type, d) {
  const T = DOC[type];
  const existing = T.list().find(x => x.reissueOf === d.id && isLive(x));
  if (existing) return go(`#/${T.path}/${existing.id}`);
  const copy = clone(d);
  ['snap', 'issuedAt', 'issuedBy', 'voidAt', 'voidBy', 'voidReason', 'replacedBy', 'invoices', 'receipts'].forEach(k => delete copy[k]);
  Object.assign(copy, { id: uid(), [T.noField]: '', status: 'draft', reissueOf: d.id, version: (d.version || 1) + 1, createdAt: nowIso(), updatedAt: nowIso() });
  T.list().push(copy);
  save();
  toast('取消した内容を引き継いだ下書きを作りました。修正して「発行する」を押してください');
  go(`#/${T.path}/${copy.id}/edit`);
}

function issueSub(d, kind) {
  const label = DOC_TITLE[kind];
  if (stateOf(d) !== 'issued') return toast('先に納品書を発行してください', 'error');
  if (activeSub(d, kind)) return;
  const n = nextSub(d, kind);
  if (!confirm(`${label} ${n.no} を発行します。\n発行すると内容が確定し、変更できなくなります（誤りがあった場合は「取消」して再発行します）。\nよろしいですか？`)) return;
  const list = d[SUBS[kind]] = d[SUBS[kind]] || [];
  list.push({ version: n.version, no: n.no, status: 'issued', issuedAt: nowIso(), issuedBy: currentUser, snap: buildModel(kind, d, n) });
  addLog(n.version > 1 ? '再発行' : '発行', kind, d, { no: n.no, reason: n.fromNo ? `再発行元：${n.fromNo}` : '' });
  const o = getOrder(d.orderId);
  if (kind === 'inv' && o && (o.billing || '未処理') === '未処理') {
    o.billing = '発行済';
    toast(`受注 ${o.orderNo} の請求書の状況を「発行済」にしました`);
  }
  save();
  toast(`${label} ${n.no} を発行しました`);
  route();
}

function voidSub(d, kind) {
  const a = activeSub(d, kind);
  if (!a) return;
  const reason = askReason(`${DOC_TITLE[kind]} ${a.no} `);
  if (!reason) return;
  Object.assign(a, voidFields(reason));
  addLog('取消', kind, d, { no: a.no, reason });
  if (kind === 'inv') syncBilling(getOrder(d.orderId));
  save();
  toast(`${DOC_TITLE[kind]} ${a.no} を取消しました。内容を直して「再発行する」を押すと、「再」の印付きで発行されます`);
  route();
}

// 受注の請求書がすべて取消されたら、請求書の状況を「発行済」から「未処理」に戻す
function syncBilling(o) {
  if (!o || o.billing !== '発行済') return;
  if (!dnsOf(o.id).some(dn => activeSub(dn, 'inv'))) o.billing = '未処理';
}

// 移行：状態を持たない（以前のバージョンで作った）発注書・納品書は、発行済として今の内容を保存する
function migrateIssued() {
  let changed = false;
  [['po', db.pos], ['dn', db.deliveries]].forEach(([type, list]) => list.forEach(d => {
    if (d.status) return;
    Object.assign(d, { status: 'issued', version: 1, issuedAt: d.createdAt || d.updatedAt || nowIso(), issuedBy: '（以前のデータから移行）' });
    d.snap = buildModel(type, d);
    changed = true;
  }));
  return changed;
}

// 発行後に取引先・自社情報が変わっていれば知らせる
function changedNotice(type, d, m) {
  const o = d.orderId ? getOrder(d.orderId) : null;
  const toNow = partnerSnap(type === 'po' ? d.supplierId : o?.customerId);
  const diffs = [];
  if (JSON.stringify(toNow) !== JSON.stringify(m.to)) diffs.push('取引先（宛先）');
  if (JSON.stringify(companySnap()) !== JSON.stringify(m.company)) diffs.push('自社情報');
  return diffs.length ? `<div class="banner">発行した後に${diffs.join('・')}の登録内容が変更されています。この書類は発行した時点の内容のままです。
    変更後の内容で出し直す場合は「取消」してから再発行してください。</div>` : '';
}

function logsHTML(docId) {
  const logs = db.logs.filter(l => l.docId === docId).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (!logs.length) return '';
  return `<section class="card no-print"><h2>操作履歴</h2><div class="table-wrap"><table class="list">
    <thead><tr><th>日時</th><th>操作</th><th>書類</th><th>番号</th><th>操作した人</th><th>理由・備考</th></tr></thead>
    <tbody>${logs.map(l => `<tr><td class="nowrap">${fmtDateTime(l.at)}</td><td>${esc(l.action)}</td><td>${esc(DOC_TITLE[l.docType] || '')}</td>
      <td class="nowrap">${esc(l.no)}</td><td>${esc(l.by) || '<span class="muted">—</span>'}</td><td class="wide">${esc(l.reason)}</td></tr>`).join('')}</tbody>
  </table></div></section>`;
}

// ---------- 一覧・表示 ----------
function docTableHTML(type, docs) {
  const T = DOC[type];
  const isPo = type === 'po';
  return `<div class="table-wrap"><table class="list">
        <thead><tr><th>${T.label}No.</th><th>${isPo ? '発注日' : '納品日'}</th><th>${isPo ? '仕入先' : 'お客様'}</th>
          <th>自社受注No.</th><th>お客様発注No.</th><th>件名</th>${isPo ? '<th>納期</th>' : ''}<th class="num">金額（税込）</th><th>状態</th><th></th></tr></thead>
        <tbody>${docs.map(d => {
          const o = d.orderId ? getOrder(d.orderId) : null;
          const pid = isPo ? d.supplierId : o?.customerId;
          const search = [d[T.noField], partnerName(pid), o?.orderNo, o?.customerPoNo, d.subject, DOC_STATE[stateOf(d)].label].join(' ');
          return `<tr class="clickable${isLive(d) ? '' : ' is-void-row'}" data-href="#/${T.path}/${d.id}" data-search="${esc(search)}" ${isLive(d) ? '' : 'data-void="1"'}>
            <td class="nowrap">${docTag(type, d)}</td><td class="nowrap">${esc(d[T.dateField])}</td><td class="wide">${partnerLink(pid)}</td>
            <td>${o ? `<a href="#/orders/${o.id}">${tag(o.orderNo, 'is-order')}</a>` : '<span class="muted">紐付けなし</span>'}</td>
            <td>${tag(o?.customerPoNo, 'is-cust')}</td><td>${esc(d.subject)}</td>
            ${isPo ? `<td class="nowrap">${d.dueDate && o && isLive(d) ? dueHTML({ dueDate: d.dueDate }, orderStatus(o)) : esc(d.dueDate) || '—'}</td>` : ''}
            <td class="num">${yen(calc(d).total)}</td><td>${stateBadge(d)}</td>
            <td><span class="actions"><a class="btn btn-sm" href="#/${T.path}/${d.id}">表示・印刷</a>
              ${!isPo && isLive(d) ? `<a class="btn btn-sm" href="#/deliveries/${d.id}/set">請求書・領収書</a>` : ''}</span></td></tr>`;
        }).join('')}</tbody></table></div>`;
}

function viewDocList(type) {
  const T = DOC[type];
  const docs = [...T.list()].sort(byDateNoDesc(T.dateField, T.noField));
  const voids = docs.filter(d => !isLive(d)).length;
  render(`
    <div class="page-head">
      <div><div class="crumb">ステップ ${T.step}</div><h1>${T.label}一覧</h1></div>
      <div class="actions"><a class="btn btn-primary" href="#/${T.path}/new">＋ ${T.label}を作成</a></div>
    </div>
    <p class="hint no-print" style="margin:-8px 0 14px">受注の詳細画面から作成すると、番号と明細が自動で紐付きます。作成した${T.label}は「下書き」です。内容を確認して「発行する」を押すと番号が付き、内容が確定します。</p>
    <section class="card">
      ${docs.length ? `
      <div class="filters"><input type="search" data-filter placeholder="番号・会社名・件名で絞り込み">
        ${voids ? `<label class="check"><input type="checkbox" data-show-void> 取消した${T.label}も表示（${voids} 件）</label>` : ''}
        <span class="muted" data-count></span></div>
      ${docTableHTML(type, docs)}` :
        `<div class="empty">${T.label}はまだありません。<br>受注一覧から受注を開き「${T.label}を作る」を押すと、番号・明細が紐付いた${T.label}を作成できます。<br>
          <a class="btn" href="#/orders">受注一覧を開く</a></div>`}
    </section>`);
  bindListFilter($('#view'));
}

function stateBanner(type, d) {
  const T = DOC[type];
  const st = stateOf(d);
  const origin = d.reissueOf ? getDoc(type, d.reissueOf) : null;
  const next = d.replacedBy ? getDoc(type, d.replacedBy) : T.list().find(x => x.reissueOf === d.id && isLive(x));
  const lines = [];
  if (st === 'draft') lines.push(`<b>下書き</b>です。内容を確認して「発行する」を押してください。発行すると番号が付き、内容が確定します（以後は編集・削除できません）。`);
  if (st === 'issued') lines.push(`<b>発行済</b>（${fmtDateTime(d.issuedAt)}${d.issuedBy ? '　' + esc(d.issuedBy) : ''}）。内容は確定しています。誤りがあった場合は「取消」してから再発行してください。`);
  if (st === 'void') lines.push(`<b>取消済</b>（${fmtDateTime(d.voidAt)}${d.voidBy ? '　' + esc(d.voidBy) : ''}）　理由：${esc(d.voidReason)}`);
  if (origin) lines.push(`この${T.label}は <a href="#/${T.path}/${origin.id}">${esc(origin[T.noField])}</a>（取消済）の<b>再発行</b>です。書類に「再」の印が付きます。`);
  if (next) lines.push(`再発行した${T.label}：<a href="#/${T.path}/${next.id}">${stateOf(next) === 'draft' ? '下書き' : esc(next[T.noField])}</a>`);
  return `<div class="state-banner is-${st}">${lines.map(l => `<div>${l}</div>`).join('')}</div>`;
}

function viewDocDetail(type, id) {
  const T = DOC[type];
  const d = getDoc(type, id);
  if (!d) return notFound();
  const o = d.orderId ? getOrder(d.orderId) : null;
  const st = stateOf(d);
  const m = docModel(type, d);
  const no = d[T.noField];
  const hasNext = d.replacedBy || T.list().some(x => x.reissueOf === d.id && isLive(x));
  const actions = {
    draft: `<button class="btn btn-primary" data-act="issue">✔ 発行する</button>
      <a class="btn" href="#/${T.path}/${d.id}/edit">✎ 編集</a>
      <button class="btn btn-print" data-act="print">🖨 下書きを印刷</button>
      <button class="btn btn-danger" data-act="delete">下書きを削除</button>`,
    issued: `<button class="btn btn-print" data-act="print">🖨 PDFで印刷・保存</button>
      ${type === 'dn' ? `<a class="btn btn-primary" href="#/deliveries/${d.id}/set">📄 請求書・領収書</a>` : ''}
      <button class="btn btn-danger" data-act="void">取消</button>`,
    void: `<button class="btn btn-print" data-act="print">🖨 印刷（取消済）</button>
      ${hasNext ? '' : '<button class="btn btn-primary" data-act="reissue">↻ 再発行する</button>'}`,
  }[st];

  render(`
    <div class="page-head no-print">
      <div><div class="crumb"><a href="#/${T.path}">${T.label}一覧</a> › 表示・印刷</div>
        <h1>${T.label} ${docTag(type, d)} ${st === 'void' ? '' : stateBadge(d)}</h1></div>
      <div class="actions">${actions}</div>
    </div>
    <section class="card no-print">
      ${stateBanner(type, d)}
      ${st === 'draft' ? '' : changedNotice(type, d, m)}
      <h2 style="margin-top:14px">紐付け</h2>
      ${o ? chainHTML(o, { currentId: d.id, withAdd: false }) : '<p class="muted">この発注書は受注に紐付いていません。</p>'}
      ${(() => {
        const pid = type === 'po' ? d.supplierId : o?.customerId;
        return getPartner(pid) ? `<div class="link-info"><span>宛先（${type === 'po' ? '仕入先' : 'お客様'}）：<b>${partnerLink(pid)}</b></span>
          <span class="muted">${st === 'draft' ? '下書きの間は、取引先の最新の登録内容が書類に入ります。' : '発行した時点の宛先が印字されます。'}</span></div>` : '';
      })()}
      <p class="hint">「PDFで印刷・保存」→ 印刷画面の送信先（プリンター）で <b>「PDFに保存」</b> を選ぶと PDF ファイルになります。</p>
    </section>
    <div class="paper-scroll"><div class="paper">${renderDoc(m, st)}</div></div>
    ${logsHTML(d.id)}`);

  $('[data-act=print]').addEventListener('click', () => printDoc(`${T.label}_${no || '下書き'}`));
  $('[data-act=issue]')?.addEventListener('click', () => issueDoc(type, d));
  $('[data-act=void]')?.addEventListener('click', () => voidDoc(type, d));
  $('[data-act=reissue]')?.addEventListener('click', () => reissueDoc(type, d));
  $('[data-act=delete]')?.addEventListener('click', () => {
    if (!confirm(`この${T.label}の下書きを削除します。よろしいですか？`)) return;
    if (type === 'po') db.pos = db.pos.filter(x => x.id !== d.id);
    else db.deliveries = db.deliveries.filter(x => x.id !== d.id);
    save();
    toast(`${T.label}の下書きを削除しました`);
    go(o ? `#/orders/${o.id}` : `#/${T.path}`);
  });
}

// 発行済の書類は編集できない（編集画面を開いたとき）
function lockedNotice(type, d) {
  const T = DOC[type];
  render(`<div class="card empty">この${T.label}（${esc(d[T.noField])}）は${DOC_STATE[stateOf(d)].label}のため編集できません。<br>
    誤りがある場合は、書類の画面で「取消」してから再発行してください。<br>
    <a class="btn" href="#/${T.path}/${d.id}">書類の画面へ戻る</a></div>`);
}

function printDoc(filename) {
  const prev = document.title;
  document.title = filename; // PDF 保存時の既定ファイル名になる
  window.addEventListener('afterprint', () => { document.title = prev; }, { once: true });
  window.print();
}

// 納品書・請求書・領収書を 1 画面にまとめて表示・印刷（1 書類 = A4 1 枚）
const SET_DOCS = [['dn', '納品書'], ['inv', '請求書'], ['rc', '領収書']];
let setShown = { dn: true, inv: true, rc: true };

function viewDocSet(id) {
  const d = getDn(id);
  if (!d) return notFound();
  const o = getOrder(d.orderId);
  const dnState = stateOf(d);
  const inv = invoiceInfo(d);
  const rc = receiptInfo(d);
  const views = { dn: { m: docModel('dn', d), state: dnState }, inv: subView(d, 'inv'), rc: subView(d, 'rc') };
  const subRow = kind => {
    const v = views[kind];
    const a = v.entry;
    const list = subList(d, kind);
    const voided = list.filter(x => x.status === 'void');
    const label = DOC_TITLE[kind];
    let status;
    let btn = '';
    if (dnState !== 'issued') status = `<span class="muted">${dnState === 'void' ? '納品書が取消済のため発行できません' : '納品書を発行すると発行できます'}</span>`;
    else if (a) {
      status = `<span class="badge st-done">発行済</span> ${tag(a.no, 'is-dn')}${a.version > 1 ? '<span class="re-mark">再</span>' : ''} <span class="muted">${fmtDateTime(a.issuedAt)} ${esc(a.issuedBy)}</span>`;
      btn = `<button class="btn btn-sm btn-danger" data-void-sub="${kind}">取消</button>`;
    } else {
      status = `<span class="badge st-new">未発行</span> <span class="muted">発行すると ${esc(nextSub(d, kind).no)}${list.length ? '（再発行・「再」の印付き）' : ''}</span>`;
      btn = `<button class="btn btn-sm btn-primary" data-issue-sub="${kind}">${list.length ? '↻ 再発行する' : `✔ ${label}を発行する`}</button>`;
    }
    return `<tr><th>${label}</th><td>${status}
      ${voided.length ? `<div class="muted" style="margin-top:4px">取消済：${voided.map(x => `<a href="#/deliveries/${d.id}/${kind}/${x.version}">${esc(x.no)}</a>（${esc(x.voidReason)}）`).join('、')}</div>` : ''}</td>
      <td style="text-align:right">${btn}</td></tr>`;
  };
  const lockInv = !!views.inv.entry || dnState !== 'issued';
  const lockRc = !!views.rc.entry || dnState !== 'issued';

  render(`
    <div class="page-head no-print">
      <div><div class="crumb"><a href="#/deliveries">納品書一覧</a> › <a href="#/deliveries/${d.id}">${dnState === 'draft' ? '下書き' : esc(d.dnNo)}</a> › 請求書・領収書</div>
        <h1>納品書・請求書・領収書 ${docTag('dn', d)}</h1></div>
      <div class="actions">
        <button class="btn btn-print" data-act="print">🖨 まとめてPDFで印刷・保存</button>
        ${o ? `<a class="btn" href="#/orders/${o.id}">受注を開く</a>` : ''}
      </div>
    </div>
    <section class="card no-print">
      <h2>発行の状況</h2>
      <table class="list set-status"><tbody>
        <tr><th>納品書</th><td>${stateBadge(d)} ${dnState === 'draft' ? '<span class="muted">先に納品書を発行してください</span>' : tag(d.dnNo, 'is-dn')}</td>
          <td style="text-align:right">${dnState === 'draft' ? '<button class="btn btn-sm btn-primary" data-act="issue-dn">✔ 納品書を発行する</button>' : ''}</td></tr>
        ${subRow('inv')}${subRow('rc')}
      </tbody></table>
      <div class="grid-4" style="margin-top:14px">
        <div class="field"><label>請求日</label><input type="date" data-f="invoiceDate" value="${esc(inv.date)}" ${lockInv ? 'disabled' : ''}></div>
        <div class="field"><label>お支払期限</label><input type="date" data-f="payDue" value="${esc(inv.payDue)}" ${lockInv ? 'disabled' : ''}></div>
        <div class="field"><label>領収書の発行日</label><input type="date" data-f="receiptDate" value="${esc(rc.date)}" ${lockRc ? 'disabled' : ''}></div>
        <div class="field"><label>領収書の但し書き</label><input data-f="receiptFor" value="${esc(rc.for)}" ${lockRc ? 'disabled' : ''}></div>
      </div>
      <p class="hint">請求日・領収書の発行日は納品日、お支払期限は請求日の翌月末が最初に入ります。発行前なら変更できます（発行後は取消してから変更します）。</p>
      ${db.settings.bankAccount ? '' : '<p class="hint"><span class="over">⚠ 振込先が未登録です。</span> <a href="#/settings">設定画面</a>で登録すると請求書に印字されます。</p>'}
      ${db.settings.company.invoiceNo ? '' : '<p class="hint"><span class="over">⚠ インボイス登録番号が未登録です。</span> <a href="#/settings">設定画面</a>で登録すると請求書・領収書に印字されます。</p>'}
      <h2 style="margin-top:16px">表示・印刷する書類</h2>
      <div class="actions set-toggles">${SET_DOCS.map(([k, label]) =>
        `<label class="btn"><input type="checkbox" data-show="${k}" ${setShown[k] ? 'checked' : ''}> ${label}</label>`).join('')}</div>
      <p class="hint">印刷画面で「PDFに保存」を選ぶと、選んだ書類が 1 つの PDF（1 書類 1 ページ）になります。未発行の書類には「下書き」の透かしが入ります。</p>
    </section>
    <div class="paper-scroll doc-set">${SET_DOCS.map(([k]) =>
      `<div class="paper" data-doc="${k}">${renderDoc(views[k].m, views[k].state)}</div>`).join('')}</div>
    ${logsHTML(d.id)}`);

  const applyShown = () => {
    let first = true;
    $$('.doc-set .paper').forEach(p => {
      p.hidden = !setShown[p.dataset.doc];
      p.classList.toggle('page-break', !p.hidden && !first); // 2 枚目以降は改ページ
      if (!p.hidden) first = false;
    });
  };
  applyShown();
  $$('[data-show]').forEach(cb => cb.addEventListener('change', () => {
    setShown[cb.dataset.show] = cb.checked;
    applyShown();
  }));
  $$('input[data-f]').forEach(input => input.addEventListener('change', () => {
    const v = input.value.trim();
    if (v) d[input.dataset.f] = v;
    else delete d[input.dataset.f]; // 空にしたら最初の値に戻す
    save();
    const y = window.scrollY;
    viewDocSet(id);
    window.scrollTo(0, y);
  }));
  $('[data-act=issue-dn]')?.addEventListener('click', () => issueDoc('dn', d));
  $$('[data-issue-sub]').forEach(b => b.addEventListener('click', () => issueSub(d, b.dataset.issueSub)));
  $$('[data-void-sub]').forEach(b => b.addEventListener('click', () => voidSub(d, b.dataset.voidSub)));
  $('[data-act=print]').addEventListener('click', () => {
    const names = SET_DOCS.filter(([k]) => setShown[k]).map(([, label]) => label);
    if (!names.length) return toast('印刷する書類を選んでください', 'error');
    printDoc(`${names.join('・')}_${d.dnNo || '下書き'}`);
  });
}

// 取消した請求書・領収書を表示する
function viewSubDoc(id, kind, version) {
  const d = getDn(id);
  const e = d && subList(d, kind).find(x => String(x.version) === String(version));
  if (!e) return notFound();
  render(`
    <div class="page-head no-print">
      <div><div class="crumb"><a href="#/deliveries/${d.id}/set">納品書・請求書・領収書</a> › ${DOC_TITLE[kind]}</div>
        <h1>${DOC_TITLE[kind]} ${tag(e.no, 'is-dn')} ${e.status === 'void' ? '<span class="badge st-ng">取消</span>' : '<span class="badge st-done">発行済</span>'}</h1></div>
      <div class="actions"><button class="btn btn-print" data-act="print">🖨 印刷</button></div>
    </div>
    <section class="card no-print"><div class="state-banner is-${e.status}">
      <div>発行：${fmtDateTime(e.issuedAt)} ${esc(e.issuedBy)}</div>
      ${e.status === 'void' ? `<div>取消：${fmtDateTime(e.voidAt)} ${esc(e.voidBy)}　理由：${esc(e.voidReason)}</div>` : ''}</div></section>
    <div class="paper-scroll"><div class="paper">${renderDoc(e.snap, e.status)}</div></div>`);
  $('[data-act=print]').addEventListener('click', () => printDoc(`${DOC_TITLE[kind]}_${e.no}`));
}

// ---------- 発注書フォーム ----------
function poItemsFromOrder(order) {
  return order.items.map(it => ({ id: uid(), ref: it.id, name: it.name, spec: it.spec, qty: it.qty, unit: it.unit, price: '' }));
}

function linkInfoHTML(o) {
  if (!o) return '<span class="muted">受注に紐付けると、自社受注No.・お客様発注No.が書類に入ります。</span>';
  return `<span>自社受注No.：<b>${esc(o.orderNo)}</b></span><span>お客様発注No.：<b>${esc(o.customerPoNo || '—')}</b></span>
    <span>お客様：<b>${esc(partnerName(o.customerId))}</b></span><span>納期：<b>${esc(dueOf(o) || '—')}</b></span>`;
}

function viewPoForm(id, orderIdParam, supplierParam) {
  const editing = id ? getPo(id) : null;
  if (id && !editing) return notFound();
  if (editing && stateOf(editing) !== 'draft') return lockedNotice('po', editing);
  const src = orderIdParam ? getOrder(orderIdParam) : null;
  const p = editing ? clone(editing) : {
    id: uid(), poNo: '', status: 'draft', orderId: src?.id || '', supplierId: getPartner(supplierParam) ? supplierParam : '', poDate: today(),
    dueDate: src && dueOf(src) ? addDays(dueOf(src), -2) : '', deliveryPlace: '', paymentTerms: db.settings.paymentTerms || '',
    subject: src?.subject || '', taxRate: src?.taxRate ?? db.settings.taxRate,
    items: src ? poItemsFromOrder(src) : [blankItem()], note: '',
  };
  if (!editing && p.dueDate && p.dueDate < p.poDate) p.dueDate = p.poDate;

  render(`
    <div class="page-head">
      <div><div class="crumb"><a href="#/pos">発注書一覧</a> › ${editing ? '編集' : '作成'}</div>
        <h1>${editing ? `発注書を編集 ${docTag('po', p)}` : '発注書を作成'}</h1></div>
    </div>
    <form id="doc-form" autocomplete="off">
      <section class="card">
        <h2>番号と紐付け</h2>
        <div class="grid-2">
          <div class="field number-field is-po">
            <label>発注No.</label>
            <div class="number-pending">${p.poNo ? esc(p.poNo) : '発行時に自動で付きます'}</div>
            <p class="hint">保存すると「下書き」になります。内容を確認して「発行する」を押すと番号が付き、内容が確定します。</p>
          </div>
          <div class="field">
            <label>紐付ける受注（自社受注No.）</label>
            <select name="orderId">${orderOptions(p.orderId, '— 紐付けなし（在庫補充など）—')}</select>
          </div>
          <div class="span-all"><div class="link-info" id="link-info">${linkInfoHTML(getOrder(p.orderId))}</div></div>
        </div>
      </section>
      <section class="card">
        <h2>発注内容</h2>
        <div class="grid-4">
          <div class="span-2">${partnerSelectField('supplierId', '仕入先（発注先）', 'supplier', p.supplierId)}</div>
          <div class="field"><label>発注日</label><input type="date" name="poDate" value="${esc(p.poDate)}"></div>
          <div class="field"><label>納期</label><input type="date" name="dueDate" value="${esc(p.dueDate)}"></div>
          <div class="field span-2"><label>件名</label><input name="subject" value="${esc(p.subject)}"></div>
          <div class="field"><label>納品場所</label><input name="deliveryPlace" value="${esc(p.deliveryPlace)}" placeholder="例：当社倉庫／お客様へ直送"></div>
          <div class="field"><label>支払条件</label><input name="paymentTerms" value="${esc(p.paymentTerms)}" placeholder="例：月末締め翌月末払い"></div>
          <div class="field"><label>消費税率（%）</label><input type="number" name="taxRate" value="${esc(p.taxRate)}" min="0" step="any" class="num"></div>
        </div>
      </section>
      <section class="card">
        <h2>明細（仕入先への発注単価）</h2>
        ${!editing && src ? '<p class="hint" style="margin:-6px 0 10px">受注の明細を取り込みました。<b>単価には仕入単価を入力</b>してください。</p>' : ''}
        <div class="actions" style="margin-bottom:10px"><button type="button" class="btn btn-sm" data-act="import">↓ 紐付けた受注の明細を取り込む</button></div>
        <div id="items"></div>
      </section>
      <section class="card">
        <div class="field"><label>備考 <span class="opt">（発注書に印字されます）</span></label><textarea name="note">${esc(p.note)}</textarea></div>
      </section>
      <div class="form-actions">
        <a class="btn" href="${editing ? `#/pos/${p.id}` : src ? `#/orders/${src.id}` : '#/pos'}">キャンセル</a>
        <button class="btn btn-primary" type="submit">下書きを保存して確認へ</button>
      </div>
    </form>`);

  const form = $('#doc-form');
  const ed = mountItems($('#items'), p.items, { getRate: () => form.elements.taxRate.value });
  form.elements.taxRate.addEventListener('input', ed.updateTotals);
  bindPartnerButtons(form);
  form.elements.orderId.addEventListener('change', () => {
    $('#link-info').innerHTML = linkInfoHTML(getOrder(form.elements.orderId.value));
  });
  $('[data-act=import]', form).addEventListener('click', () => {
    const o = getOrder(form.elements.orderId.value);
    if (!o) return toast('先に紐付ける受注を選んでください', 'error');
    if (cleanItems(ed.items).length && !confirm('現在の明細を受注の明細で置き換えます。よろしいですか？')) return;
    ed.setItems(poItemsFromOrder(o));
    toast('受注の明細を取り込みました。単価（仕入単価）を入力してください');
  });

  form.addEventListener('submit', e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    if (!f.supplierId) return toast('仕入先を選択してください', 'error');
    const items = cleanItems(ed.items);
    if (!items.length) return toast('明細を1行以上入力してください（品名は必須です）', 'error');
    if (itemsError(items)) return toast(itemsError(items), 'error');
    if (items.some(it => it.price === '') && !confirm('単価が未入力の行があります。このまま保存しますか？')) return;
    Object.assign(p, {
      orderId: f.orderId, supplierId: f.supplierId, poDate: f.poDate, dueDate: f.dueDate,
      subject: f.subject.trim(), deliveryPlace: f.deliveryPlace.trim(), paymentTerms: f.paymentTerms.trim(),
      taxRate: toNum(f.taxRate), items, note: f.note, updatedAt: new Date().toISOString(),
    });
    linkPartnerKind(p.supplierId, 'supplier');
    if (editing) db.pos[db.pos.indexOf(editing)] = p;
    else db.pos.push({ ...p, createdAt: p.updatedAt });
    save();
    toast('発注書を下書きとして保存しました。内容を確認して「発行する」を押してください');
    go(`#/pos/${p.id}`);
  });
}

// ---------- 納品書フォーム ----------
function viewDnForm(id, orderIdParam) {
  const editing = id ? getDn(id) : null;
  if (id && !editing) return notFound();
  if (!editing && !db.orders.length) {
    return render(`<div class="card empty">納品書は受注に紐付けて作成します。先に受注を登録してください。<br>
      <a class="btn btn-primary" href="#/orders/new">＋ 受注を登録する</a></div>`);
  }
  if (editing && stateOf(editing) !== 'draft') return lockedNotice('dn', editing);
  const src = orderIdParam ? getOrder(orderIdParam) : null;
  const d = editing ? clone(editing) : {
    id: uid(), dnNo: '', status: 'draft', orderId: src?.id || '', deliveryDate: today(),
    subject: src?.subject || '', taxRate: src?.taxRate ?? db.settings.taxRate,
    items: src ? remainingItems(src) : [], note: '',
  };
  const allDelivered = !editing && src && !d.items.length;
  if (!d.items.length) d.items = [blankItem(true)];

  render(`
    <div class="page-head">
      <div><div class="crumb"><a href="#/deliveries">納品書一覧</a> › ${editing ? '編集' : '作成'}</div>
        <h1>${editing ? `納品書を編集 ${docTag('dn', d)}` : '納品書を作成'}</h1></div>
    </div>
    ${allDelivered ? '<div class="banner">この受注は全数納品済みです。追加の納品がある場合のみ明細を入力してください。</div>' : ''}
    <form id="doc-form" autocomplete="off">
      <section class="card">
        <h2>番号と紐付け</h2>
        <div class="grid-2">
          <div class="field number-field is-dn">
            <label>納品書No.</label>
            <div class="number-pending">${d.dnNo ? esc(d.dnNo) : '発行時に自動で付きます'}</div>
            <p class="hint">保存すると「下書き」になります。内容を確認して「発行する」を押すと番号が付き、内容が確定します。</p>
          </div>
          <div class="field">
            <label>紐付ける受注（自社受注No.） <span class="req">必須</span></label>
            <select name="orderId">${orderOptions(d.orderId, '— 受注を選択してください —')}</select>
          </div>
          <div class="span-all"><div class="link-info" id="link-info">${linkInfoHTML(getOrder(d.orderId))}</div></div>
        </div>
      </section>
      <section class="card">
        <h2>納品内容</h2>
        <div class="grid-4">
          <div class="field"><label>納品日</label><input type="date" name="deliveryDate" value="${esc(d.deliveryDate)}"></div>
          <div class="field span-2"><label>件名</label><input name="subject" value="${esc(d.subject)}"></div>
          <div class="field"><label>消費税率（%）</label><input type="number" name="taxRate" value="${esc(d.taxRate)}" min="0" step="any" class="num"></div>
        </div>
        <p class="hint">宛先はお客様（受注先）になります。お客様発注No.・自社受注No.は自動で印字されます。</p>
      </section>
      <section class="card">
        <h2>明細（今回納品する数量）</h2>
        <p class="hint" style="margin:-6px 0 10px">受注を選ぶと、<b>まだ納品していない数量</b>が自動で入ります。分納の場合は数量を減らしてください。</p>
        <div id="items"></div>
      </section>
      <section class="card">
        <div class="field"><label>備考 <span class="opt">（納品書に印字されます）</span></label><textarea name="note">${esc(d.note)}</textarea></div>
      </section>
      <div class="form-actions">
        <a class="btn" href="${editing ? `#/deliveries/${d.id}` : src ? `#/orders/${src.id}` : '#/deliveries'}">キャンセル</a>
        <button class="btn btn-primary" type="submit">下書きを保存して確認へ</button>
      </div>
    </form>`);

  const form = $('#doc-form');
  const refInfo = it => {
    const o = getOrder(form.elements.orderId.value);
    const line = o?.items.find(x => x.id === it.ref);
    if (!line) return '';
    const done = deliveredMap(o.id, d.id)[line.id] || 0;
    const rest = toNum(line.qty) - done;
    const over = toNum(it.qty) > rest;
    return `受注数 ${num(line.qty)} ／ 納品済 ${num(done)} ／ 残 ${num(rest)}${over ? '　<span class="over">⚠ 残数を超えています</span>' : ''}`;
  };
  const ed = mountItems($('#items'), d.items, { getRate: () => form.elements.taxRate.value, refInfo, autoPrice: true });
  form.elements.taxRate.addEventListener('input', ed.updateTotals);

  let lastOrderId = form.elements.orderId.value;
  form.elements.orderId.addEventListener('change', () => {
    const o = getOrder(form.elements.orderId.value);
    if (cleanItems(ed.items).length && !confirm('受注を変更すると明細が置き換わります。よろしいですか？')) {
      form.elements.orderId.value = lastOrderId;
      return;
    }
    lastOrderId = form.elements.orderId.value;
    $('#link-info').innerHTML = linkInfoHTML(o);
    if (o) {
      form.elements.subject.value = o.subject || '';
      form.elements.taxRate.value = o.taxRate ?? db.settings.taxRate;
    }
    ed.setItems(o ? remainingItems(o, d.id) : []);
    if (o && !cleanItems(ed.items).length) toast('この受注は全数納品済みです', 'error');
  });

  form.addEventListener('submit', e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    if (!f.orderId) return toast('紐付ける受注を選択してください', 'error');
    const items = cleanItems(ed.items);
    if (!items.length) return toast('明細を1行以上入力してください（品名は必須です）', 'error');
    if (itemsError(items)) return toast(itemsError(items), 'error');
    const o = getOrder(f.orderId);
    const dmap = deliveredMap(o.id, d.id);
    const over = items.some(it => {
      const line = o.items.find(x => x.id === it.ref);
      return line && toNum(it.qty) > toNum(line.qty) - (dmap[line.id] || 0);
    });
    if (over && !confirm('受注の残数を超えて納品する行があります。このまま保存しますか？')) return;
    // 色ごとの今回の出荷数が現在庫を超えていないか
    const need = {};
    items.forEach(it => { if (it.spec) need[it.spec] = (need[it.spec] || 0) + toNum(it.qty); });
    const short = stockRows(d.id).filter(r => need[r.color] > r.current).map(r => `${r.color}：在庫 ${num(r.current)} ／ 今回 ${num(need[r.color])}`);
    if (short.length && !confirm(`在庫が足りない色があります。\n${short.join('\n')}\n\nこのまま保存しますか？`)) return;
    Object.assign(d, {
      orderId: f.orderId, deliveryDate: f.deliveryDate, subject: f.subject.trim(),
      taxRate: toNum(f.taxRate), items, note: f.note, updatedAt: new Date().toISOString(),
    });
    if (editing) db.deliveries[db.deliveries.indexOf(editing)] = d;
    else db.deliveries.push({ ...d, createdAt: d.updatedAt });
    save();
    toast('納品書を下書きとして保存しました。内容を確認して「発行する」を押してください');
    go(`#/deliveries/${d.id}`);
  });
}

// ---------- 検索 ----------
function viewSearch(query) {
  $('#global-search').elements.q.value = query;
  const q = query.trim().toLowerCase();
  const has = (...vals) => vals.some(v => String(v || '').toLowerCase().includes(q));
  const orderIds = new Set();
  const loosePos = [];
  if (q) {
    db.orders.forEach(o => { if (has(o.orderNo, o.customerPoNo, o.subject, partnerName(o.customerId))) orderIds.add(o.id); });
    db.pos.forEach(p => {
      if (!has(p.poNo, p.subject, partnerName(p.supplierId))) return;
      if (p.orderId && getOrder(p.orderId)) orderIds.add(p.orderId);
      else loosePos.push(p);
    });
    db.deliveries.forEach(d => { if (has(d.dnNo, d.subject) && getOrder(d.orderId)) orderIds.add(d.orderId); });
  }
  const orders = [...orderIds].map(getOrder).sort(byDateNoDesc('orderDate', 'orderNo'));
  const partners = q ? db.partners.filter(p => has(p.name, p.address, p.contact, p.tel)) : [];

  render(`
    <div class="page-head"><h1>検索結果：「${esc(query)}」</h1></div>
    ${!q ? '<div class="card empty">検索したい番号や会社名を入力してください。</div>' : ''}
    ${q && !orders.length && !loosePos.length && !partners.length ? '<div class="card empty">該当するデータはありません。</div>' : ''}
    ${partners.length ? `<section class="card"><h2>取引先</h2><div class="actions">
      ${partners.map(p => `<a class="btn" href="#/partners/${p.id}">${esc(p.name)}</a>`).join('')}</div></section>` : ''}
    ${orders.map(o => `<section class="card search-result">
      <h3>${tag(o.orderNo, 'is-order')} ${esc(partnerName(o.customerId))} ${o.subject ? '／' + esc(o.subject) : ''} ${badge(orderStatus(o))}</h3>
      ${chainHTML(o, { withAdd: false })}</section>`).join('')}
    ${loosePos.length ? `<section class="card"><h2>受注に紐付いていない発注書</h2>
      ${loosePos.map(p => `<p><a href="#/pos/${p.id}">${docTag('po', p)}</a> ${esc(partnerName(p.supplierId))} ${esc(p.subject)}</p>`).join('')}</section>` : ''}`);
}

// ---------- 取引先 ----------
function viewPartners() {
  const list = [...db.partners].sort(byField('name'));
  const usage = p => partnerDocs(p.id).orders.length + partnerDocs(p.id).pos.length;
  render(`
    <div class="page-head"><h1>取引先</h1>
      <div class="actions"><button class="btn btn-primary" data-act="new">＋ 取引先を登録</button></div></div>
    <section class="card">
      ${list.length ? `
      <div class="filters"><input type="search" data-filter placeholder="会社名・住所で絞り込み"><span class="muted" data-count></span></div>
      <p class="hint" style="margin:-6px 0 10px">行を押すと、その取引先に紐付く受注・発注書・納品書を確認できます。</p>
      <div class="table-wrap"><table class="list">
        <thead><tr><th>会社名・氏名</th><th>区分</th><th>住所</th><th>電話</th><th>ご担当者</th>
          <th class="num">受注</th><th class="num">発注書</th><th class="num">納品書</th><th></th></tr></thead>
        <tbody>${list.map(p => {
          const docs = partnerDocs(p.id);
          return `<tr class="clickable" data-href="#/partners/${p.id}" data-search="${esc([p.name, p.address, p.contact, p.tel].join(' '))}">
          <td><b>${esc(p.name)}</b> <span class="muted">${esc(p.honorific)}</span></td><td>${KIND_LABEL[p.kind] || ''}</td>
          <td>${p.zip ? '〒' + esc(p.zip) + ' ' : ''}${esc(p.address)}</td><td>${esc(p.tel)}</td><td>${esc(p.contact)}</td>
          <td class="num">${docs.orders.length}</td><td class="num">${docs.pos.length}</td><td class="num">${docs.dns.length}</td>
          <td><span class="actions"><button class="btn btn-sm" data-edit="${p.id}">編集</button><button class="btn btn-sm btn-danger" data-del="${p.id}">削除</button></span></td>
        </tr>`;
        }).join('')}</tbody></table></div>` :
        '<div class="empty">取引先はまだありません。受注・発注書の入力画面の「＋ 新規」からも登録できます。</div>'}
    </section>`);
  bindListFilter($('#view'));
  $('[data-act=new]').addEventListener('click', async () => { if (await openPartnerDialog(null, 'customer')) viewPartners(); });
  $$('[data-edit]').forEach(b => b.addEventListener('click', async () => {
    if (await openPartnerDialog(getPartner(b.dataset.edit))) viewPartners();
  }));
  $$('[data-del]').forEach(b => b.addEventListener('click', () => {
    const p = getPartner(b.dataset.del);
    if (usage(p)) return alert('この取引先は受注・発注書で使われているため削除できません。');
    if (!confirm(`${p.name} を削除します。よろしいですか？`)) return;
    db.partners = db.partners.filter(x => x.id !== p.id);
    save();
    toast('取引先を削除しました');
    viewPartners();
  }));
}

// 取引先に紐付く書類（お客様としての受注・納品書、仕入先としての発注書）
function partnerDocs(id) {
  const orders = db.orders.filter(o => o.customerId === id);
  const orderIds = new Set(orders.map(o => o.id));
  return {
    orders: orders.sort(byDateNoDesc('orderDate', 'orderNo')),
    pos: db.pos.filter(p => p.supplierId === id).sort(byDateNoDesc('poDate', 'poNo')),
    dns: db.deliveries.filter(d => orderIds.has(d.orderId)).sort(byDateNoDesc('deliveryDate', 'dnNo')),
  };
}

function viewPartnerDetail(id) {
  const p = getPartner(id);
  if (!p) return notFound();
  const docs = partnerDocs(id);
  const sum = list => yen(list.reduce((s, d) => s + calc(d).total, 0));
  const open = docs.orders.filter(o => orderStatus(o).key !== 'done').length;

  render(`
    <div class="page-head">
      <div><div class="crumb"><a href="#/partners">取引先</a> › 詳細</div>
        <h1>${esc(p.name)} <span class="muted" style="font-size:1rem">${esc(p.honorific)}</span>
          <span class="badge st-po">${KIND_LABEL[p.kind] || ''}</span></h1></div>
      <div class="actions">
        <a class="btn btn-primary" href="#/orders/new?customer=${p.id}">＋ この取引先の受注を登録</a>
        <a class="btn" href="#/pos/new?supplier=${p.id}">＋ この取引先へ発注書を作成</a>
        <button class="btn" data-act="edit">✎ 取引先情報を編集</button>
      </div>
    </div>
    <section class="card">
      <h2>取引先情報</h2>
      <dl class="info">
        <div class="span-2"><dt>住所</dt><dd>${p.zip ? '〒' + esc(p.zip) + '　' : ''}${esc(p.address) || '<span class="muted">未登録</span>'}</dd></div>
        <div><dt>電話番号</dt><dd>${esc(p.tel) || '<span class="muted">未登録</span>'}</dd></div>
        <div><dt>ご担当者</dt><dd>${esc(p.contact) || '<span class="muted">未登録</span>'}</dd></div>
      </dl>
      <p class="hint">ここで変更した内容は、この取引先あての発注書・納品書（作成済みのものも含む）に反映されます。</p>
    </section>
    <div class="tiles">
      <div class="tile"><div class="tile-label">受注</div><div class="tile-value">${docs.orders.length} 件</div><div class="tile-sub">${sum(docs.orders)}（税込）</div></div>
      <div class="tile ${open ? 'is-alert' : ''}"><div class="tile-label">未納品の受注</div><div class="tile-value">${open} 件</div><div class="tile-sub">納品が完了していない受注</div></div>
      <div class="tile"><div class="tile-label">納品書</div><div class="tile-value">${docs.dns.length} 件</div><div class="tile-sub">${sum(docs.dns)}（税込）</div></div>
      <div class="tile"><div class="tile-label">発注書（この取引先へ）</div><div class="tile-value">${docs.pos.length} 件</div><div class="tile-sub">${sum(docs.pos)}（税込）</div></div>
    </div>
    <section class="card">
      <h2>受注（お客様として）</h2>
      ${docs.orders.length ? orderTableHTML(docs.orders) : `<div class="empty">この取引先の受注はまだありません。<br>
        <a class="btn btn-primary" href="#/orders/new?customer=${p.id}">＋ この取引先の受注を登録</a></div>`}
    </section>
    <section class="card">
      <h2>納品書（お客様として）</h2>
      ${docs.dns.length ? docTableHTML('dn', docs.dns) : '<div class="empty">この取引先あての納品書はまだありません。受注の画面から作成できます。</div>'}
    </section>
    <section class="card">
      <h2>発注書（仕入先として）</h2>
      ${docs.pos.length ? docTableHTML('po', docs.pos) : `<div class="empty">この取引先への発注書はまだありません。<br>
        <a class="btn" href="#/pos/new?supplier=${p.id}">＋ この取引先へ発注書を作成</a></div>`}
    </section>`);

  bindListFilter($('#view'));
  $('[data-act=edit]').addEventListener('click', async () => {
    if (await openPartnerDialog(p)) viewPartnerDetail(id);
  });
}

// ---------- 在庫 ----------
function viewStock() {
  const rows = stockRows();
  const sum = f => num(rows.reduce((s, r) => s + r[f], 0));
  const receipts = [...db.receipts].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  render(`
    <div class="page-head"><h1>在庫（色別）</h1></div>
    <p class="hint" style="margin:-8px 0 14px">
      現在庫 ＝ 期首在庫 ＋ 入庫累計 − 出荷済（納品書の数量）／ 有効在庫 ＝ 現在庫 − 引当（受注のうち、まだ納品していない数量）<br>
      納品書を作ると出荷済に、受注を登録すると引当に自動で反映されます。<b>期首在庫と発注点だけ</b>を入力してください。
    </p>
    <section class="card">
      <form id="stock-form">
        <div class="table-wrap"><table class="list stock">
          <thead><tr><th>色</th><th class="num">期首在庫</th><th class="num">入庫累計</th><th class="num">出荷済</th><th class="num">現在庫</th>
            <th class="num">引当（未納品）</th><th class="num">有効在庫</th><th class="num">発注点</th><th>判定</th></tr></thead>
          <tbody>${rows.map(r => `<tr>
            <td><b>${esc(r.color)}</b></td>
            <td class="num"><input type="number" step="any" class="num" data-opening="${esc(r.color)}" value="${r.opening || ''}" placeholder="0"></td>
            <td class="num">${num(r.received)}</td><td class="num">${num(r.shipped)}</td><td class="num"><b>${num(r.current)}</b></td>
            <td class="num">${num(r.allocated)}</td><td class="num"><b>${num(r.available)}</b></td>
            <td class="num"><input type="number" step="any" class="num" data-reorder="${esc(r.color)}" value="${r.reorder || ''}" placeholder="0"></td>
            <td><span class="badge ${JUDGE[r.judge]}">${r.judge}</span></td></tr>`).join('')}</tbody>
          <tfoot><tr><th>合計</th><td class="num">${sum('opening')}</td><td class="num">${sum('received')}</td><td class="num">${sum('shipped')}</td>
            <td class="num">${sum('current')}</td><td class="num">${sum('allocated')}</td><td class="num">${sum('available')}</td><td></td><td></td></tr></tfoot>
        </table></div>
        <div class="actions" style="margin-top:12px"><button class="btn btn-primary" type="submit">期首在庫・発注点を保存する</button></div>
      </form>
    </section>
    <section class="card">
      <h2>入庫を登録</h2>
      <p class="hint" style="margin:-6px 0 10px">仕入・生産などで在庫が増えたときに登録します。「入庫累計」に加算されます。</p>
      <form id="receipt-form" class="grid-4" autocomplete="off">
        <div class="field"><label>入庫日</label><input type="date" name="date" value="${today()}"></div>
        <div class="field"><label>色 <span class="req">必須</span></label><select name="color">${colorOptions('')}</select></div>
        <div class="field"><label>数量 <span class="req">必須</span></label><input type="number" name="qty" step="any" class="num"></div>
        <div class="field"><label>備考</label><input name="note" placeholder="例：〇〇より入荷"></div>
        <div class="span-all"><button class="btn btn-primary" type="submit">＋ 入庫を登録</button></div>
      </form>
    </section>
    <section class="card">
      <h2>入庫記録</h2>
      ${receipts.length ? `<div class="table-wrap"><table class="list">
        <thead><tr><th>入庫日</th><th>色</th><th class="num">数量</th><th>備考</th><th></th></tr></thead>
        <tbody>${receipts.map(r => `<tr><td class="nowrap">${esc(r.date)}</td><td>${esc(r.color)}</td><td class="num">${num(r.qty)}</td>
          <td class="wide">${esc(r.note)}</td><td><button class="btn btn-sm btn-danger" data-del-receipt="${r.id}">削除</button></td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty">入庫記録はまだありません。</div>'}
    </section>`);

  $('#stock-form').addEventListener('submit', e => {
    e.preventDefault();
    const opening = {};
    const reorder = {};
    $$('[data-opening]').forEach(i => { if (i.value !== '') opening[i.dataset.opening] = toNum(i.value); });
    $$('[data-reorder]').forEach(i => { if (i.value !== '') reorder[i.dataset.reorder] = toNum(i.value); });
    db.stock = { opening, reorder };
    save();
    toast('期首在庫・発注点を保存しました');
    viewStock();
  });
  $('#receipt-form').addEventListener('submit', e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!f.color) return toast('色を選択してください', 'error');
    if (!toNum(f.qty)) return toast('数量を入力してください', 'error');
    db.receipts.push({ id: uid(), date: f.date, color: f.color, qty: toNum(f.qty), note: f.note.trim() });
    save();
    toast(`入庫（${f.color} ${num(f.qty)}）を登録しました`);
    viewStock();
  });
  $$('[data-del-receipt]').forEach(b => b.addEventListener('click', () => {
    const r = db.receipts.find(x => x.id === b.dataset.delReceipt);
    if (!confirm(`入庫記録（${r.date} ${r.color} ${num(r.qty)}）を削除しますか？`)) return;
    db.receipts = db.receipts.filter(x => x.id !== r.id);
    save();
    toast('入庫記録を削除しました');
    viewStock();
  }));
}

// ---------- 見込み案件 ----------
function viewProspects(editId) {
  const editing = editId ? db.prospects.find(x => x.id === editId) : null;
  const p = editing || { date: today(), company: '', product: db.products[0]?.name || '', color: '', qty: '', dueDate: '', answerDate: '', staff: '', note: '' };
  const list = [...db.prospects].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  render(`
    <div class="page-head"><h1>見込み案件</h1></div>
    <p class="hint" style="margin:-8px 0 14px">まだ注文になっていない案件を記録します。注文が決まったら「受注にする」で受注登録の画面へ引き継げます。</p>
    <section class="card">
      <h2>${editing ? '見込み案件を編集' : '見込み案件を追加'}</h2>
      <form id="prospect-form" class="grid-4" autocomplete="off">
        <div class="field"><label>受付日</label><input type="date" name="date" value="${esc(p.date)}"></div>
        <div class="field span-2"><label>会社名 <span class="req">必須</span></label><input name="company" value="${esc(p.company)}" list="partner-names" placeholder="取引先から選ぶか入力"></div>
        <div class="field"><label>担当者</label><select name="staff">${staffOptions(p.staff)}</select></div>
        <div class="field"><label>品名</label><select name="product">${productOptions(p.product)}</select></div>
        <div class="field"><label>色</label><select name="color">${colorOptions(p.color)}</select></div>
        <div class="field"><label>数量</label><input type="number" name="qty" step="any" class="num" value="${esc(p.qty)}"></div>
        <div class="field"><label>希望納期</label><input type="date" name="dueDate" value="${esc(p.dueDate)}"></div>
        <div class="field"><label>回答納期</label><input type="date" name="answerDate" value="${esc(p.answerDate)}"></div>
        <div class="field span-2"><label>備考</label><input name="note" value="${esc(p.note)}"></div>
        <div class="span-all actions">
          ${editing ? '<a class="btn" href="#/prospects">キャンセル</a>' : ''}
          <button class="btn btn-primary" type="submit">${editing ? '保存する' : '＋ 追加する'}</button>
        </div>
      </form>
      <datalist id="partner-names">${db.partners.map(x => `<option value="${esc(x.name)}">`).join('')}</datalist>
    </section>
    <section class="card">
      ${list.length ? `
      <div class="filters"><input type="search" data-filter placeholder="会社名・色・担当で絞り込み"><span class="muted" data-count></span></div>
      <div class="table-wrap"><table class="list">
        <thead><tr><th>受付日</th><th>会社名</th><th>品名</th><th>色</th><th class="num">数量</th><th>希望納期</th><th>回答納期</th><th>担当</th><th>備考</th><th></th></tr></thead>
        <tbody>${list.map(x => {
          const o = x.orderId ? getOrder(x.orderId) : null;
          return `<tr data-search="${esc([x.company, x.product, x.color, x.staff, x.note].join(' '))}">
          <td class="nowrap">${esc(x.date)}</td><td class="wide">${esc(x.company)}</td><td>${esc(x.product)}</td><td>${esc(x.color)}</td>
          <td class="num">${num(x.qty)}</td><td class="nowrap">${esc(x.dueDate)}</td><td class="nowrap">${esc(x.answerDate)}</td><td>${esc(x.staff)}</td>
          <td class="wide">${esc(x.note)}</td>
          <td><span class="actions">
            ${o ? `<a href="#/orders/${o.id}">${tag(o.orderNo, 'is-order')}</a>` : `<a class="btn btn-sm btn-primary" href="#/orders/new?prospect=${x.id}">受注にする</a>`}
            <a class="btn btn-sm" href="#/prospects?edit=${x.id}">編集</a>
            <button class="btn btn-sm btn-danger" data-del-prospect="${x.id}">削除</button></span></td></tr>`;
        }).join('')}</tbody></table></div>` : '<div class="empty">見込み案件はまだありません。</div>'}
    </section>`);

  bindListFilter($('#view'));
  $('#prospect-form').addEventListener('submit', e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.company = f.company.trim();
    if (!f.company) return toast('会社名を入力してください', 'error');
    const rec = { date: f.date, company: f.company, product: f.product, color: f.color, qty: toNum(f.qty), dueDate: f.dueDate,
      answerDate: f.answerDate, staff: f.staff, note: f.note.trim() };
    if (editing) Object.assign(editing, rec);
    else db.prospects.push({ id: uid(), orderId: '', ...rec });
    save();
    toast('見込み案件を保存しました');
    if (editing) go('#/prospects');
    else viewProspects();
  });
  $$('[data-del-prospect]').forEach(b => b.addEventListener('click', () => {
    const x = db.prospects.find(r => r.id === b.dataset.delProspect);
    if (!confirm(`見込み案件（${x.company}）を削除しますか？`)) return;
    db.prospects = db.prospects.filter(r => r.id !== x.id);
    save();
    toast('見込み案件を削除しました');
    viewProspects();
  }));
}

// ---------- 商品・色マスタ ----------
function viewMasters() {
  const allItems = () => [...db.orders, ...db.pos, ...db.deliveries].flatMap(d => d.items);
  const usedName = name => allItems().some(it => it.name === name);
  const usedColor = c => allItems().some(it => it.spec === c);
  render(`
    <div class="page-head"><h1>商品・色・担当者マスタ</h1></div>
    <p class="hint" style="margin:-8px 0 14px">ここに登録した商品と色が、受注・発注書・納品書の明細でプルダウンから選べるようになります。</p>
    <section class="card">
      <h2>色</h2>
      <div class="chips">${db.colors.map((c, i) => `<span class="chip">
          <button type="button" class="chip-move" data-move="${i}" data-dir="-1" title="前へ" ${i === 0 ? 'disabled' : ''}>‹</button>
          ${esc(c)}
          <button type="button" class="chip-move" data-move="${i}" data-dir="1" title="後ろへ" ${i === db.colors.length - 1 ? 'disabled' : ''}>›</button>
          <button type="button" class="chip-del" data-del-color="${i}" title="削除">✕</button></span>`).join('') || '<span class="muted">色がありません</span>'}</div>
      <form class="with-btn" id="color-form" style="max-width:420px;margin-top:14px" autocomplete="off">
        <input name="color" placeholder="追加する色（例：シルバー）">
        <button class="btn btn-primary" type="submit">＋ 色を追加</button>
      </form>
      <p class="hint">‹ › で並び順（プルダウンの表示順）を変えられます。色は在庫画面の行にもなります。</p>
    </section>
    <section class="card">
      <h2>担当者</h2>
      <div class="chips">${db.staff.map((s, i) => `<span class="chip">${esc(s)}
          <button type="button" class="chip-del" data-del-staff="${i}" title="削除">✕</button></span>`).join('') || '<span class="muted">担当者がいません</span>'}</div>
      <form class="with-btn" id="staff-form" style="max-width:420px;margin-top:14px" autocomplete="off">
        <input name="staff" placeholder="追加する担当者（例：山田）">
        <button class="btn btn-primary" type="submit">＋ 担当者を追加</button>
      </form>
    </section>
    <section class="card">
      <h2>商品</h2>
      <div class="table-wrap"><table class="list">
        <thead><tr><th>品名</th><th>単位</th><th class="num">標準単価（税抜）</th><th>色を選ぶ</th><th></th></tr></thead>
        <tbody>${db.products.map(p => `<tr data-id="${p.id}">
          <td><input data-f="name" value="${esc(p.name)}" placeholder="品名"></td>
          <td style="width:110px"><input data-f="unit" value="${esc(p.unit)}" list="units"></td>
          <td style="width:160px"><input data-f="price" type="number" step="any" class="num" value="${esc(p.price)}"></td>
          <td style="width:110px"><label><input data-f="useColor" type="checkbox" ${p.useColor ? 'checked' : ''} style="width:auto"> 選ぶ</label></td>
          <td style="width:80px"><button type="button" class="btn btn-sm btn-danger" data-del-product="${p.id}">削除</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="hint">先頭の商品が、新しい明細行で最初から選ばれます。標準単価は受注・納品書の明細に自動で入ります（発注書は仕入単価を入力するため入りません）。</p>
      <div class="actions" style="margin-top:12px">
        <button type="button" class="btn btn-ghost" data-act="add-product">＋ 商品を追加</button>
        <button type="button" class="btn btn-primary" data-act="save-products">商品を保存する</button>
      </div>
    </section>`);

  const readProducts = () => $$('tr[data-id]').map(tr => ({
    id: tr.dataset.id,
    name: $('[data-f=name]', tr).value.trim(),
    unit: $('[data-f=unit]', tr).value.trim(),
    price: toNum($('[data-f=price]', tr).value),
    useColor: $('[data-f=useColor]', tr).checked,
  }));

  $('#color-form').addEventListener('submit', e => {
    e.preventDefault();
    const c = e.target.elements.color.value.trim();
    if (!c) return;
    if (db.colors.includes(c)) return toast('その色は既に登録されています', 'error');
    db.colors.push(c);
    save();
    toast(`色「${c}」を追加しました`);
    viewMasters();
    $('#color-form').elements.color.focus();
  });
  $('#staff-form').addEventListener('submit', e => {
    e.preventDefault();
    const s = e.target.elements.staff.value.trim();
    if (!s) return;
    if (db.staff.includes(s)) return toast('その担当者は既に登録されています', 'error');
    db.staff.push(s);
    save();
    toast(`担当者「${s}」を追加しました`);
    viewMasters();
  });
  $$('[data-del-staff]').forEach(b => b.addEventListener('click', () => {
    const s = db.staff[+b.dataset.delStaff];
    if (!confirm(`担当者「${s}」を選択肢から削除しますか？（登録済みの受注の担当者はそのまま残ります）`)) return;
    db.staff = db.staff.filter(x => x !== s);
    save();
    toast('担当者を削除しました');
    viewMasters();
  }));
  $$('[data-move]').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.move;
    const j = i + +b.dataset.dir;
    [db.colors[i], db.colors[j]] = [db.colors[j], db.colors[i]];
    save();
    viewMasters();
  }));
  $$('[data-del-color]').forEach(b => b.addEventListener('click', () => {
    const i = +b.dataset.delColor;
    const c = db.colors[i];
    const msg = usedColor(c)
      ? `色「${c}」は登録済みの書類で使われています（書類の内容はそのまま残ります）。\n選択肢から削除しますか？`
      : `色「${c}」を削除しますか？`;
    if (!confirm(msg)) return;
    db.colors.splice(i, 1);
    save();
    toast('色を削除しました');
    viewMasters();
  }));
  $('[data-act=add-product]').addEventListener('click', () => {
    db.products = readProducts();
    db.products.push({ id: uid(), name: '', unit: '個', price: 0, useColor: false });
    viewMasters();
    $$('tr[data-id] [data-f=name]').pop().focus();
  });
  $$('[data-del-product]').forEach(b => b.addEventListener('click', () => {
    const list = readProducts();
    const p = list.find(x => x.id === b.dataset.delProduct);
    if (list.length <= 1) return toast('商品は1件以上必要です', 'error');
    if (p.name && usedName(p.name) && !confirm(`「${p.name}」は登録済みの書類で使われています（書類の内容はそのまま残ります）。\n選択肢から削除しますか？`)) return;
    db.products = list.filter(x => x.id !== p.id);
    save();
    toast('商品を削除しました');
    viewMasters();
  }));
  $('[data-act=save-products]').addEventListener('click', () => {
    const list = readProducts();
    if (list.some(p => !p.name)) return toast('品名が空の商品があります', 'error');
    if (new Set(list.map(p => p.name)).size !== list.length) return toast('同じ品名の商品が重複しています', 'error');
    db.products = list;
    save();
    toast('商品を保存しました');
    viewMasters();
  });
}

// ---------- 設定 ----------
function viewSettings() {
  const s = db.settings;
  const c = s.company;
  render(`
    <div class="page-head"><h1>設定</h1></div>
    <form id="settings-form" autocomplete="off">
      <section class="card">
        <h2>自社情報 <span class="opt">（発注書・納品書の差出人として印字されます）</span></h2>
        <div class="grid-2">
          <div class="field"><label>会社名</label><input name="name" value="${esc(c.name)}" placeholder="例：株式会社〇〇"></div>
          <div class="field"><label>部署名</label><input name="dept" value="${esc(c.dept)}" placeholder="例：防災事業部"></div>
          <div class="field"><label>郵便番号</label><input name="zip" value="${esc(c.zip)}"></div>
          <div class="field"><label>インボイス登録番号</label><input name="invoiceNo" value="${esc(c.invoiceNo)}" placeholder="例：T1234567890123"></div>
          <div class="field span-2"><label>住所</label><input name="address" value="${esc(c.address)}"></div>
          <div class="field"><label>電話番号</label><input name="tel" value="${esc(c.tel)}"></div>
          <div class="field"><label>FAX</label><input name="fax" value="${esc(c.fax)}"></div>
          <div class="field"><label>メールアドレス</label><input name="email" value="${esc(c.email)}"></div>
          <div class="field"><label>担当者名</label><input name="person" value="${esc(c.person)}"></div>
          <div class="field span-2">
            <label><input type="checkbox" name="showLogo" ${s.showLogo ? 'checked' : ''} style="width:auto;margin-right:6px">会社ロゴを書類に印字する</label>
            <img src="${LOGO_SRC}" alt="" style="height:32px;align-self:flex-start;margin-top:4px">
          </div>
        </div>
      </section>
      <section class="card">
        <h2>番号・税率</h2>
        <div class="grid-4">
          <div class="field"><label>自社受注No.の頭文字</label><input name="p_order" value="${esc(s.prefix.order)}"></div>
          <div class="field"><label>発注No.の頭文字</label><input name="p_po" value="${esc(s.prefix.po)}"></div>
          <div class="field"><label>納品書No.の頭文字</label><input name="p_dn" value="${esc(s.prefix.dn)}"></div>
          <div class="field"><label>標準の消費税率（%）</label><input type="number" name="taxRate" value="${esc(s.taxRate)}" min="0" step="any" class="num"></div>
          <div class="field"><label>請求書No.の頭文字</label><input name="p_inv" value="${esc(s.prefix.inv)}"></div>
          <div class="field"><label>領収書No.の頭文字</label><input name="p_rc" value="${esc(s.prefix.rc)}"></div>
          <div class="field span-2"><label>発注書の標準の支払条件</label><input name="paymentTerms" value="${esc(s.paymentTerms)}"></div>
        </div>
        <p class="hint">番号は「頭文字-西暦-連番」の形で自動採番されます（例：${esc(s.prefix.order)}-${new Date().getFullYear()}-0001）。
          請求書・領収書は納品書の番号の頭文字を変えたものになります（例：${esc(s.prefix.dn)}-${new Date().getFullYear()}-0001 → ${esc(s.prefix.inv)}-${new Date().getFullYear()}-0001）。</p>
      </section>
      <section class="card">
        <h2>請求書・領収書・納期の警告</h2>
        <div class="grid-2">
          <div class="field"><label>お振込先 <span class="opt">（請求書に印字）</span></label>
            <textarea name="bankAccount" placeholder="例：〇〇銀行 〇〇支店 普通 1234567 口座名義">${esc(s.bankAccount)}</textarea></div>
          <div class="field"><label>領収書の但し書き（標準）</label><input name="receiptFor" value="${esc(s.receiptFor)}">
            <p class="hint">書類ごとに変えることもできます。</p></div>
          <div class="field"><label>納期の警告 <span class="opt">（納期まで何日以内で知らせるか）</span></label>
            <input type="number" name="dueWarnDays" value="${esc(s.dueWarnDays)}" min="0" step="1" class="num" style="max-width:120px"></div>
        </div>
      </section>
      <div class="form-actions"><button class="btn btn-primary" type="submit">設定を保存する</button></div>
    </form>
    <section class="card">
      <h2>データの保存・バックアップ</h2>
      <p class="hint" style="margin-bottom:12px">${REMOTE
        ? 'データは Google スプレッドシートに保存され、社内で共有されています。他の人の変更は 1 分ごと（または画面に戻ったとき）に自動で反映されます。<br>Excel から取り込んだデータは「バックアップから復元」で読み込めます（スプレッドシートの内容がすべて置き換わります）。'
        : 'データはこのパソコンのブラウザ内に保存されています（お試し用）。<b>定期的にバックアップを保存</b>してください。社内で共有するには README の手順で Google スプレッドシート版を設定してください。'}</p>
      <div class="actions">
        <button class="btn" data-act="export">⬇ バックアップを保存（JSON）</button>
        <label class="btn">⬆ バックアップから復元<input type="file" accept=".json,application/json" data-act="import" hidden></label>
        <button class="btn" data-act="csv">⬇ 紐付け一覧を Excel 用 CSV で保存</button>
        <button class="btn" data-act="sample">サンプルデータを追加</button>
        <button class="btn btn-danger" data-act="reset">すべてのデータを削除</button>
      </div>
    </section>`);

  $('#settings-form').addEventListener('submit', e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const prefixes = [f.p_order, f.p_po, f.p_dn, f.p_inv, f.p_rc].map(v => v.trim());
    if (prefixes.some(v => !/^[A-Za-z0-9]+$/.test(v))) return toast('番号の頭文字は半角英数字で入力してください', 'error');
    s.company = { name: f.name, dept: f.dept, zip: f.zip, address: f.address, tel: f.tel, fax: f.fax, email: f.email, invoiceNo: f.invoiceNo, person: f.person };
    s.showLogo = f.showLogo === 'on';
    s.paymentTerms = f.paymentTerms.trim();
    s.prefix = { order: prefixes[0], po: prefixes[1], dn: prefixes[2], inv: prefixes[3], rc: prefixes[4] };
    s.taxRate = toNum(f.taxRate);
    s.bankAccount = f.bankAccount.trim();
    s.receiptFor = f.receiptFor.trim();
    s.dueWarnDays = toNum(f.dueWarnDays);
    save();
    renderAlerts();
    toast('設定を保存しました');
  });
  $('[data-act=export]').addEventListener('click', () => {
    download(`resqmej_backup_${today()}.json`, JSON.stringify(db, null, 2), 'application/json');
  });
  $('[data-act=import]').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.orders) || !Array.isArray(data.partners)) throw new Error('形式が正しくありません');
      if (!confirm('現在のデータをバックアップの内容で置き換えます。よろしいですか？')) return;
      toast('復元しています…');
      await replaceAll(normalize(data));
      toast('バックアップから復元しました');
      viewSettings();
    } catch (err) {
      toast('復元できませんでした：' + (err.message || err), 'error');
    }
  });
  $('[data-act=csv]').addEventListener('click', exportCsv);
  $('[data-act=sample]').addEventListener('click', loadSample);
  $('[data-act=reset]').addEventListener('click', async () => {
    if (!confirm(`すべてのデータ（受注・発注書・納品書・取引先・在庫・設定）を削除します。${REMOTE ? '社内の全員のデータが消えます。' : ''}元に戻せません。よろしいですか？`)) return;
    if (prompt('確認のため「削除」と入力してください') !== '削除') return;
    try {
      await replaceAll(defaultData());
    } catch (err) {
      return toast('削除できませんでした：' + (err.message || err), 'error');
    }
    toast('すべてのデータを削除しました');
    go('#/');
  });
}

const csvNo = (type, d) => (stateOf(d) === 'draft' ? '（下書き）' : d[DOC[type].noField] + (isLive(d) ? '' : '（取消）'));

function exportCsv() {
  const head = ['自社受注No.', 'お客様発注No.', '受注日', 'お客様', '件名', '明細', '希望納期', '回答納期', '担当者', '受注金額(税込)', '状況', '請求書',
    '発注No.', '仕入先', '発注金額(税込)', '納品書No.', '納品日', '納品金額(税込)'];
  const rows = [head];
  [...db.orders].sort(byField('orderNo')).forEach(o => {
    const base = [o.orderNo, o.customerPoNo, o.orderDate, partnerName(o.customerId), o.subject, itemsSummary(o.items), o.dueDate, o.answerDate,
      o.staff, calc(o).total, orderStatus(o).label, o.billing || '未処理'];
    const pos = posOf(o.id);
    const dns = dnsOf(o.id);
    const n = Math.max(1, pos.length, dns.length);
    for (let i = 0; i < n; i++) {
      const p = pos[i];
      const d = dns[i];
      rows.push([...base,
        p && csvNo('po', p), p && partnerName(p.supplierId), p && calc(p).total,
        d && csvNo('dn', d), d?.deliveryDate, d && calc(d).total]);
    }
  });
  db.pos.filter(p => !getOrder(p.orderId)).forEach(p => {
    rows.push(['', '', '', '', p.subject, itemsSummary(p.items), '', '', '', '', '紐付けなし', '', csvNo('po', p), partnerName(p.supplierId), calc(p).total, '', '', '']);
  });
  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  download(`resqmej_紐付け一覧_${today()}.csv`, '﻿' + csv, 'text/csv');
}

// ---------- サンプルデータ ----------
function loadSample() {
  if (db.orders.length && !confirm('今のデータにサンプルデータを追加します。よろしいですか？')) return;
  const P = (name, kind, contact, address) => {
    const p = { id: uid(), name, kind, honorific: '御中', zip: '', address, tel: '', contact };
    db.partners.push(p);
    return p;
  };
  const cust1 = P('株式会社アルファ商事', 'customer', '購買部 田中様', '神奈川県横浜市西区みなとみらい2-2-1');
  const cust2 = P('ベータ防災株式会社', 'customer', '営業部 鈴木様', '埼玉県さいたま市大宮区桜木町1-7-5');
  const sup1 = P('ガンマ製作所株式会社', 'supplier', '営業課 高橋様', '群馬県高崎市八島町1-1');
  P('デルタ梱包資材株式会社', 'supplier', '', '埼玉県熊谷市筑波1-1-1');
  const t = today();
  const RQM = db.products[0]?.name || 'レスキューミー';
  const I = (name, spec, qty, unit, price) => ({ id: uid(), name, spec, qty, unit, price });

  const addOrder = o => { const rec = { id: uid(), orderNo: nextNo('order'), taxRate: 10, note: '', createdAt: new Date().toISOString(), ...o }; db.orders.push(rec); return rec; };
  const addPo = (o, supplier, priceRate, extra = {}) => {
    const p = { id: uid(), poNo: nextNo('po'), orderId: o.id, supplierId: supplier.id, poDate: o.orderDate, dueDate: addDays(o.dueDate, -2),
      deliveryPlace: '当社倉庫', paymentTerms: db.settings.paymentTerms, subject: o.subject, taxRate: 10, note: '',
      items: o.items.map(it => ({ id: uid(), ref: it.id, name: it.name, spec: it.spec, qty: it.qty, unit: it.unit, price: Math.round(it.price * priceRate) })), ...extra };
    db.pos.push(p);
    return p;
  };
  const addDn = (o, date, qtyFn) => {
    const d = { id: uid(), dnNo: nextNo('dn'), orderId: o.id, deliveryDate: date, subject: o.subject, taxRate: 10, note: '',
      items: o.items.map(it => ({ id: uid(), ref: it.id, name: it.name, spec: it.spec, qty: qtyFn(it), unit: it.unit, price: it.price })).filter(it => it.qty > 0) };
    db.deliveries.push(d);
    return d;
  };

  const o1 = addOrder({ customerPoNo: 'AL-26-0815', customerId: cust1.id, orderDate: addDays(t, -20), dueDate: addDays(t, -5), subject: '社用車配備用 防災用品',
    items: [I(RQM, 'オレンジ', 50, '個', 1250), I(RQM, 'ブラック', 50, '個', 1250)] });
  addPo(o1, sup1, 0.6);
  addDn(o1, addDays(t, -6), it => it.qty);

  const o2 = addOrder({ customerPoNo: 'B-PO-5521', customerId: cust2.id, orderDate: addDays(t, -10), dueDate: addDays(t, 3), subject: '販売店向け 防災用品',
    items: [I(RQM, 'イエロー', 100, '個', 1250), I(RQM, 'レッド', 100, '個', 1250), I(RQM, 'ブルー', 50, '個', 1250)] });
  addPo(o2, sup1, 0.6);
  addDn(o2, addDays(t, -2), it => Math.floor(it.qty / 2));

  addOrder({ customerPoNo: '', customerId: cust1.id, orderDate: addDays(t, -1), dueDate: addDays(t, 14), subject: '追加注文',
    items: [I(RQM, 'ピンク', 20, '個', 1250), I(RQM, 'ホワイト', 20, '個', 1250)] });
  migrateIssued(); // サンプルの発注書・納品書は発行済にする
  save();
  toast('サンプルデータを追加しました');
  if (location.hash === '#/orders') route();
  else go('#/orders');
}

// ---------- 起動 ----------
$('#global-search').addEventListener('submit', e => {
  e.preventDefault();
  go('#/search?q=' + encodeURIComponent(e.target.elements.q.value.trim()));
});
// 画面内リンクはハッシュの変更として扱う（Apps Script の画面内でもページ移動しないように）
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#"]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  go(a.getAttribute('href'));
});
window.addEventListener('hashchange', route);

if (REMOTE) {
  render('<div class="card empty">データを読み込んでいます…</div>');
  reload().then(() => { route(); popupAlerts(); }, err => {
    render(`<div class="card empty">データを読み込めませんでした。<br>${esc(err.message || err)}<br><button class="btn" onclick="location.reload()">再読み込み</button></div>`);
  });
  setInterval(refreshIfIdle, 60000);
  document.addEventListener('visibilitychange', refreshIfIdle);
} else {
  window.addEventListener('storage', e => { if (e.key === STORE_KEY) { db = load(); migrateIssued(); route(); } });
  if (migrateIssued()) save();
  route();
  popupAlerts();
}
