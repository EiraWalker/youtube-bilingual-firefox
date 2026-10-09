# Git 与 GitHub 仓库

本地仓库：`E:\plugin\immersive-translate-local`。

远端：私有的 [EiraWalker/youtube-bilingual-firefox](https://github.com/EiraWalker/youtube-bilingual-firefox)，`origin` 为 `https://github.com/EiraWalker/youtube-bilingual-firefox.git`，主分支为 `main`。

## 版本与维护

当前版本为 0.2.3：保留单轨完整字幕获取、通常单次 API 翻译、后台任务、持久译文和三种 SRT 导出；配置页提供字幕效果预览，工具栏弹出页与配置页使用一致的视觉样式。修改按实际范围提交，不将工作区无关文件加入提交；正常推送使用 `git push origin main`，不覆盖远端历史。

`.gitignore` 排除了依赖、构建目录、安装包、原始测试输出、临时 Firefox 配置、工具缓存、`.env` 和本地配置。API Key 只通过扩展设置输入，不加入源码、测试配置或文档。`docs/validation-evidence/0.2.0` 仅保存经过检查的报告快照、夹具截图与字幕示例，方便在 GitHub 查看验证结果。

版本变更应同步更新 `package.json`、`package-lock.json` 和 `extension/manifest.json`。提交前运行相关检查，必要时更新验证记录；实际 YouTube 字幕可用性与本地夹具验证分别记录。

## 自动检查与安装包

[GitHub Actions](https://github.com/EiraWalker/youtube-bilingual-firefox/actions) 在 `main` 推送、向 `main` 的 PR 和手动触发时运行 Node 22 的 `npm ci`、`npm test`、`npm run package`。打包步骤包含 Mozilla 扩展校验；成功后上传 `youtube-bilingual-firefox` 工件，保留 14 天。

在成功的运行页下载工件、解压外层 ZIP，得到 `youtube-bilingual-firefox-0.2.3.zip`，再在 Firefox 的 `about:debugging#/runtime/this-firefox` 临时加载。工件仍未签名，重启 Firefox 后需重新加载。

Windows 原生 Firefox 集成测试依赖 Firefox、geckodriver 与 Python `cryptography`，不在这个 Node CI 中运行。真实 API 验证只在已授权的本地环境执行，密钥通过隐藏 stdin 传入，不写入 Actions secrets 或仓库。具体安装与本地命令见 [README](../README.md)。
