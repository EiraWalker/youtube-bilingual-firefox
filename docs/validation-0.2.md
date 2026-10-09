# Firefox 0.2.0 验证记录

日期：2026-10-09。测试浏览器：Firefox 157.0.1；最低支持版本：142。

## 验收结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 字幕解析、桥接生命周期、整轨 API、持久任务、SRT 内容与文件名 | 55 / 55 通过 | `npm test` |
| Mozilla 扩展校验 | 0 错误、0 提示、0 警告 | `npm run package` |
| 原生 Firefox 生产包集成检查 | 45 / 45 通过 | [浏览器报告](validation-evidence/0.2.0/firefox-report.json) |
| 用户指定真实 API → Firefox 播放器双语字幕 | 最终生产包通过 | [真实 API 报告](validation-evidence/0.2.0/real-api-report.json) |
| 真实 YouTube 视频完整字幕链路 | 尚未通过 | 同一报告的 `live.subtitleVerified` |

浏览器夹具采用本地生成的 180 秒视频与完整字幕，包含 150 秒处的字幕。检查第一次启用只发一次 API 请求并包含该远处条目；等待时显示“正在翻译”，视频和原生字幕继续播放；完整译文返回后跳转、倍速、暂停、全屏和播放器重建不会增加翻译请求。

浏览器检查还验证了页面导航、关闭视频标签页后后台完成并保存；重新打开视频复用结果；真正关闭 Firefox 并以同一独立配置重启、重新临时安装扩展后，设置和完整译文仍可读取，且不发新的翻译请求。原文、译文、双语 SRT 均通过 Firefox downloads API 实际下载，检查时间戳和所选内容。

新增边界回归覆盖：每次“测试连接”都真实请求接口；重新翻译等待期间显示进度且原生字幕可见；广告结束时恢复字幕；任务提交被拒绝后不会用空译文覆盖播放器。

## 真实 API 和实际网站边界

使用用户指定的 `http://127.0.0.1:8045/v1` 与 `gemini-3.8-flash-high`。生产扩展在独立 Firefox 中通过设置页授予 API 权限，并在本地合成视频内显示原文 `Hello world.` 与真实译文 `你好，世界。`。[截图](validation-evidence/0.2.0/real-api-player.png)

三种本地夹具导出示例：[原文](validation-evidence/0.2.0/original.srt)、[译文](validation-evidence/0.2.0/translated.srt)、[双语](validation-evidence/0.2.0/bilingual.srt)。报告和截图是上述测试的快照，已入库；运行期间的浏览器 profile、证书、缓存与原始输出目录不入库。

实际网站测试访问 [Simon Sinek 的 TED 视频](https://www.youtube.com/watch?v=qp0HIF3SfI4)，已识别字幕轨道和插件按钮。但本次会话收到空字幕正文，关闭插件后的原生英文 CC 也没有字幕文本。此结果不能证明用户常用 Firefox 中一定失败，也不能证明纯扩展已解决站点限制；真实视频完整链路仍未验收通过。

报告顶层 `passed` 表示真实 API 和本地播放器检查结果；真实网站是否通过由 `live.subtitleVerified` 单独记录。`apiRequestCount` 只计数模拟服务，不能用于判断真实接口的请求次数。

## 安装包

本地安装包位于 `dist/youtube-bilingual-firefox-0.2.0.zip`，28,933 字节。`dist` 不入 Git，可本地重新打包，或下载 [GitHub Actions](https://github.com/EiraWalker/youtube-bilingual-firefox/actions) 的安装包工件。

SHA256：`02df785569db48a58e4a63c99e908f10177e28595f6be634cc203b87e47a76fa`。

当前为未签名临时扩展，Firefox 重启后需重新加载。Firefox 仍运行时后台继续任务；退出浏览器时未完成任务会停止并在下次启动提示重新翻译。已完成译文持久保存在扩展本地存储中。

API Key 不包含在字幕记录、导出文件或安装包中。测试采用专用 Firefox 配置，不修改用户常用配置、系统代理或系统证书。

安装包与上述两组 Firefox 检查实际安装的 ZIP 逐文件一致。真实 API 检查结束后，含临时测试配置的专用 Firefox profile 已清理；源文件、报告、导出物与包内容的检查未发现用户 Key。
