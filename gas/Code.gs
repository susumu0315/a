/* resqmej 受注・発注管理：Google スプレッドシートを保存先にするサーバー側の処理
 * このスクリプトはスプレッドシートの「拡張機能 → Apps Script」に貼り付けて使います（README 参照）。
 * データは 1 レコード 1 行で、一覧ごとのシートに保存します。data 列（JSON）が本体で、内容列は人が見るための説明です。
 */

const SHEETS = {
  config: '設定', partners: '取引先', products: '商品', orders: '受注', pos: '発注書',
  deliveries: '納品書', receipts: '入庫', prospects: '見込み案件', logs: '操作履歴', bills: '請求書',
};
const HEADER = ['id', '内容', '更新日時', '更新者', 'rev', 'data'];
const COL = { id: 0, label: 1, at: 2, by: 3, rev: 4, data: 5 };
// 同じ番号が重複してはいけない項目
const UNIQUE = { orders: ['orderNo', '自社受注No.'], pos: ['poNo', '発注No.'], deliveries: ['dnNo', '納品書No.'], bills: ['billNo', '請求書No.'] };
// 発行済・取消済の書類で変更してはいけない項目
const LOCKED = {
  pos: ['poNo', 'orderId', 'supplierId', 'items', 'snap', 'issuedAt', 'issuedBy', 'reissueOf'],
  deliveries: ['dnNo', 'orderId', 'deliveryDate', 'items', 'snap', 'issuedAt', 'issuedBy', 'reissueOf'],
  bills: ['billNo', 'partnerId', 'dnIds', 'invoiceDate', 'payDue', 'subject', 'note', 'shipping', 'snap', 'issuedAt', 'issuedBy', 'reissueOf'],
};
const VOID_FIELDS = ['status', 'voidAt', 'voidBy', 'voidReason'];

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('resqmej 受注・発注管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function sheet_(coll) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEETS[coll]);
  if (!sh) {
    sh = ss.insertSheet(SHEETS[coll]);
    sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // id・rev・data は文字列のまま保存する（数値や日付に自動変換させない）
    sh.getRange('A:B').setNumberFormat('@');
    sh.getRange('E:F').setNumberFormat('@');
    sh.setColumnWidth(2, 480);
    protect_(sh);
  }
  return sh;
}

// シートは管理者（スクリプトの所有者）だけが編集できるよう保護する。アプリは所有者の権限で書き込む
function protect_(sh) {
  if (sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) return;
  const p = sh.protect().setDescription('resqmej：アプリからのみ変更してください');
  p.removeEditors(p.getEditors());
  if (p.canDomainEdit()) p.setDomainEdit(false);
}

const same_ = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
const without_ = (o, keys) => {
  const c = Object.assign({}, o);
  keys.forEach(k => { delete c[k]; });
  return c;
};

// 発行した書類は削除・変更させない（取消への変更と、請求書・領収書の追加発行・取消だけを認める）
function checkLocked_(coll, before, after) {
  if (coll === 'logs') {
    if (before) throw new Error('操作履歴は変更・削除できません。');
    return;
  }
  if (!LOCKED[coll] || !before || !before.status || before.status === 'draft') return;
  const label = SHEETS[coll];
  if (!after) throw new Error('発行済・取消済の' + label + 'は削除できません。');
  if (before.status === 'void' && after.status !== 'void') throw new Error('取消済の' + label + 'は元に戻せません。');
  if (after.status !== 'issued' && after.status !== 'void') throw new Error('発行済の' + label + 'を下書きに戻すことはできません。');
  LOCKED[coll].forEach(f => {
    if (!same_(before[f], after[f])) throw new Error('発行済の' + label + 'の内容は変更できません（' + f + '）。');
  });
  ['invoices', 'receipts'].forEach(k => {
    (before[k] || []).forEach((e, i) => {
      const a = (after[k] || [])[i];
      if (!a || !same_(without_(e, VOID_FIELDS), without_(a, VOID_FIELDS)) || (e.status === 'void' && a.status !== 'void')) {
        throw new Error('発行済の請求書・領収書は変更・削除できません。');
      }
    });
  });
}

