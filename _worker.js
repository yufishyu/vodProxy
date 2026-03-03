// 统一入口：兼容 Cloudflare Workers 和 Pages Functions
export default {
  async fetch(request, env, ctx) {
    // Pages Functions 中 KV 需要从 env 中获取
    if (env && env.KV && typeof globalThis.KV === 'undefined') {
      globalThis.KV = env.KV
    }
    
    return handleRequest(request)
  }
}

// 常量配置
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
}

// 需要排除的响应头（这些头不应该透传）
const EXCLUDE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'set-cookie', 'set-cookie2',
  'content-security-policy', 'content-security-policy-report-only'
])

// 超时设置
const TIMEOUT = 30000
const M3U8_FETCH_TIMEOUT = 10000

// 支持的M3U8扩展名
const M3U8_EXTENSIONS = new Set(['.m3u8', '.m3u'])

// ---------- 主逻辑 ----------
async function handleRequest(request) {
  const url = new URL(request.url)
  const pathname = url.pathname

  // 处理OPTIONS请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { 
      status: 204, 
      headers: CORS_HEADERS 
    })
  }

  // 健康检查
  if (pathname === '/health') {
    return new Response('OK', { 
      status: 200, 
      headers: CORS_HEADERS 
    })
  }

  // M3U8代理路由 - 处理M3U8文件
  if (pathname === '/proxy/vod' || pathname.startsWith('/proxy/vod/')) {
    const targetUrl = url.searchParams.get('url')
    if (!targetUrl) {
      return errorResponse('Missing url parameter', 400)
    }
    return handleM3U8Proxy(request, targetUrl)
  }

  // 普通代理路由 - 处理TS、KEY等媒体文件
  if (pathname === '/proxy' || pathname.startsWith('/proxy/')) {
    const targetUrl = url.searchParams.get('url')
    if (!targetUrl) {
      return errorResponse('Missing url parameter', 400)
    }
    return handleSimpleProxy(request, targetUrl)
  }

  // 首页说明
  return handleHomePage(url.origin)
}

// ---------- M3U8代理处理 ----------
async function handleM3U8Proxy(request, targetUrl) {
  try {
    // 验证URL
    if (!isValidUrl(targetUrl)) {
      return errorResponse('Invalid URL format', 400)
    }

    console.log(`Fetching M3U8: ${targetUrl}`)
    
    // 获取M3U8内容
    const m3u8Content = await fetchM3U8Content(targetUrl)
    
    // 获取基础URL（用于补全相对路径）
    const baseUrl = getBaseUrl(targetUrl)
    
    console.log(`Base URL: ${baseUrl}`)
    
    // 处理M3U8内容：补全所有URL并转换为代理地址
    const processedContent = await processM3U8Content(m3u8Content, baseUrl, request.url)

    return new Response(processedContent, {
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS'
      }
    })
  } catch (error) {
    console.error('M3U8 Proxy Error:', error)
    return errorResponse(`M3U8 proxy failed: ${error.message}`, 500)
  }
}

// ---------- 普通代理处理（流式返回 + Header透传）----------
async function handleSimpleProxy(request, targetUrl) {
  // 防止循环代理
  if (isSelfRequest(targetUrl, request.url)) {
    return errorResponse('Proxy loop detected', 400)
  }

  // 验证URL
  if (!isValidUrl(targetUrl)) {
    return errorResponse('Invalid URL format', 400)
  }

  try {
    console.log(`Proxying file: ${targetUrl}`)
    
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT)

    // 构建代理请求 - 透传原始请求的headers
    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: filterRequestHeaders(request.headers), // 透传headers
      body: ['GET', 'HEAD'].includes(request.method) 
        ? undefined 
        : await request.arrayBuffer(),
    })

    const response = await fetch(proxyRequest, { 
      signal: controller.signal,
      redirect: 'follow'
    })
    
    clearTimeout(timeoutId)

    // 构建响应头 - 透传原始响应的headers（排除不需要的）
    const responseHeaders = new Headers()
    
    // 1. 先添加CORS头
    responseHeaders.set('Access-Control-Allow-Origin', '*')
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS')
    responseHeaders.set('Access-Control-Allow-Headers', '*')
    
    // 2. 透传原始响应的headers
    for (const [key, value] of response.headers) {
      const keyLower = key.toLowerCase()
      if (!EXCLUDE_HEADERS.has(keyLower)) {
        // 保留原始header，但如果有多个值，保持原样
        if (responseHeaders.has(key)) {
          responseHeaders.append(key, value)
        } else {
          responseHeaders.set(key, value)
        }
      }
    }

    // 3. 如果没有Content-Type，根据文件扩展名设置
    if (!responseHeaders.has('content-type')) {
      const contentType = getContentType(targetUrl)
      if (contentType) {
        responseHeaders.set('content-type', contentType)
      }
    }

    // 4. 添加缓存控制（可选）
    if (!responseHeaders.has('cache-control')) {
      responseHeaders.set('cache-control', 'public, max-age=3600')
    }

    // 返回流式响应
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    })
  } catch (error) {
    console.error('Proxy Error:', error)
    return errorResponse(`Proxy failed: ${error.message}`, 502)
  }
}

