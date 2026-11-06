# 成品包

[下载 v1.3.3](./bilibili-favorites-organizer-1.3.3.zip) · [SHA-256](./bilibili-favorites-organizer-1.3.3.zip.sha256)

下载 ZIP 后解压，在 Chrome / Edge 扩展管理页选择“加载已解压的扩展程序”，选中直接包含 `manifest.json` 的目录。

`npm run pack` 会在本目录保存版本化 ZIP 和 SHA-256；每次成品包随对应源码一起同步到 GitHub。包内仅包含 `extension/` 的运行文件，不包含开发技能、测试或用户凭据。
