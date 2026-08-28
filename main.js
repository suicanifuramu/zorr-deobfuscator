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

for (const dir of Object.values(dirs)) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        resolve(data);
      });
    }).on("error", reject);
  });
}

async function getLatestJsAndDeobfuscate() {
  try {
    console.log("HTML取得中...");

    // トップページ取得
    const html = await fetch(baseUrl);

    // .js ファイル抽出
    const match = html.match(/<script\s+src="(.*?\.js.*?)"/i);

    if (!match) {
      console.log(".js ファイルが見つかりません");
      return;
    }

    let jsFile = match[1];

    // URL補正
    if (jsFile.startsWith("/")) {
      jsFile = baseUrl.replace(/\/$/, "") + jsFile;
    } else if (!jsFile.startsWith("http")) {
      jsFile = baseUrl + jsFile;
    }

    console.log("最新JS:", jsFile);

    // ファイル名 (例: 1K0SNA6KL.js → base名 1K0SNA6KL)
    const fileName = path.basename(jsFile.split("?")[0]);
    const baseName = fileName.replace(/\.js$/, "");

    console.log("JSダウンロード中...");

    const body = await fetch(jsFile);

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
  } catch (err) {
    console.error("エラー:", err.message);
  }
}

getLatestJsAndDeobfuscate();