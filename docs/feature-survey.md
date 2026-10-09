# 沉浸式翻译功能调查

调查日期：2026-10-09（Asia/Taipei）。

这是用于选择首版范围的功能目录。所有 F 编号均为本项目的调查编号，不是沉浸式翻译的官方编号；任何条目都尚未纳入首版。

## 调查依据与验证边界

已查阅用户指定的 [GitHub 仓库](https://github.com/immersive-translate/immersive-translate)、[中文官网](https://immersivetranslate.com/zh-Hans/)、[官方文档](https://immersivetranslate.com/zh-Hans/docs/)、具体功能页面和更新日志。本报告记录官方可公开核实的产品能力，没有进行安装后的实际点击、翻译质量或网站兼容性测试。

仓库 README 明确说明当前产品不是开源软件，这个仓库用于版本发布及问题反馈，不包含当前产品源码。因此它提供功能和发布信息参考，不能视为可直接修改的完整源代码工程。[来源](https://github.com/immersive-translate/immersive-translate)

官方更新日志本次可见顶部为 **1.33.3 Release，2026-09-23**。官方说明日志日期是代码合并日期，各应用商店发布时间可能不同，因此不将它等同于所有平台当前已安装版本。[来源](https://immersivetranslate.com/zh-Hans/docs/CHANGELOG/)

沉浸式翻译的产品范围包括浏览器扩展、配套网页工具、移动端产品以及独立应用集成。下面逐项注明边界。

## 网页阅读与交互

| 编号 | 功能 | 官方支持的内容 | 范围或边界 | 主要来源 |
| --- | --- | --- | --- | --- |
| F01 | 网页双语对照 | 按段落在页面中同时展示原文与译文 | 典型核心阅读能力；正文识别不保证覆盖任意网站的全部内容 | [网页翻译](https://immersivetranslate.com/zh-Hans/docs/features/webpage/)、[FAQ](https://immersivetranslate.com/zh-Hans/docs/faq/) |
| F02 | 翻译范围选择 | 默认翻译文章、帖子等主要内容；可切换为翻译全部区域 | 全页模式会尝试导航、侧边栏等文本；浏览器限制访问的页面仍不在范围内 | [FAQ](https://immersivetranslate.com/zh-Hans/docs/faq/) |
| F03 | 显示模式与原文恢复 | 双语、仅译文、显示原文之间切换 | 网页翻译与划词弹窗均存在显示模式控制；不同场景操作入口不同 | [网页翻译](https://immersivetranslate.com/zh-Hans/docs/features/webpage/)、[更新日志](https://immersivetranslate.com/zh-Hans/docs/CHANGELOG/) |
| F04 | 自动翻译规则 | 按网站和语言设置总是翻译或永不翻译；指定网站停用插件 | “不自动翻译”与“在网站停用整个插件”属于不同控制 | [高级选项](https://immersivetranslate.com/zh-Hans/docs/advanced/)、[更新日志](https://immersivetranslate.com/zh-Hans/docs/CHANGELOG/) |
| F05 | 译文样式 | 调整字体、颜色、间距以及下划线、背景、边框等主题；可按站点应用 | 这是译文的阅读呈现；视频字幕另有样式设置 | [高级选项](https://immersivetranslate.com/zh-Hans/docs/advanced/) |
| F06 | 网站适配与动态内容 | 针对主流网站优化阅读范围；支持网站规则及动态内容场景 | 社交信息流、站内跳转、流式消息等需要专门适配；不承诺全网站无差异支持 | [介绍](https://immersivetranslate.com/zh-Hans/docs/)、[高级选项](https://immersivetranslate.com/zh-Hans/docs/advanced/) |
| F07 | 悬停段落翻译 | 鼠标停在段落上，配合设定的快捷键显示或关闭该段译文 | 主要对象为段落；与选中一个词的划词翻译不同 | [快速开始](https://immersivetranslate.com/zh-Hans/docs/usage/) |
| F08 | 划词翻译与发音 | 翻译选中的词、短语、句子；弹窗切换服务、朗读；新版提供多语种发音标注 | 原文和译文可朗读；发音标注可能由 AI 生成，不视为权威词典 | [官方划词介绍](https://immersivetranslate.com/blog/select-and-translate-launch/)、[更新日志](https://immersivetranslate.com/zh-Hans/docs/CHANGELOG/) |
| F09 | 文本翻译与侧边栏 | 输入或粘贴文本进行翻译；扩展侧边栏提供文本翻译，可结合上下文 | 同时存在独立网页文本工具与扩展侧边栏 | [官网](https://immersivetranslate.com/zh-Hans/)、[更新日志](https://immersivetranslate.com/zh-Hans/docs/CHANGELOG/) |
| F10 | 输入框翻译 | 将编辑中的文本转为目标语言，支持快捷键、连续空格、语言前缀及局部文本翻译 | 移动端有手势；官方列出特殊输入框及浏览器限制，不能当作系统级任意应用输入翻译 | [输入框文档](https://immersivetranslate.com/zh-Hans/docs/input/) |
| F11 | AI 写作与智能回复 | 官方日志确认 AI Writing，并记录 GitHub、Gmail 等场景的回复生成 | 与把既有输入内容翻译为另一语言分开计入；本次未核实全部写作菜单及套餐范围 | [更新日志](https://immersivetranslate.com/zh-Hans/docs/CHANGELOG/) |

## 翻译服务与质量控制

| 编号 | 功能 | 官方支持的内容 | 范围或边界 | 主要来源 |
| --- | --- | --- | --- | --- |
| F12 | 多翻译服务与结果比较 | 选择机器翻译或 AI 服务，在翻译操作中切换服务、比较译文 | 包括微软、Google、DeepL、DeepSeek、Claude、Gemini 等；语言、费用和可用性随服务不同 | [服务目录](https://immersivetranslate.com/zh-Hans/docs/services/)、[官方划词介绍](https://immersivetranslate.com/blog/select-and-translate-launch/) |
| F13 | 自定义接口与本地模型 | 自带服务密钥、自定义地址/模型以及连接本地 Ollama | 自定义接口能力不等于获得官方会员服务权限；是否离线取决于选用的服务和具体功能 | [自定义接口](https://immersivetranslate.com/zh-Hans/docs/services/custom/)、[Ollama 接入](https://immersivetranslate.com/zh-Hans/docs/services/ollama/) |
| F14 | AI 上下文、专家与提示词 | 利用标题、语境、术语辅助翻译；选择或自定义领域专家与翻译提示 | 免费 AI 聚合模式暂不支持自定义提示词；不同服务并非都具备全部增强能力 | [Prompt 指南](https://immersivetranslate.com/zh-Hans/docs/prompts/)、[高级选项](https://immersivetranslate.com/zh-Hans/docs/advanced/)、[更新日志](https://immersivetranslate.com/zh-Hans/docs/CHANGELOG/) |
| F15 | 术语库与术语管理 | 定义译法及使用范围；新版支持网页术语高亮、自动提取、手动添加及侧边栏管理 | 免费 AI 聚合模式暂不支持 AI 术语库；普通机器翻译默认不应用术语库 | [高级选项](https://immersivetranslate.com/zh-Hans/docs/advanced/)、[更新日志](https://immersivetranslate.com/zh-Hans/docs/CHANGELOG/) |

## 文档与文件

| 编号 | 功能 | 官方支持的内容 | 范围或边界 | 主要来源 |
| --- | --- | --- | --- | --- |
| F16 | 标准 PDF 翻译 | 在线或本地可识别文本的 PDF 双语阅读、翻译 | 基础 PDF 与扫描件 OCR 分开；本地文件需相应上传/打开流程 | [PDF 文档](https://immersivetranslate.com/zh-Hans/docs/features/pdf/)、[快速开始](https://immersivetranslate.com/zh-Hans/docs/usage/) |
| F17 | 复杂 PDF、扫描件与排版保留 | PDF Pro 提供扫描件 OCR、复杂文档识别并可将多栏重排为单栏；BabelDOC 提供原布局的双语输出，保持公式及版面等内容 | 重排与保留原布局是不同处理方式，可分别选择；涉及配套文档服务及各自权限/额度 | [PDF Pro](https://immersivetranslate.com/document/pdf-pro-translator/)、[BabelDOC](https://immersivetranslate.com/document/babel-doc-translator/) |
| F18 | 电子书阅读与双语 EPUB 导出 | 阅读 EPUB/Mobi 等，生成可下载的双语 EPUB 电子书 | Mobi 阅读不代表可导出双语 Mobi；导出电子书与在网页插入译文是不同交付形态 | [EPUB 文档](https://immersivetranslate.com/zh-Hans/docs/features/epub/) |
| F19 | 文本与结构化文档 | 文档产品列出 TXT、HTML、Markdown、JSON | 不将格式清单视为任意结构和布局都能无损保留；具体导出格式需要后续实际核验 | [文档产品](https://immersivetranslate.com/zh-Hans/document/) |
| F20 | Word 文档 | 文档产品明确列出 DOCX 文件翻译 | 未找到 XLSX/PPTX 直接输入并保留其原格式的同等级证据，不能概括为全部 Office 格式 | [文档产品](https://immersivetranslate.com/zh-Hans/document/) |
| F21 | 字幕文件翻译 | 上传 SRT、ASS 等字幕文件，翻译并导出双语字幕 | 与在线播放器实时字幕的获取和显示分开 | [字幕文件文档](https://immersivetranslate.com/zh-Hans/docs/features/subtitles/)、[快速开始](https://immersivetranslate.com/zh-Hans/docs/usage/) |

## 视频、直播与会议

| 编号 | 功能 | 官方支持的内容 | 范围或边界 | 主要来源 |
| --- | --- | --- | --- | --- |
| F22 | 在线视频已有字幕翻译 | 在适配的视频网站实时呈现双语字幕；设置字幕字体、大小、背景等；有编辑和下载能力 | 包括 YouTube、Netflix、课程网站等；编辑/下载操作依具体入口和平台而定 | [视频产品](https://immersivetranslate.com/zh-Hans/video/)、[支持站点](https://immersivetranslate.com/zh-Hans/docs/videoSiteSupport/) |
| F23 | 无字幕视频生成字幕 | 在支持场景先识别音频生成字幕，再翻译显示 | 通常涉及 AI 服务/会员；网页视频工具明确接受 YouTube 链接和 X 详情页链接，不推断任意视频 URL 都支持 | [视频产品](https://immersivetranslate.com/zh-Hans/video/)、[更新日志](https://immersivetranslate.com/zh-Hans/docs/CHANGELOG/) |
| F24 | YouTube 直播翻译 | 官方提供直播翻译入口，日志也记录 YouTube 直播字幕支持 | 与普通点播视频分开；已有直播字幕翻译与缺少字幕时的语音识别不应混为一个验收条件 | [直播工具](https://livetranslate.immersivetranslate.com/)、[更新日志](https://immersivetranslate.com/zh-Hans/docs/CHANGELOG/) |
| F25 | 在线会议字幕翻译 | Zoom、Google Meet、Microsoft Teams 的网页会议字幕双语显示 | 官方使用说明要求通过浏览器参会并先开启会议平台的字幕；没有将桌面客户端全局音频转写视为扩展能力 | [快速开始：会议翻译](https://immersivetranslate.com/zh-Hans/docs/usage/#在线会议翻译) |

## 图片、圈选与漫画

| 编号 | 功能 | 官方支持的内容 | 范围或边界 | 主要来源 |
| --- | --- | --- | --- | --- |
| F26 | 图片文字翻译与译文覆盖 | 网页图片右键翻译；网页工具上传/粘贴图片；OCR 识别、原图文字区域处理与译文覆盖 | 基础和 Pro 在 OCR/版面效果等方面不同；不将识别准确率或图像修复效果视为保证 | [图片产品](https://immersivetranslate.com/en/image/) |
| F27 | 圈选区域翻译 | 按住 Z 框选图片或暂停视频画面中的区域，识别并翻译其文字 | 面向浏览器页面中的图像区域，与普通选中文本不同；不据此推断可翻译任意桌面应用画面 | [圈选产品](https://immersivetranslate.com/area-translation/) |
| F28 | 漫画翻译 | 对适配漫画网站进行文字/气泡识别与译文回填，多图批量处理及重翻 | 需要站点适配；官方漫画页存在免费试用额度和 Premium 描述的矛盾，具体权益待产品内核实 | [漫画产品](https://immersivetranslate.com/manga)、[图片产品](https://immersivetranslate.com/en/image/) |

## 配置、平台及独立集成

| 编号 | 功能 | 官方支持的内容 | 范围或边界 | 主要来源 |
| --- | --- | --- | --- | --- |
| F29 | 翻译操作入口 | 扩展弹窗、网页悬浮球、右键菜单、快捷键、侧边栏及移动端手势 | 入口可以按偏好设置；各浏览器和脚本形态不一定具备相同原生入口 | [快速开始](https://immersivetranslate.com/zh-Hans/docs/usage/)、[输入框文档](https://immersivetranslate.com/zh-Hans/docs/input/) |
| F30 | 设置、缓存与配置同步 | 管理服务、模型、语言、规则和界面；翻译缓存控制；会员配置多设备同步 | 同步服务与本地设置管理分开；账户、同步冲突等属于配套能力 | [高级选项](https://immersivetranslate.com/zh-Hans/docs/advanced/)、[更新日志](https://immersivetranslate.com/zh-Hans/docs/CHANGELOG/)、[漫画页套餐说明](https://immersivetranslate.com/manga) |
| F31 | 隐私模式与敏感信息脱敏 | 翻译前识别并替换邮箱、手机号等敏感内容，翻译后还原 | Beta 功能，可用内置或自定义 OneAIFW；官方提示存在识别不准或脱敏失败的情况，不等同于离线翻译 | [隐私模式](https://immersivetranslate.com/zh-Hans/docs/features/sensitive/)、[脱敏说明](https://immersivetranslate.com/zh-Hans/docs/sensitive/) |
| F32 | 多浏览器与移动端 | Chrome、Edge、Firefox、Safari 扩展，油猴脚本，iOS/Android 产品与适配的移动浏览器 | 移动产品不是把桌面扩展直接用于所有 App；不同平台和形态需要各自验证 | [安装文档](https://immersivetranslate.com/zh-Hans/docs/installation/)、[FAQ](https://immersivetranslate.com/zh-Hans/docs/faq/) |
| F33 | Zotero 与 Google Docs 集成 | Zotero 独立插件处理论文并把结果附到文献；Google Workspace add-on 在 Docs 中翻译全文或选区、支持双语与术语 | 都是另行安装的独立集成，不能当作普通网页扩展普遍支持所有文档编辑器 | [Zotero](https://immersivetranslate.com/en/zotero-translator/)、[Google Workspace](https://immersivetranslate.com/en/google-workspace/) |

## 官方资料差异与未核实事项

1. **免费图片翻译的浏览器范围**：快速开始页仍写 Chrome/Edge；2026-06-22 的 1.30.3 Release 日志新增 Safari/Firefox 支持。按较新日志记录新增平台，语种及 OCR 质量仍需实际核实。[快速开始](https://immersivetranslate.com/zh-Hans/docs/usage/)、[更新日志](https://immersivetranslate.com/zh-Hans/docs/CHANGELOG/)
2. **漫画的会员范围**：旧文档及当前页面部分文字称会员能力，而漫画页 FAQ 又列出登录免费用户的月度体验额度。因此记录“涉及会员及可能的体验额度”，不标为绝对免费或绝对 Pro 专属。[漫画产品](https://immersivetranslate.com/manga)、[旧漫画文档](https://immersivetranslate.com/zh-Hans/docs/features/manga/)
3. **视频平台数量**：官方介绍、官网首页和视频产品页存在不同计数；“平台支持”也不能推导为每个平台的每段视频均支持无字幕识别。因此本报告采用具体能力及平台举例，不以宣传总数作为验收范围。[介绍](https://immersivetranslate.com/zh-Hans/docs/)、[官网](https://immersivetranslate.com/zh-Hans/)、[视频产品](https://immersivetranslate.com/zh-Hans/video/)
4. **免费扩展与翻译服务费用**：基础使用、官方会员服务、自带 API 密钥及本地模型是不同路线。AI 专家、上下文、术语、自定义提示等能力因路线不同而受限。没有把官方产品定价或额度移植为本项目的成本。[服务目录](https://immersivetranslate.com/zh-Hans/docs/services/)、[高级选项](https://immersivetranslate.com/zh-Hans/docs/advanced/)
5. **未作为功能承诺**：通用桌面截图翻译、任意会议客户端音频翻译、任意无字幕视频网址、所有 Office 文件原格式翻译，以及全网站完美适配，均没有被本次证据建立为普遍能力。
6. **旧入口与当前能力**：日志已记载移除“生成网页快照”入口，本次没有把它列为当前主要功能；AI Writing 的完整交互和会员边界仍需后续实际核验。[更新日志](https://immersivetranslate.com/zh-Hans/docs/CHANGELOG/)

## 对分步实现的含义

下面是基于调查的依赖分析，不是已经选择的首版方案。

- 网页、划词、悬停、输入框等能力可共享翻译服务，但各自的触发、内容获取和结果呈现不同。
- 已有字幕翻译主要处理字幕文本；无字幕视频额外依赖语音转写与时间对齐。
- 标准文本 PDF、扫描件 OCR 和复杂布局输出需要不同的处理能力。
- 图片和漫画除文字翻译外，还涉及识别、图像处理与回填；圈选又增加区域选择交互。
- 跨浏览器、手机、账号同步和独立应用集成会扩展交付与验证范围，应单独选择。

首版功能、目标浏览器以及后续交互与验收讨论见 [设计决策树](scope-questions.md)。
