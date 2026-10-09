# 任务跟踪配置草案

日期：2026-10-10。状态：用户已确认默认标签及 AGENTS.md；配置已落实。本文件保留最初的评审草案，当前规则以 AGENTS.md 和 docs/project/ 为准。

## 已核实的仓库状态

- 已有私有 GitHub 仓库 `EiraWalker/youtube-bilingual-firefox`，使用它作为任务跟踪位置，延续已有仓库维护方向。
- 仓库暂无 issue；已有普通标签及 `wontfix`，尚无 `ready-for-agent` 等任务分流标签。
- 单项目，已有根目录 `CONTEXT.md` 和 `docs/decisions/`；保留现有领域文档位置。
- 根目录没有 `AGENTS.md` 或 `CLAUDE.md`，也没有任务跟踪配置；本地已安装 `triage` skill。

## 待选择

1. 是否保留以下默认任务分流标签（建议保留）？
2. Agent 规则写入新建 `AGENTS.md` 还是 `CLAUDE.md`（建议 `AGENTS.md`）？须用户选择后才写入。

## Agent skills 区块草案

以下区块放入用户选定的规则文件，不替换会话提供的既有要求：

```markdown
## Agent skills

### Issue tracker
使用私有仓库 EiraWalker/youtube-bilingual-firefox 的 GitHub Issues。见 docs/project/issue-tracker.md。

### Triage labels
使用默认五类任务分流标签。见 docs/project/triage-labels.md。

### Domain docs
采用单领域文档布局：根目录 CONTEXT.md 与 docs/decisions/。见 docs/project/agent-domain.md。
```

## docs/project/issue-tracker.md 草案

```markdown
# Issue tracker

- Tracker: GitHub Issues
- Repository: EiraWalker/youtube-bilingual-firefox
- Visibility: private
- Tool: gh CLI，操作时显式指定仓库。
- PRs as a request surface: off

使用真实 issue 编号引用依赖；先创建阻塞项，再创建被阻塞项。多行正文写入临时文件，通过 --body-file 提交，保持原始换行。
遵循当前任务与被调用 skill 的发布确认要求。未获批的拆分保留本地草稿，不作为远程已创建任务。
```

## docs/project/triage-labels.md 草案

```markdown
# Triage labels

| Role | GitHub label |
| --- | --- |
| needs-triage | needs-triage |
| needs-info | needs-info |
| ready-for-agent | ready-for-agent |
| ready-for-human | ready-for-human |
| wontfix | wontfix |

获批且可交给 Agent 独立执行的任务使用 ready-for-agent；标签不代表依赖已经解除。
保留既有标签。若批准采用此映射，只建立缺少的标签，不重命名已有标签。
```

## docs/project/agent-domain.md 草案

```markdown
# Domain docs

采用 single-context。领域术语位于根目录 CONTEXT.md，架构决策位于 docs/decisions/。
涉及领域行为的工作先阅读术语表和相关决策，再查对应 PRD。
沿用现有命名；已解决的术语分歧更新术语表，有长期取舍的架构选择写入连续编号 ADR。
区分拟实施决策与当前代码事实，不为适配模板移动既有文档。
```
