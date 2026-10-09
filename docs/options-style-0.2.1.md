# 0.2.1 配置页样式与验证

2026-10-09，配置页参考[沉浸式翻译官网](https://immersivetranslate.com/zh-Hans/)的当前视觉样式：白色顶栏、淡蓝渐变、深蓝标题、粉色强调、黑色胶囊按钮、白色圆角卡片与轻阴影。使用独立的本地 HTML/CSS，不加载官网字体、图片、脚本或样式资源。

桌面按「翻译服务」「字幕显示」两栏布局，窄屏改为纵向排列。字幕字号与底部距离即时更新示例预览；预览随容器缩放，使用示例文字，不调用翻译 API。字幕库显示记录数量与任务状态，保留取消、清除及三种 SRT 导出。

样式在 `extension/options.css` 中，仅由配置页加载。原有设置字段、访问权限申请、持久保存、API 测试与后台消息协议保持兼容。`package.json`、锁文件与扩展清单同步到 0.2.1。

## 原生 Firefox 验证

- `npm test`：55/55 通过。
- `npm run package`：构建成功，Mozilla 校验 0 errors、0 notices、0 warnings。
- 隔离 Firefox 157.0.1 中加载生产包，配置页 23 项检查通过，包括保存后刷新、预览联动与恢复、mock API 成功/失败反馈、真实后台任务显示/取消/清除、导出内容选择保持与实际原生 SRT 下载、键盘焦点、无未捕获脚本错误。
- 1280px 原生窗口、390px 同源 iframe 的扩展页面均无横向溢出。Firefox headless 窗口最小宽度为 500px，因此用 iframe 获得真实 390 CSS px 的页面视口与 ResizeObserver 事件，未将 500px 窗口当作 390px 结果。
- 测试仅使用本地 mock API。SRT 检查为避免 headless 的系统保存对话框，只在隔离测试页给下载消息增加 `saveAs: false`；后台、Blob 与 Firefox downloads API 均真实执行。
- 已核对交付 ZIP 与原生 Firefox 测试 ZIP 的每个文件一致。个人 API Key 与用户主 Firefox 配置不参与本次验证。

可随 GitHub 查看[检查报告](validation-evidence/0.2.1/options-report.json)、[桌面配置页](validation-evidence/0.2.1/options-desktop.png)、[390px 配置页](validation-evidence/0.2.1/options-narrow.png)与[字幕任务库](validation-evidence/0.2.1/options-library.png)。

本地安装包：`E:\plugin\immersive-translate-local\dist\youtube-bilingual-firefox-0.2.1.zip`。在 Firefox 的 `about:debugging#/runtime/this-firefox` 重新加载即可；现有临时扩展可使用「重新载入」加载 `build/firefox` 的当前版本。

本次为配置页改版，真实 YouTube 字幕接口的验证边界沿用 [0.2.0 记录](validation-0.2.md)。
