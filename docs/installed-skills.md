# 项目级开发技能

安装日期：2026-11-06。位置：`.agents/skills/`，按 Codex 的本地技能目录方式安装；没有改动机器全局配置，也没有将这些仓库注册成客户端插件。

| 来源 | 固定版本 | 新增技能数 | 用途 |
| --- | --- | ---: | --- |
| [obra/superpowers](https://github.com/obra/superpowers) | 7.0.2 · `22f0b463e7a5` | 15 | 规划、调试、TDD、评审、完成前验证 |
| [mattpocock/skills](https://github.com/mattpocock/skills) | 1.3.2 · `4ae2317ddb22` | 27 | 工程实践、需求、实现、评审与协作 |
| [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills) | 1.0.0 · `2c606141936f` | 1 | `karpathy-guidelines`，简洁实现与可验证目标 |
| [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) | 2.5.0 · `9b4bf937a1f6` | 1 | `design-taste-frontend`，前端设计与浏览器检查 |

共新增 **44** 个正式技能，保留原有 7 个技能，共 **51** 个本地技能入口。Matt Pocock 的范围以该版本正式插件清单为准：仅 `engineering` 和 `productivity`，不安装 `in-progress`、`misc`、`deprecated`。

## 识别和使用

- 新开 Codex 会话后重新发现本地技能；项目 `AGENTS.md` 也明确要求先读取 Superpowers 引导文件，防止只有文件而未加载使用。
- 入口目录使用各 `SKILL.md` 的 `name`，例如 `.agents/skills/design-taste-frontend/SKILL.md`，而非仓库名。引用 `superpowers:<name>` 时，在项目级安装中读取 `.agents/skills/<name>/SKILL.md`。
- 保留上游 `agents/openai.yaml`、脚本、参考资料、模板、素材及来源信息；没有修改技能正文。不同工作流按任务选用，不把全部技能同时执行。
- Matt Pocock 标注为仅由用户调用的技能保留原标记。`setup-matt-pocock-skills` 可在需要 Issue / triage / 领域文档工作流时单独调用配置；本次安装没有擅自启用这些外部操作。
- 使用设计技能时遵守当前需求、已有美术风格及原生技术栈。安装不代表授权整站重做或引入框架。

## 校验和维护

完整来源提交、安装路径、文件数与内容 SHA-256 记录在 [来源清单](../.agents/skill-sources.json)，许可与上游说明保存在 `.agents/vendor-licenses/`。新增 44 个技能的 1777 个文件已逐一与固定的上游提交对比，原有技能未覆盖，同名入口检查通过。

Taste Skill 的本地 `start.mjs types --page software` 入口已运行；当前环境 Node 24 与 Chromium 满足其 Node 22+ 和浏览器要求。没有为技能执行系统安装命令或配置 API 密钥。扩展现有 `npm test` 的 108 项检查通过。

这次只安装开发技能，扩展运行源码与 v1.3.4 成品包保持原样。技能和素材不进入扩展安装包。

更新时先检查上游安装方式、正式技能清单和重名情况，再更新文件及来源清单；上游发布新版本不会自动覆盖本项目已固定的副本。