// ---------- M3U8内容处理 ----------
async function processM3U8Content(content, baseUrl, requestUrl) {
  const lines = content.split('\n')
  const processedLines = []

  for (let line of lines) {
    const trimmedLine = line.trim()
    
    // 处理注释行（保留原样）
    if (trimmedLine.startsWith('#')) {
      processedLines.push(line)
      continue
    }
    
    // 处理空行
    if (!trimmedLine) {
      processedLines.push('')
      continue
    }

    // 处理URL行
    if (isUrlLine(trimmedLine)) {
      // 1. 补全为完整URL
      const fullUrl = resolveUrl(baseUrl, trimmedLine)
      console.log(`Resolved URL: ${trimmedLine} -> ${fullUrl}`)
      
      // 2. 判断URL类型并转换为对应的代理地址
      if (isM3U8Url(fullUrl)) {
        // 如果是M3U8文件，使用M3U8代理
        processedLines.push(createM3U8ProxyUrl(requestUrl, fullUrl))
        console.log(`Converted to M3U8 proxy: ${fullUrl}`)
      } else {
        // 如果是TS、KEY等其他文件，使用普通代理
        processedLines.push(createSimpleProxyUrl(requestUrl, fullUrl))
        console.log(`Converted to simple proxy: ${fullUrl}`)
      }
    } else {
      // 其他行（理论上不会执行到这里，但保留原样）
      processedLines.push(line)
    }
  }

  return processedLines.join('\n')
}

// ---------- 获取M3U8内容 ----------
async function fetchM3U8Content(url) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), M3U8_FETCH_TIMEOUT)

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive'
      },
      signal: controller.signal
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    return await response.text()
  } catch (error) {
    clearTimeout(timeoutId)
    throw error
  }
}

// ---------- 工具函数 ----------

// 过滤请求头（透传大部分headers）
function filterRequestHeaders(headers) {
  const filteredHeaders = new Headers()
  
  // 需要排除的请求头（不应该透传的）
  const excludedRequestHeaders = new Set([
    'host', // 自动设置
    'origin', // 可能会引起问题
    'referer', // 可能会引起问题
    'cookie', // 安全考虑
    'cf-connecting-ip',
    'cf-ray',
    'cf-visitor',
    'x-forwarded-for',
    'x-real-ip',
    'accept-encoding', // 让fetch自动处理
    'content-length' // 自动计算
  ])

  // 透传所有其他headers
  for (const [key, value] of headers) {
    const keyLower = key.toLowerCase()
    if (!excludedRequestHeaders.has(keyLower)) {
      // 保留原始header，但如果有多个值，保持原样
      if (filteredHeaders.has(key)) {
        filteredHeaders.append(key, value)
      } else {
        filteredHeaders.set(key, value)
      }
    }
  }

  // 设置必要的请求头（如果没有）
  if (!filteredHeaders.has('User-Agent')) {
    filteredHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')
  }
  
  if (!filteredHeaders.has('Accept')) {
    filteredHeaders.set('Accept', '*/*')
  }

  return filteredHeaders
}

// 验证URL
function isValidUrl(urlString) {
  try {
    new URL(urlString)
    return true
  } catch {
    return false
  }
}

