const https = require("https");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const baseUrl = "https://zorr.pages.dev/";

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

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(stderr || error.message);
        return;
      }

      resolve(stdout);
    });
  });
}

async function getLatestJsAndWebcrack() {
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

    // 一時保存名
    const fileName = path.basename(jsFile.split("?")[0]);

    // 出力ファイル
    const outputName = "webcracked.js";

    console.log("JSダウンロード中...");

    https.get(jsFile, (res) => {
      if (res.statusCode !== 200) {
        console.log("取得失敗:", res.statusCode);
        return;
      }

      const file = fs.createWriteStream(fileName);

      res.pipe(file);

      file.on("finish", async () => {
        file.close();

        console.log("保存完了:", fileName);
        console.log("webcrack 実行中...");

        try {
          // webcrack の結果を webcracked.js に保存
          await runCommand(
            `npx webcrack "${fileName}" > "${outputName}"`
          );

          console.log("解析完了:", outputName);

        } catch (err) {
          console.error("webcrack失敗:", err);
        }
      });
    });

  } catch (err) {
    console.error("エラー:", err.message);
  }
}

getLatestJsAndWebcrack();