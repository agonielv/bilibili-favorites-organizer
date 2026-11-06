# 项目协作约定

- 界面与交互工作使用 `.agents/skills/ui-ux-pro-max/SKILL.md`，沿用现有原生 HTML / CSS / JavaScript。
- 用户已要求：之后每个完成的成品包都直接更新到 GitHub。完成功能和适当验证后，更新版本、更新日志与安装说明，运行 `npm run pack`，将源码及 `packages/` 中的版本化 ZIP、SHA-256 一起提交并推送到本仓库已有远程工作分支。不要只保留本地 `dist/`，不要覆盖远程已有改动，不要提交凭据或浏览器资料。
- 当前 GitHub 仓库为 `agonielv/bilibili-favorites-organizer`，既有远程工作分支为 `codex/chrome-edge-extension-batch-organizer`。推送前检查最新远程状态，后续若仓库或分支发生变化，以实际配置为准。
- GitHub 同步授权不代表授权部署网站、上架扩展商店或操作真实 B 站收藏。接口测试使用模拟数据。

- 用户希望减少逐个试错：交付前运行 `npm test`（含可靠性组合回归）；涉及实际流程或界面时运行对应浏览器检查。发现问题应新增能复现它的回归测试，并更新 `docs/reliability-audit.md`，明确模拟验证与真实服务端限制。
