# 🎥 M3U8 流媒体代理 (Cloudflare Worker)

这是一个部署在 **Cloudflare Workers** 上的轻量级 M3U8 流媒体代理服务。它可以智能地处理 M3U8 播放列表及其引用的所有媒体文件（如 TS、KEY、M3U8 子列表），解决跨域、防盗链和路径问题，让您在任何播放器中都能流畅播放。

---

## ✨ 核心功能

### 1. 智能 M3U8 代理 (`/proxy/vod`)
*   **获取并解析**：获取远程 M3U8 文件内容。
*   **地址补全**：自动将 M3U8 文件中的所有相对路径（如 `../001.ts`、`./playlist.m3u8`）补全为完整的 URL。
*   **智能转换**：
    *   如果链接指向的是 **M3U8 文件**，则将其转换为当前 Worker 的 **M3U8 代理地址** (`/proxy/vod?url=...`)。
    *   如果链接指向的是 **媒体文件**（如 `.ts`, `.key`, `.m4s`, `.mp4`），则将其转换为当前 Worker 的 **普通代理地址** (`/proxy?url=...`)。
*   **返回处理后的播放列表**：播放器可以直接使用返回的 M3U8 内容，所有后续请求都会经过 Worker。

### 2. 通用文件代理 (`/proxy`)
*   代理任何 HTTP/HTTPS 请求，用于播放 TS、KEY 等媒体文件。
*   **Header 透传**：尽可能保留原始请求的 Headers 发送给目标服务器，并透传目标服务器返回的 Headers（如 `Content-Type`、`Content-Length`、`Range` 等），以支持断点续传和播放器兼容性。
*   **流式返回**：采用流式传输，内存友好，适合大文件。

---

## 🚀 部署到 Cloudflare Workers

### 直接复制代码

1.  登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2.  进入 **Workers & Pages**，点击 **创建应用程序** > **创建 Worker**。
3.  为您的 Worker 命名（例如 `m3u8-proxy`），然后点击 **部署**。
4.  部署成功后，点击 **编辑代码**。
5.  将项目中的 `_worker.js` 文件内容完全复制，替换在线编辑器中的默认代码。
6.  点击 **保存并部署**。

------

## 🔗 使用示例

假设您的 Worker 部署在 `https://m3u8-proxy.your-subdomain.workers.dev`

### 代理一个 M3U8 流

text

```
https://m3u8-proxy.your-subdomain.workers.dev/proxy/vod?url=https://example.com/path/to/playlist.m3u8
```



### 直接代理单个文件

text

```
https://m3u8-proxy.your-subdomain.workers.dev/proxy?url=https://example.com/path/to/segment-001.ts
```



### 工作原理示例

**原始 M3U8 文件内容：**

m3u8

```
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000
./medium/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000
../high/playlist.m3u8
#EXTINF:10.0,
../segments/001.ts
```



**Worker 处理后返回给播放器的内容：**

m3u8

```
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000
https://m3u8-proxy.your-subdomain.workers.dev/proxy/vod?url=https%3A%2F%2Fexample.com%2Fpath%2Fmedium%2Fplaylist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000
https://m3u8-proxy.your-subdomain.workers.dev/proxy/vod?url=https%3A%2F%2Fexample.com%2Fhigh%2Fplaylist.m3u8
#EXTINF:10.0,
https://m3u8-proxy.your-subdomain.workers.dev/proxy?url=https%3A%2F%2Fexample.com%2Fsegments%2F001.ts
```



------

## 📖 参数说明

| 端点         | 参数  | 说明                                       | 示例                           |
| :----------- | :---- | :----------------------------------------- | :----------------------------- |
| `/proxy/vod` | `url` | **必需**。要代理的 M3U8 播放列表的完整 URL | `?url=https://.../stream.m3u8` |
| `/proxy`     | `url` | **必需**。要代理的单个媒体文件的完整 URL   | `?url=https://.../001.ts`      |

------

## ⚠️ 注意事项

- **免费额度**：Cloudflare Workers 免费计划每天有 10 万次请求，适合个人使用
- **超时限制**：免费用户单个请求的执行时间最长为 10 毫秒（CPU 时间）或 30 秒（总时间）
- **内容合规**：此工具仅用于技术研究和学习，请勿用于侵犯版权或其他非法用途

------

## 📄 开源协议

本项目基于 MIT 协议开源。

