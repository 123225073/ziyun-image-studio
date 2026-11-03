# 子云影像工坊 · Ziyun Image Studio

Windows 和 macOS 本地图片与视频批量生产工具。工作空间、任务记录和成片保存在电脑上，使用你在应用中配置的模型服务生成内容。

## 下载安装

| 你的电脑 | 下载 |
| --- | --- |
| Windows 64 位 | [Windows 安装包（.exe）](https://github.com/123225073/ziyun-image-studio/releases/download/v0.1.9/ZiyunStudio-Setup-0.1.9.exe) |
| Mac，Apple 芯片（M 系列） | [Mac Apple 芯片安装包（.dmg）](https://github.com/123225073/ziyun-image-studio/releases/download/v0.1.9/ZiyunStudio-0.1.9-mac-arm64.dmg) |
| Mac，Intel 芯片 | [Mac Intel 安装包（.dmg）](https://github.com/123225073/ziyun-image-studio/releases/download/v0.1.9/ZiyunStudio-0.1.9-mac-x64.dmg) |

[统一发布页](https://github.com/123225073/ziyun-image-studio/releases/latest) · [SHA-256 校验文件](https://github.com/123225073/ziyun-image-studio/releases/download/v0.1.9/SHA256SUMS.txt) · [MIT 源码（ZIP）](https://github.com/123225073/ziyun-image-studio/archive/refs/tags/v0.1.9.zip)

## 功能

- **图片素材**支持原图反推、结合项目规范优化提示词、批量生成和失败补位。
- **视频开头**支持文字、首尾帧和参考图片／视频／音频，提供 MiniMax H3 提示词转换与参考素材预览。
- **混剪成片**按 A/B/C/D 组织素材和候选文案，支持导入音频、配音、字幕和时间轴编辑。
- **任务记录**保留生成用时和本地结果。已生成的视频下载失败时，可在原卡片点「重试下载」。

## 安装与使用

1. Windows 双击 EXE，按提示完成安装。Mac 打开 DMG，把应用拖到「应用程序」。可在「关于本机」查看 Mac 芯片类型。Mac 安装包尚未经 Apple 公证。
2. 混剪、字幕和参考视频探测需要单独安装支持 libx264 和 libass 的 FFmpeg。Windows 从 [FFmpeg 下载页](https://ffmpeg.org/download.html#build-windows) 获取构建，把 `ffmpeg.exe` 放到应用安装目录的 `resources\runtime` 下。默认安装目录是 `%LOCALAPPDATA%\Programs\子云影像工坊`。Mac 可用 `brew install ffmpeg-full`，或把可执行的 `ffmpeg` 放到 `~/Library/Application Support/子云影像工坊/runtime/`。
3. 启动应用，在「全局设置 → 模型连接」配置自己的接口地址、模型和 API Key，然后为所需工作流绑定连接。
4. 在图片或视频工作区选择素材、填写要求并提交任务。完成后可预览结果，或导出到指定目录。

图像、视频、语言和配音服务各自决定模型支持范围及收费规则。任务记录保存在本机的应用数据目录，凭据由操作系统加密，换电脑后需要重新配置。使用在线模型时，应用会将当前操作所需的提示词或参考素材发送到所配置的服务。

## 从源码运行

需要 Windows 或 macOS、Node.js 22 或更新版本及 npm。项目使用 Electron、React、Vite 和 SQLite（sql.js）。

1. 如需混剪、参考视频探测或运行媒体测试，Windows 将 `ffmpeg.exe` 放到项目的 `runtime` 目录，Mac 按上面的 FFmpeg 步骤安装。
2. 运行 `npm ci` 安装依赖。
3. 运行 `npm run build`，再运行 `npm start` 启动应用。
4. 运行 `npm test` 检查服务和媒体处理。Windows 用 `npm run package` 打包，Mac 用 `npm run package:mac`。

本机工作空间、凭据、素材、生成结果、依赖目录、构建输出和 FFmpeg 二进制文件均不随源码提交。

## 许可证

应用源码采用 [MIT License](LICENSE)。Electron、FFmpeg 和其他第三方组件分别遵循各自的许可证。FFmpeg 是独立运行的命令行工具，详见 [FFmpeg 许可说明](https://ffmpeg.org/legal.html)。
