# FOMO Dock

FOMO Dock 是一个面向 GMGN 和 DeBot 代币详情页的 Chrome Manifest V3 插件。它把 FOMO 数据做成独立浮窗，不包含原项目里的 Dev 高亮、Pump、985monitor 推送、持仓提醒、原生更新器等功能。

## 当前功能

- 在 GMGN 与 DeBot 的受支持代币页显示 FOMO 入口。
- 查看 FOMO 持仓者、观点和交易。
- 持仓者滚动到可见区域时加载 7 日盈亏。
- 自动捕获当前浏览器里的 FOMO 登录态，并由 FOMO 页面自身的 Privy SDK 续期。
- 浮窗可拖拽、折叠，两个平台分别记忆位置与开关状态。
- 支持 Chrome 内置英文到中文本地翻译（浏览器支持时可用）。
- 样式变量与组件规则分离，方便继续设计。

支持网络：Ethereum、BSC、Base、Solana、Monad、Robinhood。

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
fomo-early.js    FOMO 页面启动前的会话接续
fomo-auth.js     FOMO 登录态捕获与心跳
content.js       GMGN/DeBot 路由适配与浮窗业务
theme.css        颜色、圆角、阴影、宽度等主题变量
styles.css       浮窗组件和响应式布局
popup.*          插件设置与登录态状态
```

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

FOMO 登录令牌保存在 `chrome.storage.local`，只用于请求 `https://prod-api.fomo.family`。插件不会把令牌发送给 GMGN、DeBot 或其他服务。

## 来源说明

本项目依据本地 `985gmgn-helper-v0.46.34` 中的 FOMO 功能边界重新拆分，原项目地址：<https://github.com/0xuezhang985/985gmgn-helper>。

原仓库当前未看到明确的开源许可证文件。公开发布或分发本项目之前，请先向原作者确认代码再利用许可，并按对方要求保留署名或许可证文本。
