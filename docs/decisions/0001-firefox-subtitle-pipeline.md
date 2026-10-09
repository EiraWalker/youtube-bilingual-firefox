# ADR 0001：Firefox 字幕链路

日期：2026-10-09。状态：首版采用。

## 背景与选项

用户确认 Firefox、YouTube 播放器内双语字幕与 OpenAI 兼容 API。YouTube 实际字幕请求可能带视频绑定令牌；普通 `captionTracks.baseUrl` 重请求可能为空。官方 Data API 的字幕下载要求对视频有编辑权限，不能直接用于任意公开视频。

只读取字幕 DOM 容易实现，但没有完整时间轴，不能提前翻译。只重请求轨道地址能取得时间轴，但受签名、令牌和站点变化影响。复制播放器实际成功收到的字幕响应，再提供签名请求重放与 DOM 回退，可以复用平台的有效请求，同时保留无法获取完整字幕时的行为。

## 决定

采用响应复制与回退方案。MAIN world 桥接层包装 fetch / XHR，只读取当前视频的 YouTube `/api/timedtext` 请求。它交换字幕、轨道元数据与播放器命令，不交换 API Key。

content script 负责解析时间轴、按播放位置分批翻译与显示。视频、轨道和配置变化创建新会话；进度跳转取消旧请求并以新位置继续。

Firefox 后台负责配置、网站权限、Chat Completions 请求、队列、超时、取消与内存缓存。模型只翻译文本；用原字幕 ID 校验结果，时间戳保留原数据。

## 代价

完整字幕模式可预取；DOM 回退仍有网络和模型延迟。页面与扩展隔离，需要消息交换。YouTube 内部接口仍可能改变。初版不提供无字幕视频的语音转写或正式发布签名。

## 来源

- [Firefox MAIN world](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts)
- [Firefox 后台脚本](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)
- [Firefox 网站匹配与端口限制](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Match_patterns)
- [YouTube captions.download 权限](https://developers.google.com/youtube/v3/docs/captions/download)
- [yt-dlp PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
- [Chat Completions](https://platform.openai.com/docs/api-reference/chat/create)
