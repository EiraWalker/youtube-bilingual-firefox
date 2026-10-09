# 首版 0.1.0 历史验证记录

当前版本的结果见 [0.2.0 验证记录](validation-0.2.md)。本文件描述早期版本；`output` 下最新报告已由 0.2.0 测试更新。

日期：2026-10-09。测试浏览器：Firefox 157.0.1；扩展声明最低版本为 Firefox 142。

## 验证结论

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 字幕解析、时间窗口、翻译协议、缓存、取消、原生字幕恢复 | 19 / 19 通过 | `npm test` |
| Mozilla 扩展校验 | 0 错误、0 提示、0 警告 | `npm run package` 中的 `web-ext lint` |
| 原生 Firefox：生产包安装、设置、权限、播放器交互和错误恢复 | 24 / 24 通过 | [Firefox 报告](../output/firefox/report.json) |
| 用户指定 API 的真实 Chat Completions | 通过 | [真实 API 报告](../output/real-api.json) |
| 用户指定 API → 扩展后台 → Firefox 播放器内双语显示 | 通过，使用本地合成视频与字幕 | [真实 API 播放器报告](../output/firefox-live/live-probe.json)、[截图](../output/firefox-live/real-api-player.png) |
| 真实 YouTube 视频完整字幕链路 | 尚未通过 | 同一报告中的 `live.subtitleVerified: false` |

真实 API 使用 `http://127.0.0.1:8045/v1/chat/completions` 和模型 `gemini-3.8-flash-high`。Firefox 测试通过扩展设置页保存配置、授予权限，再由生产扩展请求接口；播放器内显示原文 `Hello world.` 与真实译文 `你好，世界。`。密钥未写入项目文件、命令参数、报告或安装包。

本地播放器测试覆盖前后跳转、暂停、2 倍速、浏览器全屏、广告隐藏、字幕空档、字幕轨道切换、同视频播放器重建、按钮延迟出现、YouTube 式页面导航、实时字幕文本回退、HTTP 429 后停止请求与手动重试。夹具仅模拟 YouTube 页面及字幕入口；它不能证明所有实际 YouTube 视频都可读取字幕。

## 真实 YouTube 测试边界

独立 Firefox 测试访问 [Simon Sinek 的 TED 视频](https://www.youtube.com/watch?v=qp0HIF3SfI4)。已确认视频正常播放、插件按钮出现、可识别多语言字幕轨道。启用双语字幕后未获取到原字幕；关闭插件后的原生 CC 基线也没有字幕文本，英文轨道的三个字幕响应均记录为零字节。

因此，本次没有验证该真实视频的双语显示。报告顶层的 `passed: true` 表示真实 API 和本地播放器检查通过，实际网站结果由 `live.subtitleVerified` 单独记录。报告中的 `apiRequestCount` 是模拟 API 的计数器，不统计真实 API 请求。

目前证据只能确认该测试会话未取得可读字幕，不能确定其原因，也不能据此认定用户常用 Firefox 中会出现同样情况。首版的原生文本回退需要 YouTube 原生 CC 能显示文本；没有原字幕时会提示重试。本版没有语音转写能力。

常用 Firefox 中的最终验收步骤：安装扩展并配置接口 → 测试连接 → 打开有原字幕的视频并确认原生 CC 可显示 → 点击「双语字幕」→ 检查播放、跳转、全屏和字幕切换。该实际使用验收仍待完成。

## 交付物

- [Firefox 安装包](../dist/youtube-bilingual-firefox-0.1.0.zip)，20,262 字节。
- SHA256：`e4ae4df37e176b0b776e75ecd8d3a19dfc8909f8d94abad4e0e65eefc40fa31f`。
- 安装包与原生 Firefox 测试安装的文件逐项一致。
- 当前交付为未签名临时扩展；Firefox 重启后需要重新加载，永久安装需后续 Mozilla 签名。
- 安装和配置步骤见 [README](../README.md)。
