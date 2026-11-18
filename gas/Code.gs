/* resqmej 受注・発注管理：Google スプレッドシートを保存先にするサーバー側の処理
 * このスクリプトはスプレッドシートの「拡張機能 → Apps Script」に貼り付けて使います（README 参照）。
 * データは 1 レコード 1 行で、一覧ごとのシートに保存します。data 列（JSON）が本体で、内容列は人が見るための説明です。
 */

const SHEETS = {
  config: '設定', partners: '取引先', products: '商品', orders: '受注', pos: '発注書',
  deliveries: '納品書', receipts: '入庫', prospects: '見込み案件',
};
const HEADER = ['id', '内容', '更新日時', '更新者', 'rev', 'data'];
const COL = { id: 0, label: 1, at: 2, by: 3, rev: 4, data: 5 };
// 同じ番号が重複してはいけない項目
const UNIQUE = { orders: ['orderNo', '自社受注No.'], pos: ['poNo', '発注No.'], deliveries: ['dnNo', '納品書No.'] };

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
  }
  return sh;
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
    data[coll] = rows_(sheet_(coll))
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
