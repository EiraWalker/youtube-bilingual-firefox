# YouTube 双语字幕 · Local

Firefox 0.3.0 扩展：取得一个原字幕语言轨道的完整字幕，通过 OpenAI 兼容 Chat Completions API 分段翻译并提前缓冲。每段保存后即可在 YouTube 播放器内显示双语字幕，整轨完成后可导出 SRT。默认目标语言为简体中文，可修改。

项目目录：`E:\plugin\immersive-translate-local`。

GitHub 私有仓库：[EiraWalker/youtube-bilingual-firefox](https://github.com/EiraWalker/youtube-bilingual-firefox)。本地与远端使用 `main` 分支，维护方式见[仓库说明](docs/repository.md)。

## 安装与使用

需要 Firefox 142 或更新版本。开发版采用临时加载方式：

1. 打开 Firefox，进入 `about:debugging#/runtime/this-firefox`。
2. 点击「临时载入附加组件」，选择 `E:\plugin\immersive-translate-local\build\firefox\manifest.json`，或选择 `E:\plugin\immersive-translate-local\dist\youtube-bilingual-firefox-0.3.0.zip`。已加载旧版时重新载入扩展并刷新视频页面。
3. 点击扩展图标 →「API 与已保存字幕」。填写 API 地址、模型名称和 API Key，保存时授予该 API 网站的访问权限。本地免鉴权服务的 Key 可留空。
4. 点击「测试连接」，确认能返回译文。
5. 打开或刷新 YouTube 视频页面，单击播放器里的「双语字幕」按钮。

本次测试地址为 `http://127.0.0.1:8045/v1`，模型为 `gemini-3.8-flash-high`。Key 请在设置页填写，项目文件中不包含个人 Key。

本次分段需求见 [PRD](docs/prd-buffered-subtitle-translation.md)，实现边界见[架构说明](docs/architecture.md)。此前版本记录继续保留：[0.2.3 字幕获取修复](docs/translation-fix-0.2.3.md)、[0.2.0 整轨功能](docs/validation-0.2.md)、[0.2.1 配置页](docs/options-style-0.2.1.md)、[0.2.2 弹出页](docs/popup-style-0.2.2.md)。这些历史文档中的整轨单请求、错误后停止等描述仅适用于当时版本。

右键「双语字幕」按钮可选择原字幕语言、恢复未完成任务、重新翻译已完成任务、取消翻译或导出 SRT。「恢复翻译」只补齐缺失部分；「重新翻译」会重新请求完整轨道。原文 SRT 在源字幕保存后可导出，译文和双语 SRT 必须等待全部条目翻译并保存。双语文件保留原时间轴，原文在上、译文在下。设置支持目标语言、原字幕语言偏好、字体大小、底部距离和自动启用。

翻译期间视频继续播放；当前位置已有译文就显示双语，尚无译文则保留 YouTube 原字幕。每个视频独立使用最多 3 个翻译请求，两个视频可以同时有 6 个请求。跳转会让下一空闲名额优先翻译新位置；之前已发送的请求继续等待并保存结果。

切换视频、关闭标签页或关闭双语显示不会取消后台任务。可在「API 与已保存字幕」页查看已保存 X/Y 条、恢复或取消任务、下载字幕。Firefox 退出后无法继续请求；重启时只恢复保存状态，不自动调用 API。再次开启相应视频字幕或手动点击「恢复翻译」后，只补齐未保存的部分。0.2.3 已完成缓存继续可用。

Firefox 重启后会移除临时加载的扩展，需要重新加载。当前 ZIP 未签名；正式 Firefox 的永久安装需要后续完成 Mozilla 签名。

GitHub 克隆不包含 `build`、`dist`、`node_modules` 或本地测试配置。首次使用可在仓库运行 `npm ci` 和 `npm run package` 生成安装包，也可从 GitHub Actions 的成功运行中下载 `youtube-bilingual-firefox` 工件。

API 地址可填以下任一种：

| 填写地址 | 实际请求地址 |
| --- | --- |
| `https://api.example.com` | `https://api.example.com/v1/chat/completions` |
| `https://api.example.com/v1` | `https://api.example.com/v1/chat/completions` |
| `http://127.0.0.1:8000/v1` | `http://127.0.0.1:8000/v1/chat/completions` |
| `https://api.example.com/custom/chat/completions` | 原地址 |

接口须支持 `model`、`messages` 和 `stream: false`，并在 `choices[0].message.content` 返回模型输出。模型需要遵循 JSON 翻译指令；首版不依赖服务商专有的 JSON Schema 参数。Azure 等需要额外查询参数或专有认证头的接口不在本版适配范围。

## 已实现

- 配置页参考沉浸式翻译官网的白色顶栏、浅蓝渐变、深蓝标题、粉色强调与胶囊按钮；API 设置、字幕显示、任务库分区展示。字号和底部位置支持即时示例预览，窄屏自动转为纵向布局。
- 扩展工具栏弹出页与配置页共用配色、字体和品牌标识，提供简短操作指南与「API 与已保存字幕」入口。
- 借鉴 yt-dlp 的轨道选择与整轨获取逻辑，主动获取一个源轨道的完整字幕；优先复用实际加载的 JSON3 / XML / WebVTT 响应或签名 URL，提供同轨格式备选。页面请求返回空字幕时，使用 Android 客户端刷新同语言、同种类的完整源轨道地址；不切换到其他语言或机器翻译轨道。
- 在播放器内部显示原文和译文，跟随播放时间、暂停、倍速和进度跳转；全屏继续显示，广告期间隐藏。
- 支持人工字幕与 YouTube 自动生成字幕；可选择已有原字幕轨道。
- 翻译任务由后台持有，每视频最多 3 个在途请求，同视频的不同轨道与任务共用该限额；不同视频独立调度。切换视频、轨道和设置不会取消旧任务，也不会让旧结果串入新页面。
- 第一段最多 30 秒/600 字符，随后启动和缓冲不足时使用最多约 60 秒或 1,200 个源字符的片段；缓冲充足时扩大至约 180–300 秒或 6,000 个源字符。按完整字幕条目切分，参考请求耗时与播放倍速提前翻译，继续补齐整轨。
- 每段严格校验全部目标编号，保存后立即公开有效译文；乱序返回按源编号合并。长度错误只拆分失败片段，普通可恢复错误重试原片段。
- 源字幕和成功片段持久保存；重看时复用匹配结果，恢复仅补缺失部分。缓存区分视频、源语言与人工/自动来源、目标语言、接口、模型和源内容。
- 原文、译文、双语 SRT 导出，使用 Firefox 原生下载窗口选择保存位置；译文与双语文件只允许完整任务导出。
- API Key 保存在扩展本地配置中，由扩展后台请求翻译接口。页面桥接层只交换字幕和播放器命令。
- 网络、限流、临时服务、超时和响应校验错误，每片段首次请求后最多自动重试 2 次。退避约 2 秒、8 秒并带少量随机延迟，遵守服务端更长的等待要求。重试等待不占用请求名额，无效凭据等配置错误暂停任务；手动取消不自动重试。
- 错误详情仅记录控制台；页面保留中性的进度、等待重试和未完成状态，不弹窗、不自动展开错误面板。成功片段不因其他片段失败而消失。

未提供原字幕的视频需要语音转写，属于后续范围。首版面向桌面 YouTube 常规视频页面；直播、Shorts、嵌入式播放器、画中画和其他视频站点尚未支持。

启用翻译后，后台会分段向所配置的 API 发送整轨字幕，可能产生费用。默认关闭自动启用。译文保存在当前 Firefox 配置中，个人 API Key 不会写入字幕缓存或导出文件。切换翻译配置会使用对应的缓存；已有完整结果可以在设置页继续导出。

YouTube 字幕获取使用站点内部接口，可能随站点更新失效。纯扩展不会运行本地 yt-dlp，也不能保证取得受限字幕。无法取得完整时间轴时保留原字幕并提供重试入口，原因记录控制台；不使用零散播放器文本代替全片字幕。接口须为每个请求返回本段的完整译文；缺失编号或格式错误不会发布该段。每次翻译请求最多等待 10 分钟；响应体未结束时也会超时并释放名额。完整字幕获取最多等待 30 秒。首批可用译文以 20 秒为优化目标，实际速度取决于字幕获取、API 与模型，不能作为无条件时延保证。

## 查看测试错误

在 Firefox 打开 `about:debugging#/runtime/this-firefox`，找到「YouTube 双语字幕 · Local」，点击「检查」，切换到 Console。后台日志以 `[YouTube bilingual]` 开头，包含视频、片段范围、尝试次数、错误类别、HTTP 状态、耗时和后续动作，不包含 Key 或完整字幕正文。视频页面或配置页自身的消息通信失败，也会在对应页面的开发者工具 Console 中记录操作名称；API 详细诊断以扩展后台 Console 为准。

自动重试耗尽后，可在播放器菜单或字幕库点击「恢复翻译」。若日志指向授权、地址或模型配置，先修正并保存设置；配置身份发生变化时，从视频页面重新开启字幕建立匹配任务。

## 开发与验证

```powershell
cd E:\plugin\immersive-translate-local
npm ci --registry=https://registry.npmjs.org --cache .npm-cache
npm test
npm run package
```

- `npm test`：字幕时间轴与整轨提取、分段和连续缓冲、每视频并发、跳转、重试、片段保存与恢复、模型编号校验、视图隔离、控制台错误策略和 SRT 导出。
- `npm run lint`：Mozilla `web-ext` 扩展校验，警告视为失败。
- `scripts/test-firefox.py`：通过 geckodriver 在独立 Firefox 配置中安装生产构建，使用本地 HTTPS 字幕夹具、合成视频与可控延迟/失败的模拟 API 验证端到端行为。覆盖首段显示、缺译原文播放、跳转优先、每视频 3 并发与两视频 6 并发、自动重试、关闭标签后的后台完成、重启部分恢复和三种 SRT 实际下载。夹具代理和证书仅用于该测试会话，不修改系统或用户 Firefox。

2026-10-10 本轮已完成 90 项自动化测试，以及 Firefox 157.0.1 中 42 项模拟服务集成检查。后者报告位于本地 `output/firefox/buffered-segments/report.json`。两个真实视频完整保存与导出通过，各完成三次冷启动探针。长视频首屏为 20.188–22.734 秒，20 秒目标尚未稳定达到；音乐视频需区分前奏空白与译文就绪。详见 [0.3.0 验证记录](docs/validation-0.3.md) 与脱敏摘要。

Firefox 版本使用 Manifest V2 的持久后台脚本，确保长请求在关闭视频标签页后仍能完成。网站权限按所配置 API 申请，新增 `downloads` 权限用于 SRT 保存。

原生 Firefox 测试额外需要 Python `cryptography` 和 geckodriver。当前本地命令：

```powershell
python -X utf8 scripts/test-firefox.py --report-tag buffered-segments
python -X utf8 scripts/test-firefox.py --live-only --video uwS__WiOYTI --report-tag live-mock
```

`--live` 在夹具测试后尝试真实公开 YouTube 页面；`--live-only` 直接进行公开页面回归，默认仍使用模拟 API。报告分别位于 `output/firefox/<tag>/report.json` 与 `output/firefox-live/<tag>/live-probe.json`，未指定 `--report-tag` 时不增加 `<tag>` 子目录。公开页面检查记录持续播放时的首批可用时间、后台完整保存和三种 SRT 导出，未验证成功时返回失败。回归视频为 `6AgOfiZOWiY`、`uwS__WiOYTI`。

`scripts/test-api.mjs` 可通过 stdin 接收测试配置，验证真实 Chat Completions；`scripts/test-firefox-real.mjs` 把隐藏输入的配置传给独立 Firefox，检查真实 API 与 YouTube 链路，例如 `node scripts/test-firefox-real.mjs uwS__WiOYTI real-music`。密钥不写入命令参数或报告。实际服务测试会产生翻译请求，应与纯模拟验证区分。

## 文档与参考

- [官方功能调查 F01–F33](docs/feature-survey.md)
- [首版范围与后续决策](docs/scope-questions.md)
- [整轨翻译的已对齐需求](docs/whole-track-alignment.md)
- [分段翻译 PRD](docs/prd-buffered-subtitle-translation.md)
- [分段实现任务](docs/issues/buffered-subtitle-translation.md)
- [领域术语](CONTEXT.md)
- [字幕链路的架构决策](docs/decisions/0001-firefox-subtitle-pipeline.md)
- [整轨后台任务的架构决策](docs/decisions/0002-whole-track-background-translation.md)
- [分段字幕翻译的架构决策](docs/decisions/0003-buffered-subtitle-translation.md)
- [文件与调用边界](docs/architecture.md)

[沉浸式翻译官方仓库](https://github.com/immersive-translate/immersive-translate) 与 [官网](https://immersivetranslate.com/zh-Hans/) 是功能参考。当前官方仓库不提供产品源码；本项目为独立实现。
