# Coopanion 个人日程（`cortico-world-personal-agenda`）

Coopanion 的个人日程与桌面倒计时扩展（World 契约 6），支持**WebUI 日程管理**、**独立桌面倒计时挂件**以及**复用官方 QQ 插件的定时提醒与群/私聊命令**。不修改 Coopanion 主程序，所有设置与开关均在插件页面内完成。

- **npm 包名**：[`cortico-world-personal-agenda`](https://www.npmjs.com/package/cortico-world-personal-agenda)
- **适用环境**：Windows + Coopanion 0.2.20+（World API 6）
- **开源协议**：MIT

---

## 界面预览

| 桌面倒计时挂件 | 日程管理面板 |
| :---: | :---: |
| ![桌面倒计时挂件](docs/images/countdown-widget.png) | ![日程管理面板](docs/images/agenda-desktop.png) |

| 新增 / 编辑日程 | QQ 提醒接入设置 |
| :---: | :---: |
| ![编辑日程](docs/images/agenda-editor.png) | ![QQ 接入设置](docs/images/qq-connection.png) |

---

## 核心功能

- **日程管理**：支持新增、编辑、取消与重新启用，按「待发生 / 全部 / 已取消」筛选，支持按标题、备注或详情搜索；多人多端同时修改时自动做版本冲突保护。
- **桌面倒计时挂件**：独立的置顶/折叠桌面小窗，实时显示天与时分秒；临近自动高亮，支持手动固定指定事项，保存日程后即时刷新；识别详情中的 YouTube / Bilibili / Twitch 直播链接，底部提供快捷跳转。
- **按日程独立时区**：每条日程单独保存时区（默认跟随电脑，也可选择如 `Asia/Tokyo`、`America/New_York`、`Europe/London` 等 IANA 时区），自动处理夏令时缺口与重复时段。
- **QQ 自动提醒与命令**：默认复用官方 QQ 插件（`cortico-world-qq`）的连接，无需再手动配置一套 OneBot；支持分别配置私聊接收与群聊提醒、随时开启/关闭「QQ 自动提醒」，并保留逐目标的去重回执与失败重试。
- **自然语言日程管理**：自动复用 Coopanion 当前启用的语言模型（`activeProvider`，兼容 `coo` 与 `openai-responses-compat` 模型配置），可在授权私聊中使用自然语言查询、添加、改期或取消日程。

---

## 安装方式

### 方式一：通过 Coopanion 扩展市场安装（推荐）

1. 在 Coopanion 打开 **扩展管理**，搜索 **`cortico-world-personal-agenda`**（或「个人日程」）并安装。
2. 按提示重启核心，在 **World** 中启用 **个人日程**。
3. 直接点击插件页面上的「显示挂件」即可使用（扩展首次启动会自动从本机 Coopanion 准备独立的桌面窗口运行环境，无需额外手动脚本）。

### 方式二：从 GitHub 源码本地构建安装

环境要求：Windows、Node.js 22+（推荐 24）、已安装 Coopanion。

```powershell
git clone https://github.com/Nakamach1Arale/cortico-world-personal-agenda.git
cd cortico-world-personal-agenda
npm run build
npm run install:coopanion
```

若 Coopanion 安装在自定义目录，或本机 API 端口非默认值，可显式指定：

```powershell
node scripts/install.mjs --app="D:/Apps/Coopanion" --api=http://127.0.0.1:17788
```

> 本地安装脚本仅在 `data/` 下准备扩展目录和独立窗口环境，不会修改主程序，也不会覆盖已有日程、密钥或提醒回执。

---

## 使用说明

### 1. 日程字段说明

| 页面字段 | 数据字段 | 填写要求 | 用途 |
| --- | --- | --- | --- |
| 标题 | `title` | 必填 | 倒计时大字标题与提醒主名称 |
| 副标题 | `subtitle` | 选填 | 显示在标题下方，留空隐藏 |
| 备注 | `remark` | 选填 | 挂件顶部短标签，例如 `演出 · 线上直播` |
| 时区 | `timezone` | 默认跟随电脑 | 仅作用于该日程，编辑切换时区可保留同一实际时刻 |
| 开始时间 | `start` | 必填 | 按当前选定时区解析的本地时间 |
| 时间状态 | `status` | 默认已确定 | 支持「已确定」或「预计时间」 |
| 提醒时间 | `reminders_minutes` | 默认 1天 / 30分 / 到点 | 可勾选预设或填自定义整数分钟（最多 5 个，全空仅显示倒计时） |
| 详情 | `details` | 选填 | 完整备注文本，QQ 提醒会一并附上；含直播链接时挂件显示「观看直播」 |
| 详情链接 | `url` | 选填 | 仅接受 `https://` 链接 |

### 2. QQ 提醒与官方 QQ 插件适配

未接入 QQ 时，网页日程管理与桌面倒计时仍可正常独立使用。需要 QQ 提醒时：

1. 打开插件页面的 **QQ 接入 → 设置连接**。
2. 按需填写 **私聊接收 QQ** 和/或 **接收群号**（所有接收目标与开关默认留空，不会自动从官方 QQ 聊天列表导入）。
3. 保持默认的 **复用官方 QQ（推荐）**，点 **检测连接** 验证登录状态，再点 **保存并连接**。
   - 若不使用官方 QQ，也可切换 **手动连接 OneBot** 填写 `ws://` / `wss://` 地址与访问令牌（令牌通过宿主密钥接口写入部署 `.env`，页面不回显明文）。
4. 随时可通过页面上的 **QQ 自动提醒** 开关暂停或恢复定时推送，不影响普通 QQ 聊天与倒计时显示。

### 3. 群聊添加权限

私聊与群聊共享同一份日程列表，分别记录各自提醒回执。如需允许在指定接收群里添加日程，可在 **QQ 接入** 弹窗中开启 **允许在群里用 `/日程` 添加日程** 并勾选授权身份（默认全部关闭）：

| 权限开关 | 允许触发群命令的成员 |
| --- | --- |
| 主人 | 手动填写的「主人 QQ」（仅用于权限校验，不会自动接收私聊提醒） |
| 群管理员 | OneBot 上报身份为 `admin` 的成员 |
| 群主 | OneBot 上报身份为 `owner` 的成员 |

命令示例（支持在时间后附加 `@IANA时区`）：

```text
/日程 添加 2030-11-10 20:00 周末音乐会
/日程 添加 2030-11-10 20:00 @Asia/Tokyo 线上发布会
```

> 群内仅响应已勾选身份成员在指定接收群发送的 `/日程 添加` 指令，回复只包含刚添加的事项并留在该群；群内不开放查询清单、修改、取消或自然语言管理。

### 4. 模型复用说明

- **自然语言理解与提醒开场白**自动读取 Coopanion 部署配置中的 `activeProvider`（如 DeepSeek、Gemini 等兼容接口），若未配置或不可用，确定格式的 `/日程` 命令、网页编辑与倒计时仍照常工作，提醒正文退回精确日程事实。

---

## 数据存储与隐私

所有运行数据均保存在当前 Coopanion 部署的 `data/` 目录下：

| 文件 | 用途 |
| --- | --- |
| `personal-agenda.json` | 日程条目与独立时区设置 |
| `personal-agenda-delivery.json` | 私聊与群聊的分目标提醒回执与重试记录 |
| `personal-agenda-dialogue.json` | 私聊日程上下文记录 |
| `countdown-window.json` | 挂件位置、置顶、折叠与固定显示偏好 |

- 新安装默认日程为空，默认无任何 QQ 接收人。
- 本发布仓库仅包含源码、测试、前端构建产物、自绘图标与示例截图，不包含任何个人日程、聊天记录或密钥。
- 安全与权限设计说明见 [SECURITY.md](SECURITY.md)，完整变更记录见 [CHANGELOG.md](CHANGELOG.md)。

---

## 开发与验证

```powershell
npm test        # 运行全部 81 项单元与集成测试（无网络依赖、不触发真实 QQ 发送）
npm run build   # 重新打包前端产物、图标与 describe.json
```

浏览器界面与挂件截图校验（需本机 Chrome/Chromium 与 `puppeteer-core`）：

```powershell
npm install
npm run test:ui
```

---

## 许可

本项目代码使用 [MIT](LICENSE) 许可开源。vendored `ws` 保留各自原 MIT 版权声明，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
