# 0.2.2 工具栏弹出页

2026-10-09，将扩展图标打开的弹出页改为与配置页一致的样式：浅蓝渐变、深蓝标题、粉色标识、白色圆角操作指南与黑色胶囊设置按钮。正常状态下不预留空错误提示区；打开设置失败时显示完整提示。

配色、字体和品牌标识集中在 `extension/theme.css`，配置页与弹出页共同加载；弹出页布局独立在 `extension/popup.css`。原有 `browser.runtime.openOptionsPage()` 与错误处理保持不变。

隔离 Firefox 157.0.1 中安装最终 0.2.2 ZIP，9 项检查通过：344px 布局无横向溢出、主题和按钮样式、Tab 的 3px 焦点框、模拟打开失败时的提示、真实设置页跳转、配置页共享主题与勾选开关焦点、无未捕获扩展脚本错误。测试不请求翻译 API，临时 Firefox 配置已清理。

测试在原生 `moz-extension` 来源的 `popup.html` 页面中运行，截图取页面 body 元素；没有截取 Firefox 工具栏弹出面板的外部边框。Mozilla 打包校验为 0 errors、0 notices、0 warnings。

- [弹出页截图](validation-evidence/0.2.2/popup.png)
- [错误提示截图](validation-evidence/0.2.2/popup-error.png)
- [原生 Firefox 检查报告](validation-evidence/0.2.2/popup-report.json)

安装包：`E:\plugin\immersive-translate-local\dist\youtube-bilingual-firefox-0.2.2.zip`。在 `about:debugging#/runtime/this-firefox` 临时加载该文件；若之前从 `build/firefox/manifest.json` 加载，点击「重新载入」即可更新。
