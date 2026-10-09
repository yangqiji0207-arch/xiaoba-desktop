const fs = require("node:fs");
const path = require("node:path");
const { zipSync, strToU8 } = require("fflate");

async function main() {
  const installer = process.argv[2];
  if (!installer || !/-win-x64\.exe$/.test(installer))
    throw Error("Expected Windows x64 installer");
  const output = installer.replace(/\.exe$/, ".zip");
  const zip = zipSync(
    {
      [path.basename(installer)]: fs.readFileSync(installer),
      "安装说明.txt": strToU8(
        "Windows 安装说明\r\n\r\n1. 右键下载文件，选择全部解压缩。\r\n2. 双击 小八 安装程序，按提示完成安装。\r\n3. 在桌面或开始菜单打开 小八。\r\n4. 点击小八的设置，选择 API 模型并填写密钥；或选择 ChatGPT 套餐，完成浏览器登录授权，选择模型并保存。\r\n\r\n当前安装包为未签名测试版，安装时系统可能提示确认来源。\r\n",
      ),
    },
    { level: 0 },
  );
  fs.writeFileSync(output, zip);
  console.log(`Prepared ${path.basename(output)}`);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
