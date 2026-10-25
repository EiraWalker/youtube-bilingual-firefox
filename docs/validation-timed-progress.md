# 播放器翻译与重试计时提示验证

## 行为

- 只有首批译文尚不可用，或当前位置的字幕条目缺译时显示进度；当前位置已有译文、首批之后的已知字幕空白和后台预取不显示提示。
- 普通在途请求显示 `正在翻译(x)`；实际发出的重试请求显示 `正在重试（x）`。`x` 为本次请求发出以来的整秒数，每次重试重新计时，不包含退避等待。
- 尚在加载任务或等待当前位置的请求名额时显示 `正在准备翻译…`，不伪造远程请求耗时。退避等待不展示运行中的重试计时，也不再展示旧的“等待重试”提示。
- 并发时使用覆盖当前缺译条目的请求，而不是任务总时间、其他片段的重试次数或提示出现的时间；已有请求的提示隐藏后重新出现不会从零开始。
- 原生 CC 在缺译等待期间保留；关闭双语、广告、结束、失败或取消时不展示运行中提示。暂停停止新增请求；若覆盖当前缺译位置的 HTTP 请求已经发出，保留真实在途提示直到返回，没有在途请求时隐藏。导航/轨道重置不复用旧计时。

后台任务公开状态增加 `activeRequests`，每项包含 `ids`、实际发出时间 `startedAt` 和尝试次数 `attempt`。这些信息不依赖译文 `revision` 改变，内容脚本每次接收任务状态都会更新它们。

## 已执行

2026-10-25 最终回归：完整单测 161 项、隔离 Nightly 160.0a1 进度场景 18 项通过。补充暂停/隐藏初始化不虚报准备、暂停后已经发出的请求仍提示等边界；新版多模型和 MT 验证及日常安装状态见 [0.5.0 记录](validation-0.5.md)。下面 107 项/Firefox 158.0.1 是较早一轮的历史结果。

- `npm test`：107 项通过，包含可控时钟下的首次请求、缺译追赶、隐藏后恢复、并发乱序、连续重试重置及视图生命周期回归。
- `npm run build`：通过。
- `npm run lint`：0 errors、0 notices、0 warnings。
- `python -X utf8 scripts/test-firefox.py --progress-only --report-tag timed-progress-confirm`：隔离 Firefox 158.0.1 中 16 项检查通过。

Firefox 验收运行未修改的生产构建，使用本地 YouTube 页面夹具和受控 HTTP 翻译服务。请求被阻塞时观察秒数增长，并将秒数与服务器实际接收请求的时间对照；随后释放响应，验证首次译文隐藏提示、跳到尚未翻译条目恢复提示、跳回可用译文隐藏提示、空白区不误报，以及真实 HTTP 429 后实际重试的计时与成功后的隐藏。截图已人工核对首批、追赶和重试提示。

复核报告：[report.json](../output/firefox/timed-progress-confirm/report.json)。截图：[首次请求](../output/firefox/timed-progress-confirm/progress-startup.png)、[缺译位置](../output/firefox/timed-progress-confirm/progress-catchup.png)、[实际重试](../output/firefox/timed-progress-confirm/progress-retry.png)。这些为忽略目录中的本地验收产物，不随源码发布。

## 验证边界

- 未请求真实收费翻译 API，未声称完成公网 YouTube 页面验收。
- 仅在新建的隔离 Firefox profile 内临时安装测试构建，退出后 profile 已删除；未更新日常 Firefox/Nightly 中的扩展，未刷新用户页面。
- `--progress-only` 不调用缓存组件安装/注册流程，报告确认 `nativeRegistrationTouched=false`。
