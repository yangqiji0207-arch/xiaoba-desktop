<div align="center">
  <img src="renderer/xiaoba.png" width="120" alt="小八" />
  <h1>小八 · 桌面数字伙伴</h1>
  <p>一点陪伴，就在桌面。</p>
  <p>Mac / Windows · 蓝色界面 · DeepSeek API / ChatGPT 登录</p>
</div>

## 认识小八

小八是基于 Electron 与 Harness 的桌面聊天伙伴。点击人物展开聊天，再次点击收起；拖动人物可调整位置。

- 透明置顶窗口，蓝色聊天和设置界面。
- DeepSeek API：填写自己的模型密钥即可使用。
- ChatGPT：浏览器登录授权，选择账号返回的可用模型。
- 重启后恢复当前会话；新对话使用独立上下文。
- 性格和偏好由用户填写、修改，随对话注入上下文。
- 密钥和登录凭据使用系统加密存储；Mac 使用 Keychain，Windows 使用 DPAPI。

当前主要功能为文字聊天，没有语音服务；偏好由用户编辑，不会自动从聊天中提取长期记忆。应用当前不执行桌面任务，不提供文件、终端或浏览器工具。

## 下载与使用

[打开小八下载网页](http://120.24.39.112/index.html)

当前版本：**0.1.6**。

- **Windows x64**：解压 `Xiaoba-0.1.6-win-x64.zip`，运行里面的安装程序。
- **Apple 芯片 Mac**：解压 `Xiaoba-0.1.6-mac-arm64.zip`，将 `小八.app` 放入「应用程序」后打开。

点击设置，选择 DeepSeek API 并填写模型密钥，或选择 ChatGPT 套餐并点击「登录授权」。聊天需要联网；ChatGPT 的可用模型与套餐权限以账号实际授权结果为准。

测试版尚未完成正式平台代码签名和 Mac 公证，系统可能提示确认来源。

## 本地开发

需要 Node.js 24 和 npm。依赖版本由 `package-lock.json` 固定。

```sh
npm ci
npm test
npm run test:integration
npm start
```

打包：

```sh
# Apple 芯片 Mac
npm run dist:mac -- --arm64

# Windows x64
npm run dist:win -- --x64
```

打包输出目录由 `package.json` 的 `build.directories.output` 控制，当前为项目旁的 `../release-0.1.6/`。

`.github/workflows/build.yml` 支持手动触发以及 `v*` 标签触发，在 Mac 和 Windows 上构建安装包。构建产物保存为工作流附件，需要另行创建正式 Release 才会作为版本发布。

## 如何运行

```text
桌面人物和聊天界面
  ↓ 受限 IPC
应用主进程
  ├─ 系统加密存储 / 本地设置 / 界面聊天记录
  ├─ ChatGPT 登录、模型发现、上下文和流式问答
  └─ DeepSeek Harness 子进程、会话持久化和模型调用
```

DeepSeek Harness 随客户端分发，不需要用户单独安装。当前固定使用 `@deepseek-ai/dsh@0.2.0-rc.2`；升级后需要重新检查会话恢复与原生依赖。

## 检查与验证

- `npm test`：24 项检查，覆盖登录协议、账号校验、系统存储、旧人设迁移与打包依赖。
- `npm run test:integration`：使用实际 Harness 与本地模拟模型服务，检查人设、偏好、上下文恢复和会话隔离。
- Windows 0.1.6 已在 Windows 11 ARM64 虚拟机以 x64 模式验证安装、启动、加密密钥保存、重启恢复与模拟问答。

模拟服务检查不使用真实账号，也不证明真实模型或 ChatGPT 套餐一定可用；实际登录与问答需要使用者的有效账号或密钥。

## 文件结构

| 目录 | 用途 |
| --- | --- |
| `renderer/` | 人物素材、动画、聊天和设置界面 |
| `src/` | 桌面窗口、Harness、ChatGPT、设置和系统加密存储 |
| `harness/` | 最小运行配置与会话恢复插件 |
| `scripts/` | 原生依赖检查、打包和下载文件准备 |
| `tests/` | 单元检查、Harness 集成检查和 Windows 安装版验证 |
| `.github/workflows/` | Mac 和 Windows 构建工作流 |

`scripts/prepare-download.cjs` 将已有安装包复制到项目旁的 `../download-site/downloads/`，生成版本清单和 SHA-256 校验值。公网下载网页单独维护在该目录。

## 数据说明

设置和会话保存在本机的 Electron 用户数据目录。为兼容早期版本，当前目录仍沿用 `Halo`：Mac 为 `~/Library/Application Support/Halo/`，Windows 为 `%APPDATA%/Halo/`。

- `settings.json` 保存设置及加密 API 密钥。
- `chatgpt-account.json` 保存账号标识及系统加密的登录凭据。
- `chat-*.json` 保存界面聊天记录，`harness/` 保存 DeepSeek 会话状态。
- 普通聊天记录和会话文件未加密。聊天文字、人设与偏好会发送给所选模型服务。
- 角色名称迁移会修正旧人设；旧聊天回复保留原文。
- 没有开发者共享密钥、自动更新或开发者遥测服务。

仓库只包含程序源码、素材和开发配置，不包含个人登录信息和聊天记录。

## 许可

见 [LICENSE](LICENSE)。第三方组件说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