// 检查是否是自请求（防止循环）
function isSelfRequest(targetUrl, requestUrl) {
  try {
    const target = new URL(targetUrl)
    const request = new URL(requestUrl)
    return target.origin === request.origin && 
           (target.pathname.startsWith('/proxy') || target.pathname.startsWith('/proxy/vod'))
  } catch {
    return false
  }
}

// 检查是否是M3U8 URL
function isM3U8Url(url) {
  const urlLower = url.toLowerCase()
  return Array.from(M3U8_EXTENSIONS).some(ext => urlLower.includes(ext))
}

// 检查是否是URL行
function isUrlLine(line) {
  // 跳过明显的非URL行
  if (!line || line.startsWith('<') || line.includes('-->')) {
    return false
  }
  
  // 常见的URL模式
  return (
    line.includes('://') || // 完整URL
    line.startsWith('/') || // 绝对路径
    line.startsWith('./') || // 相对路径
    line.startsWith('../') || // 上级路径
    /^[^#\s]+\.(ts|m3u8|m3u|key|m4s|mp4|png|jpg|jpeg)/i.test(line) // 文件扩展名
  )
}

// 解析完整URL
function resolveUrl(baseUrl, relativePath) {
  try {
    // 如果已经是完整URL，直接返回
    if (relativePath.includes('://')) {
      return relativePath
    }
    
    // 构建完整URL
    const base = new URL(baseUrl)
    
    // 处理相对路径
    if (relativePath.startsWith('/')) {
      // 绝对路径：替换整个路径
      base.pathname = relativePath
    } else if (relativePath.startsWith('./')) {
      // 当前目录相对路径
      const pathParts = base.pathname.split('/')
      pathParts.pop() // 移除最后一个部分（可能是文件名）
      base.pathname = [...pathParts, relativePath.substring(2)].join('/')
    } else if (relativePath.startsWith('../')) {
      // 上级目录相对路径
      let path = relativePath
      const pathParts = base.pathname.split('/')
      
      while (path.startsWith('../') && pathParts.length > 1) {
        pathParts.pop() // 移除最后一部分
        path = path.substring(3) // 移除 '../'
      }
      
      base.pathname = [...pathParts, path].join('/')
    } else {
      // 普通相对路径（相对于当前目录）
      const pathParts = base.pathname.split('/')
      pathParts.pop() // 移除文件名
      base.pathname = [...pathParts, relativePath].join('/')
    }
    
    // 确保路径格式正确
    base.pathname = base.pathname.replace(/\/+/g, '/')
    
    return base.toString()
  } catch (error) {
    console.error('URL resolution error:', error, { baseUrl, relativePath })
    // 如果解析失败，尝试组合
    return baseUrl + (baseUrl.endsWith('/') ? '' : '/') + relativePath
  }
}

// 获取基础URL（用于补全相对路径）
function getBaseUrl(fullUrl) {
  try {
    const url = new URL(fullUrl)
    // 移除最后一个路径部分（文件名）
    const pathParts = url.pathname.split('/')
    if (pathParts.length > 1) {
      pathParts.pop() // 移除文件名
      url.pathname = pathParts.join('/') + '/'
    } else {
      url.pathname = '/'
    }
    return url.toString()
  } catch {
    // 如果解析失败，返回原始URL并确保以/结尾
    return fullUrl.endsWith('/') ? fullUrl : fullUrl + '/'
  }
}

// 创建M3U8代理URL
function createM3U8ProxyUrl(requestUrl, targetUrl) {
  const url = new URL(requestUrl)
  url.pathname = '/proxy/vod'
  url.search = `?url=${encodeURIComponent(targetUrl)}`
  return url.toString()
}

// 创建普通代理URL
function createSimpleProxyUrl(requestUrl, targetUrl) {
  const url = new URL(requestUrl)
  url.pathname = '/proxy'
  url.search = `?url=${encodeURIComponent(targetUrl)}`
  return url.toString()
}

// 根据文件扩展名获取Content-Type
function getContentType(url) {
  const ext = url.split('.').pop()?.toLowerCase().split('?')[0]
  const contentTypes = {
    'ts': 'video/mp2t',
    'm3u8': 'application/vnd.apple.mpegurl',
    'm3u': 'application/vnd.apple.mpegurl',
    'mp4': 'video/mp4',
    'm4s': 'video/iso.segment',
    'key': 'application/octet-stream',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'mpd': 'application/dash+xml',
    'xml': 'application/xml',
    'json': 'application/json',
    'txt': 'text/plain'
  }
  return contentTypes[ext] || 'application/octet-stream'
}

// ---------- 首页处理 ----------
function handleHomePage(origin) {
  const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>M3U8 Proxy</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            line-height: 1.6;
            color: #333;
        }
        h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; }
        h2 { color: #34495e; margin-top: 25px; }
        code {
            background: #f4f4f4;
            padding: 3px 6px;
            border-radius: 4px;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 0.9em;
        }
        pre {
            background: #f8f8f8;
            padding: 15px;
            border-radius: 5px;
            overflow-x: auto;
            border: 1px solid #ddd;
        }
        .endpoint {
            background: #e8f4f8;
            padding: 15px;
            border-radius: 5px;
            margin: 15px 0;
            border-left: 4px solid #3498db;
        }
        .note {
            background: #fff3cd;
            border-left: 4px solid #ffc107;
            padding: 15px;
            border-radius: 5px;
        }
        .feature {
            background: #e8f8f5;
            padding: 15px;
            border-radius: 5px;
            margin: 15px 0;
            border-left: 4px solid #2ecc71;
        }
    </style>
</head>
<body>
    <h1>🎥 M3U8 流媒体代理</h1>
    
    <div class="feature">
        <h3>✨ 特性</h3>
        <ul>
            <li>✅ Header透传 - 保留原始请求和响应的所有Headers</li>
            <li>✅ 流式返回 - 支持大文件流式传输</li>
            <li>✅ 自动补全URL - 处理相对路径和绝对路径</li>
            <li>✅ 智能代理 - M3U8文件用M3U8代理，媒体文件用普通代理</li>
        </ul>
    </div>

    <div class="endpoint">
        <h2>📺 M3U8 代理</h2>
        <code>${origin}/proxy/vod?url=你的M3U8地址</code>
        <p>示例:</p>
        <pre>${origin}/proxy/vod?url=https://example.com/live/stream.m3u8</pre>
        <p>这个端点会:</p>
        <ul>
            <li>获取原始M3U8文件</li>
            <li>将所有URL补全为完整地址</li>
            <li>M3U8文件 → 转换为M3U8代理地址</li>
            <li>TS/KEY等文件 → 转换为普通代理地址</li>
        </ul>
    </div>

    <div class="endpoint">
        <h2>🔗 普通代理 (流式返回 + Header透传)</h2>
        <code>${origin}/proxy?url=文件地址</code>
        <p>示例:</p>
        <pre>${origin}/proxy?url=https://example.com/live/001.ts</pre>
        <p>特点:</p>
        <ul>
            <li>📤 流式返回 - 适合大文件传输</li>
            <li>📋 Header透传 - 保留原始响应的所有Headers</li>
            <li>⚡ 30秒超时保护</li>
        </ul>
    </div>

    <h2>📝 Header透传示例</h2>
    <p>原始请求的Headers会被透传到目标服务器:</p>
    <pre>
User-Agent: MPlayer
Accept: */*
Authorization: Bearer xxx
Range: bytes=0-1023
    </pre>

    <p>目标服务器的响应Headers会被透传回客户端:</p>
    <pre>
Content-Type: video/mp2t
Content-Length: 1234567
Content-Range: bytes 0-1023/1234567
Accept-Ranges: bytes
Server: nginx
    </pre>

    <div class="note">
        <h3>⚡ 性能特点</h3>
        <ul>
            <li>流式传输：内存友好，支持大文件</li>
            <li>Header透传：完整保留服务器信息</li>
            <li>智能超时：30秒超时保护</li>
            <li>支持Range请求：断点续传</li>
        </ul>
    </div>

    <h2>🔍 健康检查</h2>
    <code>${origin}/health</code>
</body>
</html>
  `

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      ...CORS_HEADERS
    }
  })
}

// ---------- 错误响应 ----------
function errorResponse(message, status = 400) {
  return new Response(JSON.stringify({ 
    error: message,
    timestamp: new Date().toISOString()
  }), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      ...CORS_HEADERS
    }
  })
}
