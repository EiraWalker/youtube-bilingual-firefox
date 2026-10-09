# YouTube 双语字幕 · Local

Firefox 0.2.0 扩展：取得一个原字幕语言轨道的完整字幕，通常用一次 OpenAI 兼容 Chat Completions 请求翻译整片，在 YouTube 播放器内显示双语字幕，保存译文并导出 SRT。默认目标语言为简体中文，可修改。

项目目录：`E:\plugin\immersive-translate-local`。

GitHub 私有仓库：[EiraWalker/youtube-bilingual-firefox](https://github.com/EiraWalker/youtube-bilingual-firefox)。本地与远端使用 `main` 分支，维护方式见[仓库说明](docs/repository.md)。

## 安装与使用

需要 Firefox 142 或更新版本。开发版采用临时加载方式：

1. 打开 Firefox，进入 `about:debugging#/runtime/this-firefox`。
2. 点击「临时载入附加组件」，选择 `E:\plugin\immersive-translate-local\build\firefox\manifest.json`，或选择 `dist\youtube-bilingual-firefox-0.2.0.zip`。
3. 点击扩展图标 →「API 与显示设置」。填写 API 地址、模型名称和 API Key，保存时授予该 API 网站的访问权限。本地免鉴权服务的 Key 可留空。
4. 点击「测试连接」，确认能返回译文。
5. 打开或刷新 YouTube 视频页面，单击播放器里的「双语字幕」按钮。

本次测试地址为 `http://127.0.0.1:8045/v1`，模型为 `gemini-3.8-flash-high`。Key 请在设置页填写，项目文件中不包含个人 Key。

当前版本的测试结果与实际网站验证边界见 [0.2.0 验证记录](docs/validation-0.2.md)。

右键「双语字幕」按钮可选择原字幕语言、重试、重新翻译、取消翻译或导出 SRT。导出内容可选原文、译文或双语；双语文件保留原时间轴，原文在上、译文在下。按钮开启后显示勾选状态，文字保持「双语字幕」。设置支持目标语言、原字幕语言偏好、字体大小、底部距离和自动启用。

翻译期间视频继续播放原字幕，播放器显示「正在翻译」。切换视频、关闭标签页或关闭双语显示不会取消已提交的任务；可在「API 与已保存字幕」页查看任务、取消翻译、下载字幕或清除保存的译文。Firefox 仍在运行时任务可以继续；Firefox 退出后未完成的任务需要重试，完整译文会保留并在重启后复用。

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

- 借鉴 yt-dlp 的轨道选择与整轨获取逻辑，主动获取一个源轨道的完整字幕；优先复用实际加载的 JSON3 / XML / WebVTT 响应或签名 URL，提供同轨格式备选。
- 在播放器内部显示原文和译文，跟随播放时间、暂停、倍速和进度跳转；全屏继续显示，广告期间隐藏。
- 支持人工字幕与 YouTube 自动生成字幕；可选择已有原字幕轨道。
- 翻译任务由后台持有，切换视频、轨道和设置不会取消旧任务；页面隔离旧结果，任务继续完成并保存。
- 通常一次 API 请求翻译整轨，保留字幕编号逐条校验完整性；只有接口明确报告上下文过长或输出长度截断时才拆分。普通错误不会自动拆成更多请求。
- 已完成原字幕与译文持久保存；重看相同视频和轨道时复用匹配结果。缓存区分目标语言、接口和模型，原字幕变化也会形成不同记录。
- 原文、译文、双语 SRT 导出，使用 Firefox 原生下载窗口选择保存位置。
- API Key 保存在扩展本地配置中，由扩展后台请求翻译接口。页面桥接层只交换字幕和播放器命令。
- HTTP 错误、限流、超时和模型格式错误有明确提示；错误后停止自动请求，由用户点击重试。

未提供原字幕的视频需要语音转写，属于后续范围。首版面向桌面 YouTube 常规视频页面；直播、Shorts、嵌入式播放器、画中画和其他视频站点尚未支持。

启用翻译才会向所配置的 API 发送完整字幕文本，可能产生费用。默认关闭自动启用。完成的译文保存在当前 Firefox 配置中，个人 API Key 不会写入字幕缓存或导出文件。切换翻译配置会使用对应的缓存；已有结果可以在设置页继续导出。

YouTube 字幕获取使用站点内部接口，可能随站点更新失效。纯扩展不会运行本地 yt-dlp，也不能保证取得受限字幕。无法取得完整时间轴时明确提示重试，不使用零散播放器文本代替全片字幕。接口必须在一次响应中返回完整译文，缺失编号或格式错误不会标记为完成。每次翻译请求最多等待 10 分钟。

## 开发与验证

```powershell
cd E:\plugin\immersive-translate-local
npm ci --registry=https://registry.npmjs.org --cache .npm-cache
npm test
npm run package
```

- `npm test`：字幕时间轴、主动整轨提取、模型编号校验、整轨单请求、长度例外、持久缓存、任务取消与 SRT 导出。
- `npm run lint`：Mozilla `web-ext` 扩展校验，警告视为失败。
- `scripts/test-firefox.py`：通过 geckodriver 在独立 Firefox 配置中安装生产构建，使用本地 HTTPS 字幕夹具、180 秒合成视频与模拟 OpenAI API 验证端到端行为。覆盖全轨单请求、等待原文播放、关闭标签后后台完成、重启后持久结果复用和三种 SRT 实际下载。夹具代理和证书仅用于该测试会话，不修改系统或用户 Firefox。

Firefox 版本使用 Manifest V2 的持久后台脚本，确保长请求在关闭视频标签页后仍能完成。网站权限按所配置 API 申请，新增 `downloads` 权限用于 SRT 保存。

原生 Firefox 测试额外需要 Python `cryptography` 和 geckodriver。当前本地命令：

```powershell
python -X utf8 scripts/test-firefox.py --live
```

`--live` 会在夹具测试后尝试真实公开 YouTube 页面；默认翻译使用模拟 API。结果位于 `output\firefox\report.json`。`--live-only` 的结果位于 `output\firefox-live\live-probe.json`，它会独立记录真实页面字幕是否得到验证。

`scripts/test-api.mjs` 可通过 stdin 接收测试配置，验证真实 Chat Completions；`scripts/test-firefox-real.mjs` 则把隐藏输入的配置传给独立 Firefox，先验证合成视频中的真实整轨翻译，再检查 YouTube。密钥不写入命令参数或报告。

## 文档与参考

- [官方功能调查 F01–F33](docs/feature-survey.md)
- [首版范围与后续决策](docs/scope-questions.md)
- [整轨翻译的已对齐需求](docs/whole-track-alignment.md)
- [领域术语](CONTEXT.md)
- [字幕链路的架构决策](docs/decisions/0001-firefox-subtitle-pipeline.md)
- [整轨后台任务的架构决策](docs/decisions/0002-whole-track-background-translation.md)
- [文件与调用边界](docs/architecture.md)

[沉浸式翻译官方仓库](https://github.com/immersive-translate/immersive-translate) 与 [官网](https://immersivetranslate.com/zh-Hans/) 是功能参考。当前官方仓库不提供产品源码；本项目为独立实现。
