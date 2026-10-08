const https = require("https");
const fs = require("fs");
const path = require("path");
const { webcrack } = require("webcrack");
const { deobfuscate } = require("./deobfuscator");

const baseUrl = "https://zorr.pages.dev/";
const dirs = {
  source: "source",
  webcrack: "webcrack",
  deobfuscated: "deobfuscated",
};
const REQUEST_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;

for (const dir of Object.values(dirs)) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function fetch(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const { statusCode, headers } = res;

      // リダイレクト追従
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error(`リダイレクトが多すぎます: ${url}`));
          return;
        }
        resolve(fetch(new URL(headers.location, url).href, redirects + 1));
        return;
      }

      if (statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${statusCode}: ${url}`));
        return;
      }

      // チャンクごとに文字列化するとマルチバイト文字が分断されるため、結合してからデコードする
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          url,
          contentType: headers["content-type"] || "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", reject);
    });

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`タイムアウト (${REQUEST_TIMEOUT_MS}ms): ${url}`));
    });
    req.on("error", reject);
  });
}

async function getLatestJsAndDeobfuscate() {
  console.log("HTML取得中...");

  // トップページ取得
  const page = await fetch(baseUrl);

  // .js ファイル抽出 (属性の順序やクォートの種類に依存しない)
  const match = page.body.match(/<script\b[^>]*?\ssrc\s*=\s*["']?([^"'\s>]+\.js(?:\?[^"'\s>]*)?)/i);

  if (!match) {
    throw new Error(".js ファイルが見つかりません");
  }

  // URL補正 (相対パス・絶対パス・完全URLのいずれにも対応)
  const jsFile = new URL(match[1], page.url).href;
  console.log("最新JS:", jsFile);

  // ファイル名 (例: 1K0SNA6KL.js → base名 1K0SNA6KL)
  const fileName = path.basename(new URL(jsFile).pathname);
  const baseName = fileName.replace(/\.js$/, "");

  console.log("JSダウンロード中...");

  const script = await fetch(jsFile);

  // 存在しないパスでも 200 で HTML を返すため、中身が JS かを確認する
  if (/html/i.test(script.contentType) || /^\s*</.test(script.body)) {
    throw new Error(`JS ではなく HTML が返されました (Content-Type: ${script.contentType}): ${jsFile}`);
  }
  const body = script.body;

  // source/<name>.js
  const sourcePath = path.join(dirs.source, fileName);
  fs.writeFileSync(sourcePath, body, "utf8");
  console.log("保存完了:", sourcePath);

  // webcrack/<name>-webcracked.js
  console.log("webcrack 実行中...");
  const result = await webcrack(body);
  const webcrackedPath = path.join(dirs.webcrack, `${baseName}-webcracked.js`);
  fs.writeFileSync(webcrackedPath, result.code, "utf8");
  console.log("保存完了:", webcrackedPath);

  // deobfuscated/<name>-deobfuscated.js
  console.log("deobfuscate 実行中...");
  const deob = deobfuscate(result.code);
  const deobfuscatedPath = path.join(dirs.deobfuscated, `${baseName}-deobfuscated.js`);
  fs.writeFileSync(deobfuscatedPath, deob.code, "utf8");
  console.log("保存完了:", deobfuscatedPath);
}

getLatestJsAndDeobfuscate().catch((err) => {
  console.error("エラー:", err.message);
  process.exitCode = 1;
});
