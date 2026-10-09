## Agent skills

### Issue tracker

使用私有仓库 EiraWalker/youtube-bilingual-firefox 的 GitHub Issues。见 docs/project/issue-tracker.md。

### Triage labels

使用默认五类任务分流标签。见 docs/project/triage-labels.md。

### Domain docs

采用单领域文档布局：根目录 CONTEXT.md 与 docs/decisions/。见 docs/project/agent-domain.md。

### Code discovery

优先使用 codebase-memory-mcp 的 search_graph、trace_path、get_code_snippet 和 query_graph；项目索引名为 youtube-bilingual-local。配置、文本或图覆盖不足时可使用 rg。
