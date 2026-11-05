# 子云影像工坊 · Ziyun Image Studio

Windows 和 macOS 本地图片与视频批量生产工具。工作空间、任务记录和成片保存在电脑上，使用你在应用中配置的模型服务生成内容。

## 下载安装

| 你的电脑 | 下载 |
| --- | --- |
| Windows 64 位 | [Windows 安装包（.exe）](https://github.com/123225073/ziyun-image-studio/releases/download/v0.4.1/ZiyunStudio-Setup-0.4.1.exe) |
| Mac，Apple 芯片（M 系列） | [Mac Apple 芯片安装包（.dmg）](https://github.com/123225073/ziyun-image-studio/releases/download/v0.4.1/ZiyunStudio-0.4.1-mac-arm64.dmg) |
| Mac，Intel 芯片 | [Mac Intel 安装包（.dmg）](https://github.com/123225073/ziyun-image-studio/releases/download/v0.4.1/ZiyunStudio-0.4.1-mac-x64.dmg) |

[统一发布页](https://github.com/123225073/ziyun-image-studio/releases/latest) · [SHA-256 校验文件](https://github.com/123225073/ziyun-image-studio/releases/download/v0.4.1/SHA256SUMS.txt) · [MIT 源码（ZIP）](https://github.com/123225073/ziyun-image-studio/archive/refs/tags/v0.4.1.zip)

## 功能

- **图片素材**支持原图反推、结合项目规范优化提示词、批量生成和失败补位。
- **视频开头**支持文字、首尾帧和参考图片／视频／音频，提供 MiniMax H3 提示词转换与参考素材预览。
- **混剪成片**逐行配置可增减的段落、候选文案和素材文件夹，按实际数量动态组合，先生成完整配音，再匹配画面并进入四轨时间线。
- **任务记录**保留生成用时和本地结果。已生成的视频下载失败时，可在原卡片点「重试下载」。
- **语音合成（0.2.0）**支持豆包与 MiniMax 独立连接、配音预设、批量文案、试听和音频导出。已生成配音可以直接用于混剪，重复画面版本复用同一音频。
- **批量混剪（0.2.0）**支持分类目录导入、时间窗缩略图、可选视觉识别与语义选片、镜头替换和锁定，以及固定片头原声保留。新版本安装包的验证与发布状态以对应 Release 为准。
- **模型服务设置（0.2.1）**按文字与识图、图片生成、视频生成、语音合成分页管理。选择平台后自动填写接入方式，提供获取密钥、开通、音色和用量入口；MiniMax 国内与国际账号分别配置。已有连接、密钥和默认服务自动保留。

## 0.4.1 更新

- 图片任务支持整行拖动，自定义编号（如 A01、B01）保持不变；可直接改编号，按分类、名称、勾选范围筛选，并切换编号正序、倒序或手动顺序。未筛选时显示全部。
- 参考来源区域可拖入一张、多张图片或图片文件夹。只替换参考来源，其他参数保持，保存本行后生效。
- 混剪段落与数量不写死；任意启用段落按候选数量相乘。组合预览分页，完成一条就保存一条草稿。相同完整文案和声音设置复用配音。
- 时间线可拖动、添加、删除、分割及调整音频入点和时长；支持导出 MP4，或选择剪映草稿根目录，导出含独立素材的可编辑草稿。

- 新增编号自动继承分类，图片任务与混剪段落支持批量删除。
- Excel 批量导入支持图片或文件夹路径、默认参数、手工提示词优先和显式 X 自动反推。
- 母图文件夹可整组导入，生成图回存每个类型目录的“子图”文件夹；Excel 的“导出位置”可填“原目录子图”，留空继续使用系统输出目录。
- 独立候选文案框保留段内换行，提供分隔预览；组合后可以 AI 校对，批量重新搭配或轻度改写，检查采纳后用于配音。

详细用法见 [0.4.1 操作说明](docs/0.4.1-批量导入与文案校对.md)。

## 安装与使用

1. Windows 双击 EXE，按提示完成安装。Mac 打开 DMG，把应用拖到「应用程序」。可在「关于本机」查看 Mac 芯片类型。Mac 安装包尚未经 Apple 公证。
2. 混剪、字幕和参考视频探测需要单独安装支持 libx264 和 libass 的 FFmpeg。Windows 从 [FFmpeg 下载页](https://ffmpeg.org/download.html#build-windows) 获取构建，把 `ffmpeg.exe` 放到 `%APPDATA%\子云影像工坊\runtime\` 下；也支持安装目录的 `resources\runtime` 和 `ZIYUN_FFMPEG_PATH` 环境变量。Mac 可用 `brew install ffmpeg-full`，或把可执行的 `ffmpeg` 放到 `~/Library/Application Support/子云影像工坊/runtime/`。
3. 启动应用，在「全局设置 → 模型服务」选择用途页签，添加服务、选择平台，点击弹窗内的入口获取 API Key，粘贴密钥并选择模型。可勾选保存后用于当前功能；已有服务在同一页签切换。自定义服务填写平台提供的地址，名称、等待时间等在高级设置中调整。
4. 在图片或视频工作区选择素材、填写要求并提交任务。完成后可预览结果，或导出到指定目录。

图像、视频、语言和配音服务各自决定模型支持范围及收费规则。任务记录保存在本机的应用数据目录，凭据由操作系统加密，换电脑后需要重新配置。使用在线模型时，应用会将当前操作所需的提示词或参考素材发送到所配置的服务。

语音服务在「全局设置 → 模型服务 → 语音合成」选择豆包或 MiniMax 平台，填写自己的密钥与模型。豆包资源 ID 须与音色权限匹配；豆包语音密钥不能用方舟大模型的密钥替代。MiniMax 国内和国际站密钥不能混用。在「配音预设」保存声音、语速等参数后，可从「语音合成」生成配音。混剪识别在「文字与识图」页签选择「混剪素材识别」服务，未配置时可手工维护镜头描述和选择素材。AI 识别和合成会按所选服务规则计费。

素材索引采用时间窗抽帧，画面匹配需要在导出前检查。人物口型同步和创建克隆音色仍需使用相应服务另行完成，已取得的音色 ID 和已同步片头可直接导入使用。

## 从源码运行

需要 Windows 或 macOS、Node.js 22 或更新版本及 npm。项目使用 Electron、React、Vite 和 SQLite（sql.js）。

1. 如需混剪、参考视频探测或运行媒体测试，Windows 将 `ffmpeg.exe` 放到项目的 `runtime` 目录，Mac 按上面的 FFmpeg 步骤安装。
2. 运行 `npm ci` 安装依赖。
3. 运行 `npm run build`，再运行 `npm start` 启动应用。
4. 运行 `npm test` 检查服务和媒体处理。Windows 用 `npm run package` 打包，Mac 用 `npm run package:mac`。

本机工作空间、凭据、素材、生成结果、依赖目录、构建输出和 FFmpeg 二进制文件均不随源码提交。

## 许可证

应用源码采用 [MIT License](LICENSE)。Electron、FFmpeg 和其他第三方组件分别遵循各自的许可证。FFmpeg 是独立运行的命令行工具，详见 [FFmpeg 许可说明](https://ffmpeg.org/legal.html)。
