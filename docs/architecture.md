# 文件与调用边界

```text
YouTube 请求 → page-bridge (MAIN world，复制实际字幕响应)
             → content (隔离环境，完整字幕与播放器视图)
             → background (权限、独立整轨任务、持久结果、Chat Completions)
             → 用户 API → content → #movie_player 内双语字幕

设置页 → 网站权限 / 扩展本地配置 → background
完整字幕不可读取 → 显示获取失败与重试入口
```

| 文件 | 责任 |
| --- | --- |
| `extension/manifest.json` | Firefox MV2 持久后台、网站与下载权限 |
| `src/content/page-bridge.js` | 原生字幕响应、轨道选择、字幕开关恢复 |
| `src/shared/captions.js` | 字幕解析、时间归一化、轨道选择、翻译窗口 |
| `src/content/main.js` | 控件、完整字幕提交、导航视图隔离、任务状态与双语显示 |
| `src/background/translator.js` | 协议、编号校验、超时、队列与缓存 |
| `src/background/main.js` | 消息来源校验、配置与权限 |
| `src/background/track-tasks.js` | 整轨任务归属、去重、持久保存、缓存恢复与导出 |
| `src/shared/srt.js` | 三种内容的 SRT 序列化与安全文件名 |
| `src/shared/settings.js` | 配置验证、地址归一化、公开配置脱敏 |
| `src/ui/options.js` | 配置保存、权限申请、连接测试 |
| `scripts/build.mjs` | 打包可加载目录 |
| `scripts/test-firefox.py` | 独立 Firefox 原生端到端验证 |

字幕和译文均用 `textContent` 显示。网页不能指定任意 API 请求地址；后台接收 YouTube 内容脚本或扩展设置页消息，请求地址固定为用户保存的配置。

Firefox 0.2.0 使用 Manifest V2 持久后台，以维持视频页面关闭后的翻译请求。任务使用启动时配置，页面通过任务编号查询状态；导航只切换播放器视图，不取消后台任务。完整译文校验与保存成功后才公开为完成，SRT 下载通过后台生成的本地 Blob 与 Firefox downloads API 完成。
