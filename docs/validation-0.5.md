# 0.5.0 多模型与翻译状态提示验证

日期：2026-10-25。对应 ADR 0005。以下区分自动化夹具、真实接口与日常浏览器安装，不把任何一种结果代替另一种。

状态：代码、三组浏览器回归及日常 Nightly 最终安装均通过。复核发现的完整窗口跳出/重入、取消后恢复、未来请求凭证及候选文本存续边界均已修复，最终启用资源另行逐文件核验。

## 已实现

- 视频首批译文尚不可用时显示正在翻译；当前条目已有可用译文后隐藏，后台预取不会持续显示。播放或跳转超过可用译文时恢复提示，已知字幕空白不误报。
- 秒数以实际 HTTP 发出时间为准；重试实际发出后重新计时，退避阶段不伪造运行时间。暂停不新增 HTTP，但已经发出的当前条目请求仍显示等待，返回后直接显示双语字幕。
- 每视频最多三个在途字幕片段，各片段同时请求所有启用模型。首个有效候选先显示，后续只由更高优先级译文替换，同级和低级不覆盖。时间轴可反复读取、跳回和升级。
- Qwen MT 每次提交一条原文，使用单 user 消息及顶层 translation_options，逐条校验并发布结果。单条长度拒绝直接失败，不重复请求已成功的条目；重试预算按模型/字幕条目记录，主动恢复重置失败预算而不重置已发次数或重发已完成结果。
- 保留 120 秒预取硬范围、60 秒补充阈值、播放/可见性/观看租约和主动缓存快照；普通翻译不自动落盘。

## 自动化结果

- `npm test`：162 项通过，零失败/取消/跳过。
- `npm run build`、`npm run lint`、`npm run package`：通过；Mozilla lint 为 0 errors、0 notices、0 warnings。
- `scripts/test-firefox.py --progress-only --firefox <Nightly> --report-tag progress-050-final`：隔离 Nightly 160.0a1 中 18 项通过。
- `scripts/test-firefox.py --multi-model-only --firefox <Nightly> --report-tag multi-model-050-final`：隔离 Nightly 160.0a1 中 68 项通过。
- `scripts/test-firefox.py --qwen-mt-only --firefox <Nightly> --report-tag qwen-mt-050-final`：隔离 Nightly 160.0a1 中 17 项通过，包含原文协议、逐条发布、暂停/恢复不重发、单条长度失败和跳转后未请求条目的恢复。
- 三个浏览器运行均使用未修改的生产构建、独立 headless profile、本地 YouTube/API 夹具，`nativeRegistrationTouched=false`。没有使用用户浏览器配置，也没有修改系统代理或证书。
- 初次运行发现设置页异步生成模型卡片时，测试器先访问不存在的输入框；已改为可空的就绪检查后重新运行，两组全部通过。此失败属于夹具等待条件，不记为成功验收。
- 截图已核对首次请求、暂停后仍在途、实际重试，以及先到译文和高优先级升级；提示未遮挡字幕，可用译文出现后没有预取提示残留。
- 首轮 GitHub CI 捕获重试计时器早于墙钟资格时间触发后丢失后续唤醒的问题。已用冻结墙钟先观测定时器提前触发的 RED 用例复现，再修复为未到期时重新排定；没有放宽原断言或只延长测试超时。修正后本地 162 项通过，三组浏览器场景全部重跑通过；云端结果以修正提交对应的 Actions run 为准。

本地报告：`output/firefox/progress-050-final/report.json`、`output/firefox/multi-model-050-final/report.json`、`output/firefox/qwen-mt-050-final/report.json`。这些产物由 Git 忽略，不随源码发布。MT 夹具第一次在所有预取槽仍被阻塞时等待新位置请求；修正为正常释放预取、只阻塞当前目标响应后重跑通过，没有为通过测试扩大生产并发或取消已付费请求。

## 真实接口及日常 Nightly 配置

已在现有 Nightly 的独立工作窗口中核对扩展 ID、版本和实际设置页，保留原 Gemini 配置为优先级 1，加入 Qwen MT Flash 为优先级 2。仅为本扩展授予已授权的 `https://dashscope.aliyuncs.com/*`，并通过扩展公开 permissions 接口读回。

模型设置写入前检查并发变更，写入后精确比较配置及新密钥；通过扩展后台 `api:test` 指定 Qwen 模型调用真实百炼接口成功。密钥位于项目外本地秘密目录及浏览器扩展存储，未进入源码、截图或报告。本项是单条真实 API 验证，不代表整段公网 YouTube 业务验收。

## 最终永久安装与独立读回

前期安装曾因原生工具栏不可观测、面板未出现而停在 `status=not-started`、`archiveInstalled=false`，不是安装成功。原进程后来退出，随后新的日常 Nightly 已正常运行；工具没有启动替代浏览器或执行浏览器重启。

按本次安装已有的窗口恢复授权，临时还原最小化的目标窗口，使用正式归档安装流程返回 `ok=true`、`permanent=true`、`archiveInstalled=true`、`status=active`，目标版本 0.5.0、`isActive=true`、`temporarilyInstalled=false`。最终 XPI 的 SHA256 为 `bcbb22b92cc5f05d9dfcea09083d4ae586113254de8f306079cdcd7e552dde3e`。

独立新连接在工具自己的设置页读取 background.js、content.js、options.js、page-bridge.js、player.css、options.css、manifest.json，逐文件 SHA256 全部与最终本地构建匹配；没有仅凭相同版本号认定更新成功。安装清单本身不能证明整个安装归档散列，本次额外核验的是上述活跃资源。

Qwen 接口权限和密钥匹配仍有效，Gemini 优先级 1 与 Qwen 优先级 2 均保留。工作窗口与调试服务已清理，操作锁和归属记录已释放，目标窗口恢复原先的最小化状态。未卸载、清空扩展数据、改变签名偏好或刷新用户视频页；已经打开的旧页面需下次正常导航或用户自行刷新后加载新内容脚本。

本地安装报告：工具 `.local/runs/2026-10-25T08-01-02-346Z-d802eae4-dc4c-465a-bf65-181c196d5508.json`；独立资源核验报告为 `2026-10-25T08-02-42-213Z-cd42916e-2626-4b4b-aa2c-2b8114809655.json`，业务摘要在项目外 `nightly-plugin-options-receipt.json`。这些均为本地忽略产物，不随源码发布。
