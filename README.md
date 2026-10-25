# YouTube 双语字幕 · Local

Firefox 0.5.0 扩展，在 YouTube 播放器显示原文与多个 OpenAI 兼容模型的择优译文。翻译只覆盖当前位置与前方有限范围；默认不把字幕保存到磁盘。

仓库：[EiraWalker/youtube-bilingual-firefox](https://github.com/EiraWalker/youtube-bilingual-firefox)。本地与远端使用 `main`。

## 安装与观看

需要 Firefox 142+。本机默认使用 Firefox Nightly 永久安装；已设置 `xpinstall.signatures.required=false` 后，在项目目录执行：

```powershell
npm run install:nightly
```

命令自动构建当前版本 XPI，调用 `E:\AI Tools\Website Dev Tools\firefox-nightly-automation\cli.mjs`，批准本次原生连接确认框，安装并核验版本、启用及非临时状态。Remote Control 使用已有 Nightly；默认允许开启服务时短暂激活目标主窗口及本次连接确认框，无需逐次确认，页面任务仍在后台执行。不启动替代浏览器。可用环境变量 `FIREFOX_NIGHTLY_AUTOMATION_CLI` 指定工具入口。多窗口时以 `npm.cmd run install:nightly -- --hwnd <实际窗口句柄>` 指定目标。

返回 `installation.status=active` 表示永久安装已启用。同 ID 正常更新并保留扩展数据；首次从临时副本迁移可能返回 `restart-required`，表示永久包已写入但临时副本仍占位。请正常重启 Nightly 后再执行上述命令；不要通过卸载临时副本迁移，以免 Firefox 清空设置和字幕存储。工作流不自动重启或刷新视频页。

也可在 `about:addons` 选择“从文件安装附加组件”，打开 `dist/youtube-bilingual-firefox-0.5.0.xpi`。普通 Firefox Release/Beta 要求 Mozilla 签名。只有开发时明确需要临时测试，才在 `about:debugging#/runtime/this-firefox` 加载 `build/firefox/manifest.json`。

扩展设置支持添加多个模型配置，每项独立填写名称、API 地址、模型、API Key、启用开关与优先级；优先级数值越小越优先。本地免认证服务可留空 Key。保存时统一授权所有启用模型的接口网站，“测试连接”检查各启用模型。旧单模型设置自动作为默认模型保留。随后在视频播放器点击“双语字幕”；自动开启默认关闭。

- 预取前方最多 120 个源视频秒，缓冲低于 60 秒时再补充，每视频最多三个在途字幕片段，每片段同时请求所有启用模型；实际接口并发最多 `3 × 启用模型数`，每个启用模型都可能产生费用。
- 最先返回的有效译文立即显示；更高优先级模型晚返回时更新对应条目，同优先级或更低优先级不会把译文换回去。按时间轴反复读取当前最佳结果，向后跳转仍可复用。
- 暂停、隐藏视频标签页、离开、关闭双语字幕、结束或广告期间停止新增请求；已经提交的请求仍可返回并保留译文。
- 跳转优先服务新位置，不回头补译未观看缺口。倍速不扩大硬窗口。
- 译文未就绪时继续播放并保留原字幕；已有译文立即显示。
- 首批请求和播放追上缺译位置时显示 `正在翻译(x)`；实际重试发出后显示 `正在重试（x）`，秒数从本次请求发出时计算。当前位置已有译文时不显示后台预取提示。
- 本次观看的译文在浏览器会话内保留，未主动缓存的内容不保证重启后存在。

右键“双语字幕”可切换原字幕语言、恢复或取消翻译、重新翻译和导出 SRT。恢复和重新翻译同样只服务有效观看窗口。原文可直接导出；完整译文和完整双语导出须等全部源条目有译文。

## 手动缓存到文件夹

播放器“双语字幕”旁的“缓存字幕”保存点击时的字幕快照，支持部分译文，不会启动全片翻译。后续译文不会自动写入文件，需再次点击更新。

自定义目录写入与重启回读需要 Windows 缓存组件及 Python 3.10+。解压 `dist/youtube-bilingual-cache-windows-0.5.0.zip`，在其中执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

源码使用者可执行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\native\install.ps1`。组件按当前用户注册，不需管理员权限。之后在扩展设置中填写缓存文件夹绝对路径并保存。

“打开缓存文件夹”可定位实际目录。每个稳定缓存目录的 `current.json` 指向当前修订，其中有 `subtitles.json`、`original.srt` 和已有译文对应的 `bilingual.partial.srt`；全部完成时双语文件为 `bilingual.srt`。零译文快照只生成原文 SRT。结构文件用于后续自动复用，字幕文件可独立使用。

再次观看时扩展核对视频、源字幕内容、语言、接口和模型等身份后读取文件，只为当前窗口补充缺失译文。更改缓存目录不会移动或删除旧文件；移动文件后可把设置改为新目录。旧版扩展内部字幕仍可读取。缓存组件缺失不影响普通临时双语字幕。

组件的安装位置、自定义 Python 路径及卸载见 [缓存组件说明](native/README.md)。

## 验证与开发

```powershell
npm ci
npm test
npm run package
python -X utf8 scripts/test-firefox.py --report-tag demand-cache-040
```

`npm test` 包括后台服务、字幕获取和解析、播放器及设置 UI、严格编号校验、SRT、真实本地宿主分块传输和临时目录回读。需要 Node 22+ 和 Python 3.10+。

`npm run package` 构建、运行 Mozilla 扩展校验，并生成 Firefox XPI、同内容的开发用 ZIP 与 Windows 缓存组件 ZIP。GitHub Actions 执行测试和打包并收集这些产物。`install:nightly` 安装浏览器扩展；自定义目录缓存组件仍按上面的独立步骤安装。

Firefox 验收额外需要 Python `cryptography`、本机 Firefox 及 `.tools/geckodriver/geckodriver.exe`。测试通过独立 headless Firefox 配置、本地 HTTPS 视频夹具、可控 API 及实际 Native Messaging 验证暂停、离开、默认不落盘、手动缓存和浏览器重启回读；测试临时注册组件并在结束时恢复原注册，不接管用户浏览器。

实际完成结果与边界见 [0.4.0 验证记录](docs/validation-0.4.md)。[0.3.0 记录](docs/validation-0.3.md) 中的整轨后台完成及默认持久保存描述仅适用于旧版本。

## 范围与诊断

只翻译已有人工或自动生成字幕，不进行语音转写。面向桌面 YouTube 常规视频页面；直播、Shorts、嵌入播放器及其他站点不在当前范围。字幕获取依赖 YouTube 内部接口，不能保证受限字幕可取。

启用字幕会按需向用户配置的接口发送字幕文本，可能产生费用。API Key 仅用于后台请求，字幕文件不包含认证信息。临时错误最多额外重试两次；错误详情只进控制台，不弹出页面错误面板。可通过 `about:debugging` 中扩展的“检查”查看后台 Console。

首次译文速度取决于字幕获取与模型响应，20 秒仅为性能目标。请求和响应体最多等待 10 分钟，字幕获取最多等待 30 秒；实际在途请求不会因为暂停而立即退费。

## 设计依据

- [规格与 Issue #7](docs/spec-demand-driven-subtitles-and-explicit-cache.md)
- [领域术语](CONTEXT.md)
- [架构边界](docs/architecture.md)
- [ADR 0004](docs/decisions/0004-demand-driven-subtitles-and-explicit-cache.md)
- [ADR 0005：多模型竞速与优先级升级](docs/decisions/0005-parallel-models-and-priority-upgrades.md)
- [0.5.0 验证记录](docs/validation-0.5.md)
- [历史分段翻译 PRD](docs/prd-buffered-subtitle-translation.md)

本项目为独立实现，功能参考 [沉浸式翻译](https://immersivetranslate.com/zh-Hans/)。