function rows_(sh) {
  const n = sh.getLastRow() - 1;
  return n > 0 ? sh.getRange(2, 1, n, HEADER.length).getValues() : [];
}

function user_() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

const newRev_ = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const row_ = (op, rev, at, by) => [op.id, op.label || '', at, by, rev, JSON.stringify(op.data)];

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return JSON.stringify(fn());
  } catch (e) {
    return JSON.stringify({ ok: false, message: e.message });
  } finally {
    lock.releaseLock();
  }
}

// すべてのデータを読み込む
function apiLoad() {
  const data = {};
  Object.keys(SHEETS).forEach(coll => {
    const sh = sheet_(coll);
    protect_(sh);
    data[coll] = rows_(sh)
      .filter(r => r[COL.id] !== '')
      .map(r => ({ id: String(r[COL.id]), rev: String(r[COL.rev]), data: JSON.parse(r[COL.data]) }));
  });
  return JSON.stringify({ ok: true, user: user_(), data });
}

// 変更されたレコードだけを保存する。他の人が先に同じレコードを変えていたら保存しない
function apiSave(json) {
  const req = JSON.parse(json);
  return withLock_(() => {
    const at = new Date();
    const by = user_();
    const byColl = {};
    req.ops.forEach(op => {
      if (!SHEETS[op.coll]) throw new Error('不明なデータです：' + op.coll);
      (byColl[op.coll] = byColl[op.coll] || []).push(op);
    });

    // 1. すべて確認してから
    const plans = Object.keys(byColl).map(coll => {
      const sh = sheet_(coll);
      const rows = rows_(sh);
      const index = {};
      rows.forEach((r, i) => { index[String(r[COL.id])] = i; });
      byColl[coll].forEach(op => {
        const i = index[op.id];
        const cur = i === undefined ? '' : String(rows[i][COL.rev]);
        if (cur !== (op.baseRev || '')) {
          throw new Error('ほかの人が先に同じデータを変更しました（' + SHEETS[coll] + '）。');
        }
        checkLocked_(coll, i === undefined ? null : JSON.parse(rows[i][COL.data]), op.del ? null : op.data);
      });
      if (UNIQUE[coll]) {
        const [field, label] = UNIQUE[coll];
        const values = {};
        rows.forEach(r => { values[String(r[COL.id])] = JSON.parse(r[COL.data])[field]; });
        byColl[coll].forEach(op => {
          if (op.del) delete values[op.id];
          else values[op.id] = op.data[field];
        });
        const seen = {};
        Object.keys(values).forEach(id => {
          const v = values[id];
          if (!v) return;
          if (seen[v]) throw new Error('この' + label + '（' + v + '）は既に使われています。');
          seen[v] = true;
        });
      }
      return { coll, sh, rows, index };
    });

    // 2. まとめて書き込む
    const revs = [];
    plans.forEach(({ coll, sh, index }) => {
      const appends = [];
      const deletes = [];
      byColl[coll].forEach(op => {
        const i = index[op.id];
        if (op.del) {
          if (i !== undefined) deletes.push(i);
          revs.push({ coll, id: op.id, rev: '' });
          return;
        }
        const rev = newRev_();
        const row = row_(op, rev, at, by);
        if (i === undefined) appends.push(row);
        else sh.getRange(i + 2, 1, 1, HEADER.length).setValues([row]);
        revs.push({ coll, id: op.id, rev });
      });
      if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, HEADER.length).setValues(appends);
      deletes.sort((a, b) => b - a).forEach(i => sh.deleteRow(i + 2));
    });
    return { ok: true, revs };
  });
}

// バックアップからの復元・全削除：すべてのシートの内容を置き換える
function apiReplaceAll(json) {
  const req = JSON.parse(json);
  return withLock_(() => {
    const at = new Date();
    const by = user_();
    Object.keys(SHEETS).forEach(coll => {
      const sh = sheet_(coll);
      if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, HEADER.length).clearContent();
      const rows = (req.data[coll] || []).map(r => row_(r, newRev_(), at, by));
      if (rows.length) sh.getRange(2, 1, rows.length, HEADER.length).setValues(rows);
    });
    return { ok: true };
  });
}
