# Stars Radar 检索与比较指南

## 选择检索范围

- 用户要找自己收藏过的工具：使用 `search_github_stars`，必要时设置 `scope=starred`。
- 用户要浏览社区快照：使用 `get_trending_repos`、`get_top_skills` 或 `get_hellogithub_picks`，检查来源更新时间。
- 用户要发现收藏库之外的项目：使用 `search_github_live`。结果是 GitHub 搜索候选，不是对所有仓库的完整调查。
- 用户要确认某个 API 或配置的实际用法：使用 `search_github_code`，提供仓库或语言约束。
- 用户需要官方文档或技术讨论：使用 `search_web_tech`，必要时指定官方域名。

## 构造查询

先用用户的语言描述用途。结果过宽时补充运行环境、协议、语言或项目形态；词法命中不足时，可以尝试来源 README 中的英文术语。不要把翻译查询当成更准确的保证。

| 需求                               | 可以尝试的查询               |
| ---------------------------------- | ---------------------------- |
| 在 Cloudflare Worker 上提供 WebDAV | `cloudflare worker webdav`   |
| 比较模型推理吞吐量                 | `llm throughput benchmark`   |
| 寻找 Rust 命令行音乐播放器         | `rust terminal music player` |

`min_stars` 只筛选受欢迎程度。探索新项目时可以降低阈值；按明确仓库名寻找时可以设置为 0。Star 数不证明功能完整、质量、许可证适用性或维护状态。

## 从候选到结论

1. 找到少量候选，保留仓库链接、来源与数据日期。
2. 用 `compare_repositories` 对齐用户关心的维度；需要当前元数据时使用 `refresh=true`。
3. 用 `get_repo_readme` 阅读候选的说明，再用代码搜索核实关键实现。代码片段只反映找到的文件，不能代替对完整调用链的分析。
4. 分别说明已确认的事实、未知信息和推断。检索分数不是正确概率，README 中的宣传不是经过验证的结论。
5. 用户授权收藏或收录后才执行写入，检查 `starred_on_github` 与 `staged_in_radar`，报告实际完成的操作。

`search_github_live(persist=true)` 会追加发现日志。这是元数据记录，不等同于用户收藏，不会自动获得个人 Star 或语义向量。需要写入时应先确认用户指令覆盖该操作。

## 接入和故障

客户端需要支持 Streamable HTTP MCP 和 Bearer 请求头。设置格式按客户端文档填写，服务地址使用自己的 `/mcp` 端点。命令行用法见 [cli-recipes.md](cli-recipes.md)，参数细节见 [tool-matrix.md](tool-matrix.md)。

遇到限流、访问挑战或陈旧快照，应说明本次查询的实际限制。空结果只说明当前条件没有匹配项，不能推断项目不存在。密钥、个人备注和原始日志应保留在自己的部署环境中。
