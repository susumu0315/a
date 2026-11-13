/* resqmej 受注・発注管理
 * データの流れ：受注（お客様発注No.・自社受注No.）→ 発注書（発注No.）→ 納品書（納品書No.）
 * すべての書類は「自社受注」を軸に紐付けられます。データはブラウザ（localStorage）に保存されます。
 */
'use strict';

const APP_TITLE = 'resqmej 受注・発注管理';
const STORE_KEY = 'resqmej-data-v1';
const KIND_LABEL = { customer: '顧客', supplier: '仕入先', both: '顧客・仕入先' };
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

function defaultData() {
  return {
    version: 2,
    settings: {
      company: { ...COMPANY_DEFAULT },
      showLogo: true,
      paymentTerms: '月末締め翌月末現金振込',
      taxRate: 10,
      prefix: { order: 'JO', po: 'PO', dn: 'DN' },
    },
    partners: [],
    orders: [],
    pos: [],
    deliveries: [],
  };
}

function normalize(d) {
  const def = defaultData();
  const s = d.settings || {};
  let company = { ...def.settings.company, ...(s.company || {}) };
  // 旧版で自社情報が未登録（またはサンプルのまま）なら初期値の自社情報に置き換える
  if ((d.version || 1) < 2 && (!company.name || company.name === SAMPLE_COMPANY_NAME)) company = { ...COMPANY_DEFAULT };
  return {
    ...def,
    ...d,
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

let db = load();

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch (e) {
    alert('保存に失敗しました：' + e.message);
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
    if (d.id === excludeDnId) return;
    d.items.forEach(it => { if (it.ref) map[it.ref] = (map[it.ref] || 0) + toNum(it.qty); });
  });
  return map;
}

function orderStatus(o) {
  const items = o.items.filter(it => toNum(it.qty) > 0);
  const dmap = deliveredMap(o.id);
  const any = Object.values(dmap).some(v => v > 0);
  const all = items.length > 0 && items.every(it => (dmap[it.id] || 0) >= toNum(it.qty));
  const key = all ? 'done' : any ? 'partial' : posOf(o.id).length ? 'po' : 'new';
  return { key, ...STATUS[key] };
}

const badge = st => `<span class="badge ${st.cls}">${st.label}</span>`;
const tag = (no, cls) => (no ? `<span class="no-tag ${cls}">${esc(no)}</span>` : '<span class="muted">—</span>');
const blankItem = () => ({ id: uid(), name: '', spec: '', qty: 1, unit: '個', price: '' });

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
  [/^\/orders\/new$/, () => viewOrderForm(null)],
  [/^\/orders\/([^/]+)\/edit$/, m => viewOrderForm(m[1])],
  [/^\/orders\/([^/]+)$/, m => viewOrderDetail(m[1])],
  [/^\/pos$/, () => viewDocList('po')],
  [/^\/pos\/new$/, (m, q) => viewPoForm(null, q.get('order'))],
  [/^\/pos\/([^/]+)\/edit$/, m => viewPoForm(m[1])],
  [/^\/pos\/([^/]+)$/, m => viewDocDetail('po', m[1])],
  [/^\/deliveries$/, () => viewDocList('dn')],
  [/^\/deliveries\/new$/, (m, q) => viewDnForm(null, q.get('order'))],
  [/^\/deliveries\/([^/]+)\/edit$/, m => viewDnForm(m[1])],
  [/^\/deliveries\/([^/]+)$/, m => viewDocDetail('dn', m[1])],
  [/^\/partners$/, viewPartners],
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
  const list = db.partners
    .filter(p => p.kind === kind || p.kind === 'both' || p.id === selected)
    .sort(byField('name'));
  return `<option value="">— 選択してください —</option>` +
    list.map(p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}

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
      ${pos.map(p => `<a class="chain-card is-po${cur(p.id)}" href="#/pos/${p.id}">
          <b>${esc(p.poNo)}</b><span>${esc(partnerName(p.supplierId))}</span><span>${fmtDate(p.poDate)}　${yen(calc(p).total)}</span>
        </a>`).join('') || '<div class="chain-empty">発注書はまだありません</div>'}
      ${withAdd ? `<a class="chain-add is-po" href="#/pos/new?order=${o.id}">＋ この受注の発注書を作る</a>` : ''}
    </div>
    <div class="chain-arrow">→</div>
    <div class="chain-col">
      <div class="chain-label">③ 納品書（お客様へ）</div>
      ${dns.map(d => `<a class="chain-card is-dn${cur(d.id)}" href="#/deliveries/${d.id}">
          <b>${esc(d.dnNo)}</b><span>納品日：${fmtDate(d.deliveryDate)}</span><span>${yen(calc(d).total)}</span>
        </a>`).join('') || '<div class="chain-empty">納品書はまだありません</div>'}
      ${withAdd && orderStatus(o).key !== 'done' ? `<a class="chain-add is-dn" href="#/deliveries/new?order=${o.id}">＋ この受注の納品書を作る</a>` : ''}
    </div>
  </div>`;
}

// 明細入力（行の追加・削除・金額の自動計算）
function mountItems(root, initialItems, { getRate, refInfo } = {}) {
  let items = initialItems;
  root.innerHTML = `
    <div class="items-wrap">
      <table class="items">
        <thead><tr>
          <th class="c-no">No.</th><th class="c-name">品名</th><th>仕様・型番</th>
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
        <td><input data-f="name" value="${esc(it.name)}" placeholder="品名を入力"></td>
        <td><input data-f="spec" value="${esc(it.spec)}" placeholder="任意"></td>
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
    $('.c-amt', tr).textContent = num(lineAmount(items[i]));
    const refRow = $(`tr[data-ref-for="${i}"] td:last-child`, tbody);
    if (refRow && refInfo) refRow.innerHTML = refInfo(items[i]);
    updateTotals();
  });
  root.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add-row') {
      items.push(blankItem());
      renderRows();
      $$('tr[data-i]', tbody).pop().querySelector('input').focus();
    } else if (act === 'del-row') {
      const i = +e.target.closest('tr[data-i]').dataset.i;
      items.splice(i, 1);
      if (!items.length) items.push(blankItem());
      renderRows();
    }
  });

  renderRows();
  return {
    get items() { return items; },
    setItems(next) { items = next.length ? next : [blankItem()]; renderRows(); },
    refresh: renderRows,
    updateTotals,
  };
}

