// Apps Script 用に index.html・CSS・JS・ロゴを 1 つの gas/Index.html にまとめる
// 使い方：node tools/build-gas.js
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const css = read('css/style.css');
const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'img/logo.png')).toString('base64');
const logoLine = "const LOGO_SRC = 'img/logo.png';";
let js = read('js/app.js');
if (!js.includes(logoLine)) throw new Error('app.js に LOGO_SRC の定義が見つかりません');
js = js.replace(logoLine, `const LOGO_SRC = '${logo}';`);
if (/<\/script/i.test(js) || /<\/style/i.test(css)) throw new Error('埋め込めない文字列（</script> など）が含まれています');

let html = read('index.html');
const link = '<link rel="stylesheet" href="css/style.css">';
const script = '<script src="js/app.js"></script>';
if (!html.includes(link) || !html.includes(script)) throw new Error('index.html の CSS・JS の読み込み行が見つかりません');
html = html
  .replace(link, () => `<style>\n${css}</style>`)
  .replace(script, () => `<script>\n${js}</script>`)
  .replace('<!doctype html>', '<!doctype html>\n<!-- このファイルは tools/build-gas.js で自動生成しています。直接編集しないでください。 -->');

fs.writeFileSync(path.join(root, 'gas/Index.html'), html);
console.log(`gas/Index.html を作成しました（${Math.round(html.length / 1024)} KB）`);
