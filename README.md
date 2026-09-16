# FOMO Dock

FOMO Dock 是一个面向 GMGN 和 DeBot 代币详情页的 Chrome Manifest V3 插件。它把 FOMO 数据做成页内面板或独立浮窗，并提供默认关闭的 FOMO 推送混排；不包含原项目里的 Dev 高亮、Pump、持仓提醒、原生更新器等功能。

## 当前功能

- 在 GMGN 与 DeBot 的受支持代币页显示 FOMO 入口。
- GMGN 的 FOMO 按钮位于“开发者代币”右侧，打开后以高亮色显示；内容栏右上角可直接在页内与浮窗之间切换。
- 查看 FOMO 持仓者、观点和交易。
- GMGN 持仓者显示链上持仓排名；钱包滚动到可见区域时加载带收益分档的 7 日盈亏。
- 自动捕获当前浏览器里的 FOMO 登录态，并由 FOMO 页面自身的 Privy SDK 续期。
- 登录续期复用现有 FOMO 应用页，守护页身份在后台休眠后仍保留；仅清理扩展创建且未被用户接管的多余后台页。
- 浮窗可拖拽、折叠，两个平台分别记忆位置与开关状态。
- 支持 Chrome 内置英文到中文本地翻译（浏览器支持时可用）。
- 可选启用 FOMO 推送混排，连接 985monitor 后按其关注、屏蔽和事件偏好过滤内容。
- 样式变量与组件规则分离，方便继续设计。
- FOMO 官方接口统一排队请求，列表缓存 90 秒，相同请求自动合并；自动刷新最短 2 分钟。
- 遇到 429 限流后自动等待，保留已有数据并显示恢复时间；等待状态在重启浏览器后继续生效。
- 支持识别 FOMO 430/431 响应中的登录失效提示。
- 985monitor 多页面共享同步锁和重试等待，旧请求不会覆盖新登录态。
- 混排仅在交易哈希、网络、代币和买卖方向一致时与原生交易去重，避免误吞同金额交易。
- GMGN 表格混排根据原生列宽和间距对齐，窗口尺寸变化时重新测量。

支持网络：Ethereum、BSC、Base、Solana、Monad、Robinhood、Arc（5042）。

## 本地安装

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本目录。
4. 点击插件图标，选择“打开 FOMO 登录”。
5. 在 FOMO 完成登录并刷新一次，再打开 GMGN 或 DeBot 的代币详情页。

## 项目结构

```text
manifest.json    插件权限、站点和脚本入口
background.js    FOMO API、缓存、登录态保活
fomo-auth.js     FOMO 登录态只读同步与心跳
content.js       GMGN/DeBot 路由适配与浮窗业务
feed-*           GMGN/DeBot 追踪流识别与 FOMO 推送混排
monitor-auth.js  985monitor 只读会话与配置同步
theme.css        颜色、圆角、阴影、宽度等主题变量
styles.css       浮窗组件和响应式布局
popup.*          插件设置与登录态状态
```

## 开发验证

运行 `node --test tests/*.test.cjs`，使用模拟请求和浏览器接口验证 Arc、鉴权、限流退避、缓存、登录守护页、多页面同步、混排去重和表格布局，不访问真实账户。

运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package.ps1`，按运行文件白名单生成 `dist/fomo-dock-v版本号.zip`。执行策略仅作用于该打包进程，不更改系统配置；参考代码、测试、设计稿与本地数据均不打入安装包。

## 修改样式

优先编辑 `theme.css` 中的 `--fd-*` 变量。例如：

```css
.fd-root {
  --fd-accent: #7c5cff;
  --fd-bg: rgba(10, 11, 16, 0.97);
  --fd-radius: 18px;
  --fd-width: 460px;
}
```

结构性布局放在 `styles.css`。所有插件节点都使用 `fd-` 前缀，避免和 GMGN、DeBot 的样式互相污染。

## 数据与隐私

FOMO 登录令牌保存在 `chrome.storage.local`，只用于请求 `https://prod-api.fomo.family`。启用推送混排时，985monitor 签发的只读会话也只保存在本机，用于同步混排所需的关注、屏蔽和事件偏好。插件不会把这些令牌发送给 GMGN 或 DeBot。

`scripting` 权限用于在 FOMO 应用页调用已经加载的登录 SDK、识别守护页及恢复登录态同步脚本。扩展不向官网写回令牌，也不自行轮换 refresh token。取消固定守护页即视为用户接管，扩展不会再自动关闭它。

## 来源说明

本项目依据本地 `985gmgn-helper-v0.46.34` 中的 FOMO 功能边界重新拆分，原项目地址：<https://github.com/0xuezhang985/985gmgn-helper>。

Arc、请求限流与登录失效识别参考了上游 `v0.46.91` 的改进。`reference/` 仅用于本地对照，已从 Git 提交范围中排除。

原仓库当前未看到明确的开源许可证文件。公开发布或分发本项目之前，请先向原作者确认代码再利用许可，并按对方要求保留署名或许可证文本。
