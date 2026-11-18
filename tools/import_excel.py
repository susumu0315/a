"""防災品_受注管理表.xlsx をアプリのバックアップ形式（JSON）に変換する。
できた JSON をアプリの「設定 → バックアップから復元」で読み込むと、Excel の内容がアプリに入る。

使い方: python tools/import_excel.py <防災品_受注管理表.xlsx> <出力先.json>

- 受注管理表：受注日・会社・納期・担当・出荷日・請求書処理・備考が同じ連続した行を 1 件の受注にまとめる
  （1 行 = 1 明細）。出荷日がある受注には、その日付の納品書を作る（在庫の「出荷済」になる）。
- 色別在庫管理：期首在庫・発注点を取り込む。Excel の「入庫累計」（手入力の数字）は入庫記録 1 件として取り込み、
  アプリの在庫が Excel と同じ数字になるようにする。
- 入庫記録シートの行は取り込まない（Excel の在庫計算に入っていないため）。
- 単価は Excel にないので空欄のまま（金額は 0 円になる）。
"""
import collections
import datetime
import json
import random
import string
import sys

import openpyxl

PRODUCT_NAMES = {'ＲＱＭ': 'レスキューミー'}
DEFAULT_PARTNERS = ['株式会社ボウエキ', '株式会社ジーエム', '相日防災株式会社', '株式会社三和製作所',
                    '株式会社ライズ', '久下小学校', 'くらし企画', 'SIAソリューション']


def uid():
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=12))


def ymd(v):
    return v.strftime('%Y-%m-%d') if isinstance(v, (datetime.date, datetime.datetime)) else ''


def partner_name(v):
    return str(v).strip().replace('㈱', '株式会社')


def product_name(v):
    v = str(v or '').strip()
    return PRODUCT_NAMES.get(v, v)


def main(src, dst):
    wb = openpyxl.load_workbook(src, data_only=True)

    master = wb['マスタ']
    colors = [r[0] for r in master.iter_rows(min_row=2, values_only=True) if r[0]]
    staff = [r[4] for r in master.iter_rows(min_row=2, values_only=True) if r[4]]

    partners = {}

    def partner(name):
        if name not in partners:
            partners[name] = {'id': uid(), 'name': name, 'kind': 'customer', 'honorific': '御中',
                              'zip': '', 'address': '', 'tel': '', 'contact': ''}
        return partners[name]['id']

    for n in DEFAULT_PARTNERS:
        partner(n)

    products = {'レスキューミー': {'id': uid(), 'name': 'レスキューミー', 'unit': '個', 'price': 1250, 'useColor': True}}

    # 受注管理表：見出しは 4 行目、データは 5 行目から
    rows = [r for r in wb['受注管理表'].iter_rows(min_row=5, values_only=True) if r[1] and r[2]]
    groups = []
    for r in rows:
        no, odate, company, prod, color, qty, due, answer, st, shipped, billing, note = r[:12]
        key = (ymd(odate), partner_name(company), ymd(due), ymd(answer), st or '', ymd(shipped), billing or '', (note or '').strip())
        if groups and groups[-1]['key'] == key:
            groups[-1]['rows'].append(r)
        else:
            groups.append({'key': key, 'rows': [r]})

    orders, deliveries = [], []
    groups.sort(key=lambda g: (g['key'][0], g['rows'][0][0]))
    for n, g in enumerate(groups, 1):
        odate, company, due, answer, st, shipped, billing, note = g['key']
        items = []
        for r in g['rows']:
            name = product_name(r[3])
            if name not in products:
                products[name] = {'id': uid(), 'name': name, 'unit': '個', 'price': 0, 'useColor': False}
            items.append({'id': uid(), 'name': name, 'spec': (r[4] or '').strip(), 'qty': r[5] or 0, 'unit': '個', 'price': ''})
        order = {'id': uid(), 'orderNo': f'JO-{odate[:4]}-{n:04d}', 'customerPoNo': '', 'customerId': partner(company),
                 'orderDate': odate, 'dueDate': due, 'answerDate': answer, 'staff': st, 'billing': billing or '未処理',
                 'subject': '', 'taxRate': 10, 'items': items, 'note': note, 'importedFrom': 'Excel 受注管理表 No.' + ','.join(str(r[0]) for r in g['rows'])}
        orders.append(order)
        if shipped:
            deliveries.append({'id': uid(), 'orderId': order['id'], 'deliveryDate': shipped, 'subject': '', 'taxRate': 10, 'note': '',
                               'items': [{**it, 'id': uid(), 'ref': it['id']} for it in items]})
    deliveries.sort(key=lambda d: d['deliveryDate'])
    for n, d in enumerate(deliveries, 1):
        d['dnNo'] = f'DN-{d["deliveryDate"][:4]}-{n:04d}'

    # 色別在庫管理：見出しは 4 行目
    opening, reorder, receipts, excel_stock = {}, {}, [], {}
    for r in wb['色別在庫管理'].iter_rows(min_row=5, values_only=True):
        color = r[0]
        if not color or color == '合計':
            continue
        if r[1]:
            opening[color] = r[1]
        if r[7]:
            reorder[color] = r[7]
        if r[2]:
            receipts.append({'id': uid(), 'date': datetime.date.today().isoformat(), 'color': color, 'qty': r[2],
                             'note': 'Excel 色別在庫管理の「入庫累計」（取込時点の累計）'})
        excel_stock[color] = {'出荷済': r[3] or 0, '現在庫': r[4] or 0, '引当': r[5] or 0, '有効在庫': r[6] or 0}

    prospects = []
    for r in wb['見込み案件'].iter_rows(min_row=3, values_only=True):
        if not ymd(r[1]) or not r[2]:
            continue
        prospects.append({'id': uid(), 'orderId': '', 'date': ymd(r[1]), 'company': str(r[2]).strip(), 'product': product_name(r[3]),
                          'color': r[4] or '', 'qty': r[5] or 0, 'dueDate': ymd(r[6]), 'answerDate': ymd(r[7]), 'staff': r[8] or '', 'note': ''})

    data = {
        'version': 5, 'partners': list(partners.values()), 'products': list(products.values()), 'colors': colors, 'staff': staff,
        'stock': {'opening': opening, 'reorder': reorder}, 'orders': orders, 'pos': [], 'deliveries': deliveries,
        'receipts': receipts, 'prospects': prospects,
    }
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=1)

    # 確認用：アプリでの在庫計算と Excel の在庫表を比べる
    shipped, allocated = collections.Counter(), collections.Counter()
    for d in deliveries:
        for it in d['items']:
            if it['spec']:
                shipped[it['spec']] += it['qty']
    delivered_orders = {d['orderId'] for d in deliveries}
    for o in orders:
        if o['id'] not in delivered_orders:
            for it in o['items']:
                if it['spec']:
                    allocated[it['spec']] += it['qty']
    received = collections.Counter()
    for r in receipts:
        received[r['color']] += r['qty']
    print(f'受注 {len(orders)} 件（Excel {len(rows)} 行）／納品書 {len(deliveries)} 件／取引先 {len(partners)} 社／'
          f'商品 {len(products)} 品／見込み案件 {len(prospects)} 件')
    print('色\tアプリ現在庫\tExcel現在庫\tアプリ有効在庫\tExcel有効在庫')
    for c, x in excel_stock.items():
        cur = opening.get(c, 0) + received[c] - shipped[c]
        print(f'{c}\t{cur}\t{x["現在庫"]}\t{cur - allocated[c]}\t{x["有効在庫"]}{"" if cur == x["現在庫"] and cur - allocated[c] == x["有効在庫"] else "\t← 不一致"}')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
