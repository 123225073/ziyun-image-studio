# 子云影像工坊 · Ziyun Image Studio

Windows 本地图片与视频批量生产工具。工作空间、任务记录和成片保存在电脑上，使用你在应用中配置的模型服务生成内容。

## 功能

- **图片素材**支持原图反推、结合项目规范优化提示词、批量生成和失败补位。
- **视频开头**支持文字、首尾帧和参考图片／视频／音频，提供 MiniMax H3 提示词转换与参考素材预览。
- **混剪成片**按 A/B/C/D 组织素材和候选文案，支持导入音频、配音、字幕和时间轴编辑。
- **任务记录**保留生成用时和本地结果。已生成的视频下载失败时，可在原卡片点「重试下载」。

## Windows 安装与使用

1. 从 [GitHub Releases](https://github.com/123225073/ziyun-image-studio/releases) 下载 Windows x64 安装包。可使用附带的 SHA-256 文件核对安装包。
2. 需要本地视频处理时，从 [FFmpeg 下载页](https://ffmpeg.org/download.html#build-windows) 获取支持 H.264（libx264）和字幕（libass）的 Windows 构建，将其中的 `ffmpeg.exe` 放到应用安装目录下的 `resources\runtime\ffmpeg.exe`。默认安装目录为 `%LOCALAPPDATA%\Programs\子云影像工坊`。GitHub 安装包由用户单独准备 FFmpeg。
3. 启动应用，在「全局设置 → 模型连接」配置自己的接口地址、模型和 API Key，然后为所需工作流绑定连接。
4. 在图片或视频工作区选择素材、填写要求并提交任务。完成后可预览结果，或导出到指定目录。

图像、视频、语言和配音服务各自决定模型支持范围及收费规则。保存连接和测试模型列表之后，可按需使用生成服务。任务记录位于 `%APPDATA%\子云影像工坊\studio.sqlite`，凭据由 Windows 加密保存在该目录。使用在线模型时，应用会将当前操作所需的提示词或参考素材发送到所配置的服务。

## 从源码运行

需要 Windows 10 或更新版本（x64）、Node.js 22 或更新版本及 npm。项目使用 Electron、React、Vite 和 SQLite（sql.js）。

1. 将支持相应编码器和滤镜的 `ffmpeg.exe` 放到项目的 `runtime` 目录，用于混剪、参考视频探测和媒体测试。
2. 运行 `npm ci` 安装依赖。
3. 运行 `npm run build`，再运行 `npm start` 启动应用。
4. 运行 `npm test` 检查服务和媒体处理。运行 `npm run package` 构建本地 Windows 安装包。

本机工作空间、凭据、素材、生成结果、依赖目录、构建输出和 FFmpeg 二进制文件均不随源码提交。

## 许可证

应用源码采用 [MIT License](LICENSE)。Electron、FFmpeg 和其他第三方组件分别遵循各自的许可证。FFmpeg 是独立运行的命令行工具，详见 [FFmpeg 许可说明](https://ffmpeg.org/legal.html)。