function itemsReadonlyHTML(doc, { progress } = {}) {
  const t = calc(doc);
  const dmap = progress ? deliveredMap(doc.id) : null;
  return `<div class="table-wrap"><table class="list">
    <thead><tr><th>No.</th><th>品名</th><th>仕様・型番</th><th class="num">数量</th><th>単位</th><th class="num">単価</th><th class="num">金額</th>
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
  const apply = () => {
    const q = (input?.value || '').trim().toLowerCase();
    const st = sel?.value || '';
    let shown = 0;
    $$('tbody tr[data-search]', root).forEach(tr => {
      const stOk = !st || (st === 'open' ? tr.dataset.status !== 'done' : tr.dataset.status === st);
      const ok = (!q || tr.dataset.search.toLowerCase().includes(q)) && stOk;
      tr.hidden = !ok;
      if (ok) shown++;
    });
    const cnt = $('[data-count]', root);
    if (cnt) cnt.textContent = `${shown} 件`;
  };
  input?.addEventListener('input', apply);
  sel?.addEventListener('change', apply);
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
  const soon = open.filter(x => x.o.dueDate && daysUntil(x.o.dueDate) <= 7)
    .sort((a, b) => a.o.dueDate.localeCompare(b.o.dueDate));

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

    <div class="tiles">
      <a class="tile" href="#/orders"><div class="tile-label">今月の受注</div><div class="tile-value">${month.length} 件</div><div class="tile-sub">${yen(monthTotal)}（税込）</div></a>
      <a class="tile ${noPo.length ? 'is-alert' : ''}" href="#/orders?status=new"><div class="tile-label">未発注の受注</div><div class="tile-value">${noPo.length} 件</div><div class="tile-sub">発注書がまだの受注</div></a>
      <a class="tile" href="#/orders?status=open"><div class="tile-label">未納品の受注</div><div class="tile-value">${open.length} 件</div><div class="tile-sub">納品が完了していない受注</div></a>
      <a class="tile ${soon.length ? 'is-alert' : ''}" href="#/orders?status=open"><div class="tile-label">納期 7 日以内</div><div class="tile-value">${soon.length} 件</div><div class="tile-sub">納期超過を含む</div></a>
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
  if (!o.dueDate) return '<span class="muted">—</span>';
  const d = daysUntil(o.dueDate);
  const warn = st.key !== 'done' && d <= 3;
  return `<span class="${warn ? 'due-soon' : ''}">${esc(o.dueDate)}${warn ? (d < 0 ? '（超過）' : d === 0 ? '（本日）' : `（あと${d}日）`) : ''}</span>`;
}

function orderTableHTML(orders) {
  return `<div class="table-wrap"><table class="list">
    <thead><tr><th>自社受注No.</th><th>お客様発注No.</th><th>受注日</th><th>お客様</th><th>件名</th><th>納期</th>
      <th class="num">金額（税込）</th><th>発注書</th><th>納品書</th><th>状況</th></tr></thead>
    <tbody>${orders.map(o => {
      const st = orderStatus(o);
      const pos = posOf(o.id);
      const dns = dnsOf(o.id);
      const search = [o.orderNo, o.customerPoNo, partnerName(o.customerId), o.subject, ...pos.map(p => p.poNo), ...dns.map(d => d.dnNo)].join(' ');
      return `<tr class="clickable" data-href="#/orders/${o.id}" data-search="${esc(search)}" data-status="${st.key}">
        <td>${tag(o.orderNo, 'is-order')}</td><td>${tag(o.customerPoNo, 'is-cust')}</td><td class="nowrap">${esc(o.orderDate)}</td>
        <td class="wide">${esc(partnerName(o.customerId))}</td><td class="wide">${esc(o.subject)}</td><td class="nowrap">${dueHTML(o, st)}</td>
        <td class="num">${yen(calc(o).total)}</td>
        <td>${pos.map(p => `<a href="#/pos/${p.id}">${tag(p.poNo, 'is-po')}</a>`).join(' ') || '<span class="muted">—</span>'}</td>
        <td>${dns.map(d => `<a href="#/deliveries/${d.id}">${tag(d.dnNo, 'is-dn')}</a>`).join(' ') || '<span class="muted">—</span>'}</td>
        <td>${badge(st)}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function viewOrderList(q) {
  const orders = [...db.orders].sort(byDateNoDesc('orderDate', 'orderNo'));
  const status = q.get('status') || '';
  render(`
    <div class="page-head">
      <div><div class="crumb">ステップ ①</div><h1>受注一覧</h1></div>
      <div class="actions"><a class="btn btn-primary" href="#/orders/new">＋ 新しい受注を登録</a></div>
    </div>
    <section class="card">
      ${orders.length ? `
      <div class="filters">
        <input type="search" data-filter placeholder="番号・お客様名・件名で絞り込み">
        <select data-status-filter>
          <option value="">すべての状況</option>
          <option value="open" ${status === 'open' ? 'selected' : ''}>未納品（完了以外すべて）</option>
          ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${status === k ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select>
        <span class="muted" data-count></span>
      </div>
      ${orderTableHTML(orders)}` : `<div class="empty">受注はまだありません。<br><a class="btn btn-primary" href="#/orders/new">＋ 新しい受注を登録</a></div>`}
    </section>`);
  bindListFilter($('#view'));
}

function viewOrderForm(id) {
  const editing = id ? getOrder(id) : null;
  if (id && !editing) return notFound();
  const o = editing ? clone(editing) : {
    id: uid(), orderNo: nextNo('order'), customerPoNo: '', customerId: '', orderDate: today(), dueDate: '',
    subject: '', taxRate: db.settings.taxRate, items: [blankItem()], note: '',
  };

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
      <section class="card">
        <h2>受注内容</h2>
        <div class="grid-4">
          <div class="span-2">${partnerSelectField('customerId', 'お客様（注文元）', 'customer', o.customerId)}</div>
          <div class="field"><label>受注日</label><input type="date" name="orderDate" value="${esc(o.orderDate)}"></div>
          <div class="field"><label>納期</label><input type="date" name="dueDate" value="${esc(o.dueDate)}"></div>
          <div class="field span-2"><label>件名</label><input name="subject" value="${esc(o.subject)}" placeholder="例：〇〇工事用部材一式"></div>
          <div class="field"><label>消費税率（%）</label><input type="number" name="taxRate" value="${esc(o.taxRate)}" min="0" step="any" class="num"></div>
        </div>
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
  const ed = mountItems($('#items'), o.items, { getRate: () => form.elements.taxRate.value });
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
    Object.assign(o, {
      orderNo: f.orderNo, customerPoNo: f.customerPoNo.trim(), customerId: f.customerId, orderDate: f.orderDate,
      dueDate: f.dueDate, subject: f.subject.trim(), taxRate: toNum(f.taxRate), items, note: f.note,
      updatedAt: new Date().toISOString(),
    });
    if (editing) db.orders[db.orders.indexOf(editing)] = o;
    else db.orders.push({ ...o, createdAt: o.updatedAt });
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
  const hasPo = posOf(o.id).length > 0;
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
        <div><dt>納期</dt><dd>${dueHTML(o, st)}</dd></div>
        <div class="span-2"><dt>お客様</dt><dd>${esc(cu?.name || '（未設定）')} ${cu?.contact ? `<span class="muted">／${esc(cu.contact)}</span>` : ''}</dd></div>
        <div class="span-2"><dt>件名</dt><dd>${esc(o.subject) || '—'}</dd></div>
      </dl>
      ${itemsReadonlyHTML(o, { progress: true })}
      ${o.note ? `<p class="hint" style="white-space:pre-wrap">メモ：${esc(o.note)}</p>` : ''}
    </section>`);

  $('[data-act=delete]').addEventListener('click', () => {
    const n = posOf(o.id).length + dnsOf(o.id).length;
    if (n) return alert(`この受注には発注書・納品書が ${n} 件紐付いています。\n先にそれらを削除してから受注を削除してください。`);
    if (!confirm(`受注 ${o.orderNo} を削除します。よろしいですか？`)) return;
    db.orders = db.orders.filter(x => x.id !== o.id);
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

function viewDocList(type) {
  const T = DOC[type];
  const docs = [...T.list()].sort(byDateNoDesc(T.dateField, T.noField));
  const isPo = type === 'po';
  render(`
    <div class="page-head">
      <div><div class="crumb">ステップ ${T.step}</div><h1>${T.label}一覧</h1></div>
      <div class="actions"><a class="btn btn-primary" href="#/${T.path}/new">＋ ${T.label}を作成</a></div>
    </div>
    <p class="hint no-print" style="margin:-8px 0 14px">受注の詳細画面から作成すると、番号と明細が自動で紐付きます。</p>
    <section class="card">
      ${docs.length ? `
      <div class="filters"><input type="search" data-filter placeholder="番号・会社名・件名で絞り込み"><span class="muted" data-count></span></div>
      <div class="table-wrap"><table class="list">
        <thead><tr><th>${T.label}No.</th><th>${isPo ? '発注日' : '納品日'}</th><th>${isPo ? '仕入先' : 'お客様'}</th>
          <th>自社受注No.</th><th>お客様発注No.</th><th>件名</th>${isPo ? '<th>納期</th>' : ''}<th class="num">金額（税込）</th><th></th></tr></thead>
        <tbody>${docs.map(d => {
          const o = d.orderId ? getOrder(d.orderId) : null;
          const to = isPo ? partnerName(d.supplierId) : partnerName(o?.customerId);
          const search = [d[T.noField], to, o?.orderNo, o?.customerPoNo, d.subject].join(' ');
          return `<tr class="clickable" data-href="#/${T.path}/${d.id}" data-search="${esc(search)}">
            <td>${tag(d[T.noField], T.cls)}</td><td class="nowrap">${esc(d[T.dateField])}</td><td class="wide">${esc(to)}</td>
            <td>${o ? `<a href="#/orders/${o.id}">${tag(o.orderNo, 'is-order')}</a>` : '<span class="muted">紐付けなし</span>'}</td>
            <td>${tag(o?.customerPoNo, 'is-cust')}</td><td>${esc(d.subject)}</td>
            ${isPo ? `<td class="nowrap">${esc(d.dueDate) || '—'}</td>` : ''}
            <td class="num">${yen(calc(d).total)}</td>
            <td><a class="btn btn-sm" href="#/${T.path}/${d.id}">表示・印刷</a></td></tr>`;
        }).join('')}</tbody></table></div>` :
        `<div class="empty">${T.label}はまだありません。<br>受注一覧から受注を開き「${T.label}を作る」を押すと、番号・明細が紐付いた${T.label}を作成できます。<br>
          <a class="btn" href="#/orders">受注一覧を開く</a></div>`}
    </section>`);
  bindListFilter($('#view'));
}

function viewDocDetail(type, id) {
  const T = DOC[type];
  const d = type === 'po' ? getPo(id) : getDn(id);
  if (!d) return notFound();
  const o = d.orderId ? getOrder(d.orderId) : null;
  const no = d[T.noField];

  render(`
    <div class="page-head no-print">
      <div><div class="crumb"><a href="#/${T.path}">${T.label}一覧</a> › 表示・印刷</div>
        <h1>${T.label} ${tag(no, T.cls)}</h1></div>
      <div class="actions">
        <button class="btn btn-print" data-act="print">🖨 PDFで印刷・保存</button>
        <a class="btn" href="#/${T.path}/${d.id}/edit">✎ 編集</a>
        <button class="btn btn-danger" data-act="delete">削除</button>
      </div>
    </div>
    <section class="card no-print">
      <h2>紐付け</h2>
      ${o ? chainHTML(o, { currentId: d.id, withAdd: false }) : '<p class="muted">この発注書は受注に紐付いていません。編集画面で自社受注No.を選ぶと紐付けできます。</p>'}
      <p class="hint">「PDFで印刷・保存」→ 印刷画面の送信先（プリンター）で <b>「PDFに保存」</b> を選ぶと PDF ファイルになります。ファイル名は「${T.label}_${esc(no)}」になります。</p>
    </section>
    <div class="paper-scroll"><div class="paper">${docHTML(type, d)}</div></div>`);

  $('[data-act=print]').addEventListener('click', () => printDoc(`${T.label}_${no}`));
  $('[data-act=delete]').addEventListener('click', () => {
    if (!confirm(`${T.label} ${no} を削除します。よろしいですか？`)) return;
    if (type === 'po') db.pos = db.pos.filter(x => x.id !== d.id);
    else db.deliveries = db.deliveries.filter(x => x.id !== d.id);
    save();
    toast(`${T.label}を削除しました`);
    go(o ? `#/orders/${o.id}` : `#/${T.path}`);
  });
}

function printDoc(filename) {
  const prev = document.title;
  document.title = filename; // PDF 保存時の既定ファイル名になる
  window.addEventListener('afterprint', () => { document.title = prev; }, { once: true });
  window.print();
}

// 印刷用の帳票（A4 縦）
function docHTML(type, d) {
  const isPo = type === 'po';
  const c = db.settings.company;
  const o = d.orderId ? getOrder(d.orderId) : null;
  const to = getPartner(isPo ? d.supplierId : o?.customerId);
  const t = calc(d);
  const meta = isPo
    ? [['発注No.', d.poNo], ['発注日', fmtDate(d.poDate)], ['納期', fmtDate(d.dueDate)], ['当社受注No.', o?.orderNo]]
    : [['納品書No.', d.dnNo], ['納品日', fmtDate(d.deliveryDate)], ['貴社発注No.', o?.customerPoNo], ['当社受注No.', o?.orderNo]];
  const MIN_ROWS = 10;
  const rows = d.items.map((it, i) => `<tr>
      <td class="c">${i + 1}</td>
      <td>${esc(it.name)}${it.spec ? `<span class="spec">${esc(it.spec)}</span>` : ''}</td>
      <td class="r">${num(it.qty)}</td><td class="c">${esc(it.unit)}</td>
      <td class="r">${it.price === '' ? '' : num(it.price)}</td><td class="r">${num(lineAmount(it))}</td></tr>`);
  for (let i = rows.length; i < MIN_ROWS; i++) rows.push('<tr><td></td><td></td><td></td><td></td><td></td><td></td></tr>');

  return `
    <h1 class="doc-title">${isPo ? '発注書' : '納品書'}</h1>
    <div class="doc-head">
      <div class="doc-to">
        <div class="to-name">${esc(to?.name || '（宛先未設定）')}<span>${esc(to?.honorific || '御中')}</span></div>
        ${to?.contact ? `<div class="to-sub">${esc(to.contact)}</div>` : ''}
        ${to?.zip || to?.address ? `<div class="to-sub">${to.zip ? '〒' + esc(to.zip) + '　' : ''}${esc(to.address)}</div>` : ''}
        <p class="doc-lead">${isPo ? '下記の通り発注いたします。' : '下記の通り納品いたしました。ご査収ください。'}</p>
        ${d.subject ? `<div class="doc-subject"><span>件名</span><b>${esc(d.subject)}</b></div>` : ''}
        <div class="doc-total"><span>${isPo ? 'ご発注金額' : '合計金額'}（税込）</span><b>${yen(t.total)}</b></div>
      </div>
      <div class="doc-from">
        <table class="doc-meta">${meta.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v || '—')}</td></tr>`).join('')}</table>
        <div class="company">
          ${db.settings.showLogo ? `<img class="company-logo" src="img/logo.png" alt="${esc(c.name)}">` : `<div class="company-name">${esc(c.name || '（自社名未設定：設定画面で登録）')}</div>`}
          ${c.dept ? `<div class="company-dept">${esc(c.dept)}</div>` : ''}
          ${c.zip || c.address ? `<div>${c.zip ? '〒' + esc(c.zip) + '　' : ''}${esc(c.address)}</div>` : ''}
          ${c.tel || c.fax ? `<div>${c.tel ? 'TEL ' + esc(c.tel) : ''}${c.fax ? '　FAX ' + esc(c.fax) : ''}</div>` : ''}
          ${c.email ? `<div>${esc(c.email)}</div>` : ''}
          ${c.invoiceNo ? `<div>登録番号：${esc(c.invoiceNo)}</div>` : ''}
          ${c.person ? `<div>担当：${esc(c.person)}</div>` : ''}
        </div>
        <div class="stamps">
          ${isPo ? '<div class="stamp"><div>承認</div><div></div></div>' : ''}
          <div class="stamp"><div>担当</div><div></div></div>
        </div>
      </div>
    </div>
    <table class="doc-lines">
      <thead><tr><th style="width:9mm">No.</th><th>品名・仕様</th><th style="width:18mm">数量</th><th style="width:14mm">単位</th>
        <th style="width:24mm">単価</th><th style="width:28mm">金額</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>
    <div class="doc-bottom">
      <div class="doc-notes">
        ${isPo ? `<table class="doc-cond">
          <tr><th>納品場所</th><td>${esc(d.deliveryPlace) || '&nbsp;'}</td></tr>
          <tr><th>支払条件</th><td>${esc(d.paymentTerms) || '&nbsp;'}</td></tr></table>` : ''}
        <div class="note-box"><div class="note-label">備考</div><div class="note-body">${esc(d.note)}</div></div>
      </div>
      <table class="doc-sum">
        <tr><th>小計</th><td>${yen(t.sub)}</td></tr>
        <tr><th>消費税（${num(t.rate)}%）</th><td>${yen(t.tax)}</td></tr>
        <tr class="grand"><th>合計</th><td>${yen(t.total)}</td></tr>
      </table>
    </div>
    ${isPo ? '' : `<div class="receipt"><span class="receipt-msg">上記の通り受領いたしました。</span>
      <div class="receipt-box"><div>受領印</div><div></div></div></div>`}`;
}

// ---------- 発注書フォーム ----------
function poItemsFromOrder(order) {
  return order.items.map(it => ({ id: uid(), ref: it.id, name: it.name, spec: it.spec, qty: it.qty, unit: it.unit, price: '' }));
}

function linkInfoHTML(o) {
  if (!o) return '<span class="muted">受注に紐付けると、自社受注No.・お客様発注No.が書類に入ります。</span>';
  return `<span>自社受注No.：<b>${esc(o.orderNo)}</b></span><span>お客様発注No.：<b>${esc(o.customerPoNo || '—')}</b></span>
    <span>お客様：<b>${esc(partnerName(o.customerId))}</b></span><span>納期：<b>${esc(o.dueDate || '—')}</b></span>`;
}

function viewPoForm(id, orderIdParam) {
  const editing = id ? getPo(id) : null;
  if (id && !editing) return notFound();
  const src = orderIdParam ? getOrder(orderIdParam) : null;
  const p = editing ? clone(editing) : {
    id: uid(), poNo: nextNo('po'), orderId: src?.id || '', supplierId: '', poDate: today(),
    dueDate: src?.dueDate ? addDays(src.dueDate, -2) : '', deliveryPlace: '', paymentTerms: db.settings.paymentTerms || '',
    subject: src?.subject || '', taxRate: src?.taxRate ?? db.settings.taxRate,
    items: src ? poItemsFromOrder(src) : [blankItem()], note: '',
  };
  if (!editing && p.dueDate && p.dueDate < p.poDate) p.dueDate = p.poDate;

  render(`
    <div class="page-head">
      <div><div class="crumb"><a href="#/pos">発注書一覧</a> › ${editing ? '編集' : '作成'}</div>
        <h1>${editing ? `発注書を編集 ${tag(p.poNo, 'is-po')}` : '発注書を作成'}</h1></div>
    </div>
    <form id="doc-form" autocomplete="off">
      <section class="card">
        <h2>番号と紐付け</h2>
        <div class="grid-2">
          <div class="field number-field is-po">
            <label>発注No. <span class="req">必須</span></label>
            <input name="poNo" value="${esc(p.poNo)}">
            <p class="hint">自動で採番されます。</p>
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
        <button class="btn btn-primary" type="submit">保存して印刷画面へ</button>
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
    f.poNo = f.poNo.trim();
    if (!f.poNo) return toast('発注No.を入力してください', 'error');
    if (db.pos.some(x => x.poNo === f.poNo && x.id !== p.id)) return toast('この発注No.は既に使われています', 'error');
    if (!f.supplierId) return toast('仕入先を選択してください', 'error');
    const items = cleanItems(ed.items);
    if (!items.length) return toast('明細を1行以上入力してください（品名は必須です）', 'error');
    if (items.some(it => it.price === '') && !confirm('単価が未入力の行があります。このまま保存しますか？')) return;
    Object.assign(p, {
      poNo: f.poNo, orderId: f.orderId, supplierId: f.supplierId, poDate: f.poDate, dueDate: f.dueDate,
      subject: f.subject.trim(), deliveryPlace: f.deliveryPlace.trim(), paymentTerms: f.paymentTerms.trim(),
      taxRate: toNum(f.taxRate), items, note: f.note, updatedAt: new Date().toISOString(),
    });
    if (editing) db.pos[db.pos.indexOf(editing)] = p;
    else db.pos.push({ ...p, createdAt: p.updatedAt });
    save();
    toast('発注書を保存しました');
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
  const src = orderIdParam ? getOrder(orderIdParam) : null;
  const d = editing ? clone(editing) : {
    id: uid(), dnNo: nextNo('dn'), orderId: src?.id || '', deliveryDate: today(),
    subject: src?.subject || '', taxRate: src?.taxRate ?? db.settings.taxRate,
    items: src ? remainingItems(src) : [], note: '',
  };
  const allDelivered = !editing && src && !d.items.length;
  if (!d.items.length) d.items = [blankItem()];

  render(`
    <div class="page-head">
      <div><div class="crumb"><a href="#/deliveries">納品書一覧</a> › ${editing ? '編集' : '作成'}</div>
        <h1>${editing ? `納品書を編集 ${tag(d.dnNo, 'is-dn')}` : '納品書を作成'}</h1></div>
    </div>
    ${allDelivered ? '<div class="banner">この受注は全数納品済みです。追加の納品がある場合のみ明細を入力してください。</div>' : ''}
    <form id="doc-form" autocomplete="off">
      <section class="card">
        <h2>番号と紐付け</h2>
        <div class="grid-2">
          <div class="field number-field is-dn">
            <label>納品書No. <span class="req">必須</span></label>
            <input name="dnNo" value="${esc(d.dnNo)}">
            <p class="hint">自動で採番されます。</p>
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
        <button class="btn btn-primary" type="submit">保存して印刷画面へ</button>
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
  const ed = mountItems($('#items'), d.items, { getRate: () => form.elements.taxRate.value, refInfo });
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
    f.dnNo = f.dnNo.trim();
    if (!f.dnNo) return toast('納品書No.を入力してください', 'error');
    if (db.deliveries.some(x => x.dnNo === f.dnNo && x.id !== d.id)) return toast('この納品書No.は既に使われています', 'error');
    if (!f.orderId) return toast('紐付ける受注を選択してください', 'error');
    const items = cleanItems(ed.items);
    if (!items.length) return toast('明細を1行以上入力してください（品名は必須です）', 'error');
    const o = getOrder(f.orderId);
    const dmap = deliveredMap(o.id, d.id);
    const over = items.some(it => {
      const line = o.items.find(x => x.id === it.ref);
      return line && toNum(it.qty) > toNum(line.qty) - (dmap[line.id] || 0);
    });
    if (over && !confirm('受注の残数を超えて納品する行があります。このまま保存しますか？')) return;
    Object.assign(d, {
      dnNo: f.dnNo, orderId: f.orderId, deliveryDate: f.deliveryDate, subject: f.subject.trim(),
      taxRate: toNum(f.taxRate), items, note: f.note, updatedAt: new Date().toISOString(),
    });
    if (editing) db.deliveries[db.deliveries.indexOf(editing)] = d;
    else db.deliveries.push({ ...d, createdAt: d.updatedAt });
    save();
    toast('納品書を保存しました');
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

  render(`
    <div class="page-head"><h1>検索結果：「${esc(query)}」</h1></div>
    ${!q ? '<div class="card empty">検索したい番号や会社名を入力してください。</div>' : ''}
    ${q && !orders.length && !loosePos.length ? '<div class="card empty">該当するデータはありません。</div>' : ''}
    ${orders.map(o => `<section class="card search-result">
      <h3>${tag(o.orderNo, 'is-order')} ${esc(partnerName(o.customerId))} ${o.subject ? '／' + esc(o.subject) : ''} ${badge(orderStatus(o))}</h3>
      ${chainHTML(o, { withAdd: false })}</section>`).join('')}
    ${loosePos.length ? `<section class="card"><h2>受注に紐付いていない発注書</h2>
      ${loosePos.map(p => `<p><a href="#/pos/${p.id}">${tag(p.poNo, 'is-po')}</a> ${esc(partnerName(p.supplierId))} ${esc(p.subject)}</p>`).join('')}</section>` : ''}`);
}

// ---------- 取引先 ----------
function viewPartners() {
  const list = [...db.partners].sort(byField('name'));
  const usage = p => db.orders.filter(o => o.customerId === p.id).length + db.pos.filter(x => x.supplierId === p.id).length;
  render(`
    <div class="page-head"><h1>取引先</h1>
      <div class="actions"><button class="btn btn-primary" data-act="new">＋ 取引先を登録</button></div></div>
    <section class="card">
      ${list.length ? `
      <div class="filters"><input type="search" data-filter placeholder="会社名・住所で絞り込み"><span class="muted" data-count></span></div>
      <div class="table-wrap"><table class="list">
        <thead><tr><th>会社名・氏名</th><th>区分</th><th>住所</th><th>電話</th><th>ご担当者</th><th class="num">取引件数</th><th></th></tr></thead>
        <tbody>${list.map(p => `<tr data-search="${esc([p.name, p.address, p.contact, p.tel].join(' '))}">
          <td><b>${esc(p.name)}</b> <span class="muted">${esc(p.honorific)}</span></td><td>${KIND_LABEL[p.kind] || ''}</td>
          <td>${p.zip ? '〒' + esc(p.zip) + ' ' : ''}${esc(p.address)}</td><td>${esc(p.tel)}</td><td>${esc(p.contact)}</td>
          <td class="num">${usage(p)}</td>
          <td><span class="actions"><button class="btn btn-sm" data-edit="${p.id}">編集</button><button class="btn btn-sm btn-danger" data-del="${p.id}">削除</button></span></td>
        </tr>`).join('')}</tbody></table></div>` :
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
            <img src="img/logo.png" alt="" style="height:32px;align-self:flex-start;margin-top:4px">
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
          <div class="field span-2"><label>発注書の標準の支払条件</label><input name="paymentTerms" value="${esc(s.paymentTerms)}"></div>
        </div>
        <p class="hint">番号は「頭文字-西暦-連番」の形で自動採番されます（例：${esc(s.prefix.order)}-${new Date().getFullYear()}-0001）。</p>
      </section>
      <div class="form-actions"><button class="btn btn-primary" type="submit">設定を保存する</button></div>
    </form>
    <section class="card">
      <h2>データの保存・バックアップ</h2>
      <p class="hint" style="margin-bottom:12px">データはこのパソコンのブラウザ内に保存されています。<b>定期的にバックアップを保存</b>してください（別のパソコンへ移すときもバックアップを使います）。</p>
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
    const prefixes = [f.p_order, f.p_po, f.p_dn].map(v => v.trim());
    if (prefixes.some(v => !/^[A-Za-z0-9]+$/.test(v))) return toast('番号の頭文字は半角英数字で入力してください', 'error');
    s.company = { name: f.name, dept: f.dept, zip: f.zip, address: f.address, tel: f.tel, fax: f.fax, email: f.email, invoiceNo: f.invoiceNo, person: f.person };
    s.showLogo = f.showLogo === 'on';
    s.paymentTerms = f.paymentTerms.trim();
    s.prefix = { order: prefixes[0], po: prefixes[1], dn: prefixes[2] };
    s.taxRate = toNum(f.taxRate);
    save();
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
      db = normalize(data);
      save();
      toast('バックアップから復元しました');
      viewSettings();
    } catch (err) {
      toast('復元できませんでした：' + err.message, 'error');
    }
  });
  $('[data-act=csv]').addEventListener('click', exportCsv);
  $('[data-act=sample]').addEventListener('click', loadSample);
  $('[data-act=reset]').addEventListener('click', () => {
    if (!confirm('すべてのデータ（受注・発注書・納品書・取引先・設定）を削除します。元に戻せません。よろしいですか？')) return;
    if (prompt('確認のため「削除」と入力してください') !== '削除') return;
    db = defaultData();
    save();
    toast('すべてのデータを削除しました');
    go('#/');
  });
}

function exportCsv() {
  const head = ['自社受注No.', 'お客様発注No.', '受注日', 'お客様', '件名', '納期', '受注金額(税込)', '状況', '発注No.', '仕入先', '発注金額(税込)', '納品書No.', '納品日', '納品金額(税込)'];
  const rows = [head];
  [...db.orders].sort(byField('orderNo')).forEach(o => {
    const base = [o.orderNo, o.customerPoNo, o.orderDate, partnerName(o.customerId), o.subject, o.dueDate, calc(o).total, orderStatus(o).label];
    const pos = posOf(o.id);
    const dns = dnsOf(o.id);
    const n = Math.max(1, pos.length, dns.length);
    for (let i = 0; i < n; i++) {
      const p = pos[i];
      const d = dns[i];
      rows.push([...base,
        p?.poNo, p && partnerName(p.supplierId), p && calc(p).total,
        d?.dnNo, d?.deliveryDate, d && calc(d).total]);
    }
  });
  db.pos.filter(p => !getOrder(p.orderId)).forEach(p => {
    rows.push(['', '', '', '', p.subject, '', '', '紐付けなし', p.poNo, partnerName(p.supplierId), calc(p).total, '', '', '']);
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
  const RQM = '「レスキューミー」自動車用緊急脱出・救出ツール';
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
window.addEventListener('hashchange', route);
window.addEventListener('storage', e => { if (e.key === STORE_KEY) { db = load(); route(); } });
route();
