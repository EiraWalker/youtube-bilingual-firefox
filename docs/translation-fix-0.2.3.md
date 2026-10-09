# 0.2.3 完整字幕与翻译队列修复

日期：2026-10-10。修复前按用户要求执行 `git add -A` 并创建完整检查点 `5d4d6dcf0036a7eaea87003e7a1e66af0989c45b`；当时工作区已干净，所以检查点没有新增文件差异。忽略的依赖、临时浏览器配置和本地密钥不进入仓库。

## 已复现的问题与修复

两个公开视频 `6AgOfiZOWiY` 和 `uwS__WiOYTI` 的页面元数据均列出字幕，但 WEB 客户端的 timedtext 请求返回 HTTP 200、空响应体。在没有安装扩展的独立 Firefox 中也重现该现象。仅更改字幕格式或携带页面 cookies 无法取得全文。

参考 [yt-dlp YouTube 客户端定义](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_base.py) 和 [PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)，增加 Android 客户端作为完整轨道获取的备用路径。原生捕获和 WEB 整轨请求仍优先使用；失败后重新获取当前视频的字幕元数据，严格匹配所选语言及人工/自动生成种类，原样请求新的签名 URL。真实返回格式为带完整时间轴的 XML，复用 Firefox DOMParser 解析。整个提取过程在 30 秒内结束，切换轨道、导航或关闭双语显示会中止旧请求，晚到的结果不会进入新视频。

独立回归用一个永不结束、且不响应 AbortSignal 的 API 响应体复现队列阻塞：旧版本的首任务一直为 translating，后续任务一直为 queued。修复后请求、错误响应体和成功响应体均与超时/取消信号竞争；到达截止时间或取消后任务释放队列，下一任务可以完成。每次翻译仍最多等待 10 分钟；整个轨道通常只调用一次翻译 API，只有明确的长度限制才允许拆分。

模型输出兼容规范的整数编号：例如源编号 `"12"` 可对应 JSON 数字 `12`，且保存时仍使用源字符串编号。只有安全整数且转换后与源编号精确匹配才接受；不会猜测行序、补编号或合并不同译文。重复、未知编号、漏译和无效文本仍拒绝。将这些错误分别报告，避免所有失败都误报成同一类编号错误。

## 验证

| 检查 | 结果 |
| --- | --- |
| 单元与回归测试 | 61 / 61 通过，包括空 WEB 字幕的备用客户端、语言/种类/视频校验、导航、响应体超时、队列释放及规范整数编号 |
| Mozilla 扩展校验 | 0 errors、0 warnings、0 notices |
| 原生 Firefox 157.0.1 生产构建集成 | 45 / 45 通过，涵盖关闭标签后的后台完成、重启缓存与三种 SRT 实际下载 |
| `6AgOfiZOWiY` 真实 YouTube 页面 + 模拟翻译 API | 993 / 993 条完成并保存，单次翻译请求，原文/译文/双语 SRT 均导出 993 条 |
| `uwS__WiOYTI` 真实 YouTube 页面 + 模拟翻译 API | 英文轨道 26 / 26 条完成并保存，单次翻译请求，三种 SRT 均导出 26 条 |
| `uwS__WiOYTI` 真实 YouTube 页面 + 用户提供的真实 API | 26 / 26 条完成并保存，播放器显示中文译文，三种 SRT 均导出 26 条 |
| `6AgOfiZOWiY` 真实 YouTube 页面 + 用户提供的真实 API | 993 / 993 条完成并保存，播放器显示中文译文，三种 SRT 均导出 993 条 |

报告：[Firefox 集成](validation-evidence/0.2.3/firefox-report.json)、[993 条公开视频](validation-evidence/0.2.3/live-6AgOfiZOWiY-mock.json)、[26 条公开视频](validation-evidence/0.2.3/live-uwS__WiOYTI-mock.json)。模拟 API 的测试译文只用于验证字幕链路和完整性，不代表真实模型的翻译质量。

真实 API 使用用户指定的本地接口与 `gemini-3.8-flash-high`，结果见[长视频报告](validation-evidence/0.2.3/live-6AgOfiZOWiY-real.json)、[音乐视频报告](validation-evidence/0.2.3/live-uwS__WiOYTI-real.json)，以及[长视频截图](validation-evidence/0.2.3/live-6AgOfiZOWiY-real.png)、[音乐视频截图](validation-evidence/0.2.3/live-uwS__WiOYTI-real.png)。993 条字幕此次整轨处理约需 8 分钟，期间显示“正在翻译”，可手动取消；这不是持续排队。

验收在翻译完成后重新定位播放器时间，避免 YouTube 初始化或广告重置先前的跳转。较早的长等待测试中 YouTube 播放器自身报错；早期长视频译文也曾被严格编号校验拒绝。这些失败均不计入通过结果，数字编号兼容后的最终长视频复测已通过完整保存、显示与 SRT 校验。

`--live-only` 检查在公开页面字幕、完整保存或 SRT 校验失败时返回非零退出码。新增 `--report-tag` 分开保存每次证据，真实 API 包装脚本接受视频 ID，密钥继续经隐藏 stdin 传入，临时 Firefox 配置退出后清理。

## 更新

安装包：`E:\plugin\immersive-translate-local\dist\youtube-bilingual-firefox-0.2.3.zip`，36,702 字节。

SHA256：`9e86cd89e6dd0fcb34f0b2aaf085608e9a3f28459e1fa162d063a9f85dcd42be`。

在 `about:debugging#/runtime/this-firefox` 重新载入本地 `build/firefox/manifest.json`，或移除旧临时扩展后载入 0.2.3 ZIP；随后刷新视频页面。重载后台会将历史未完成任务标记为中断，完整译文继续保留。对失败视频点击“重试”。无需清除已完成缓存或重新填写 API 配置。

本次两个视频已验证能取到完整轨道。该备用客户端同样是 YouTube 内部接口，其他受限视频及以后站点变更仍需单独验证。
