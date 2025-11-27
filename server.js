/**
 * Shopify App Proxy Server
 * 将 Shopify 店铺的 /apps/a 路径代理到 guya-uniwigs-shop 项目
 * 
 * 流程：
 * 1. 用户访问: https://{shop}.myshopify.com/apps/a
 * 2. Shopify 代理到: https://this-server.com/proxy
 * 3. 此服务器转发到: guya-uniwigs-shop (Nuxt 项目)
 */

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import crypto from 'crypto';

const app = express();
const PORT = process.env.PORT || 3000;

// 配置
const CONFIG = {
  // guya-uniwigs-shop 项目地址
  // 本地开发: http://localhost:3003
  // 生产环境: 你的实际部署地址
  targetDomain: process.env.TARGET_DOMAIN || 'http://localhost:3003',
  shopifyApiSecret: process.env.SHOPIFY_API_SECRET,
  proxyPrefix: process.env.PROXY_PREFIX || 'apps',
  proxySubpath: process.env.PROXY_SUBPATH || 'a',
};

// 中间件
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 请求日志
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

/**
 * 验证 Shopify App Proxy 请求的签名
 */
function verifyShopifyProxySignature(query) {
  if (!CONFIG.shopifyApiSecret) {
    console.warn('警告: SHOPIFY_API_SECRET 未设置，跳过签名验证');
    return true;
  }

  const { signature, ...params } = query;
  
  if (!signature) {
    return false;
  }

  const sortedParams = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('');

  const hash = crypto
    .createHmac('sha256', CONFIG.shopifyApiSecret)
    .update(sortedParams)
    .digest('hex');

  return hash === signature;
}

/**
 * 主要的 App Proxy 路由处理器
 * 将请求代理到 guya-uniwigs-shop (Nuxt 项目)
 */
app.all('/proxy*', async (req, res) => {
  try {
    console.log('\n=== Shopify App Proxy Request ===');
    console.log('请求路径:', req.path);
    console.log('请求方法:', req.method);
    
    // Shopify 添加的参数
    const shopifyParams = {
      shop: req.query.shop,
      path_prefix: req.query.path_prefix,
      timestamp: req.query.timestamp,
      signature: req.query.signature,
      logged_in_customer_id: req.query.logged_in_customer_id,
    };
    
    console.log('Shopify 参数:', shopifyParams);

    // 验证请求签名（生产环境）
    if (process.env.NODE_ENV === 'production') {
      if (!verifyShopifyProxySignature(req.query)) {
        console.error('签名验证失败');
        return res.status(401).json({ error: '无效的请求签名' });
      }
    }

    // 构建目标 URL - 代理到 guya-uniwigs-shop
    // /proxy -> /
    // /proxy/campaigns/test -> /campaigns/test
    // /proxy/_nuxt/xxx -> /_nuxt/xxx
    const proxyPath = req.path.replace(/^\/proxy/, '') || '/';
    const targetUrl = `${CONFIG.targetDomain}${proxyPath}`;
    
    console.log('代理目标 (guya-uniwigs-shop):', targetUrl);

    // 准备转发的请求头
    const targetHost = new URL(CONFIG.targetDomain).host;
    const forwardHeaders = {
      'accept': req.headers.accept || '*/*',
      'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
      'user-agent': req.headers['user-agent'] || 'Mozilla/5.0',
      'x-shopify-shop': shopifyParams.shop || '',
      'x-shopify-customer-id': shopifyParams.logged_in_customer_id || '',
      'x-forwarded-for': req.ip || '',
      'x-forwarded-proto': req.protocol || 'https',
      'x-forwarded-host': req.headers.host || '',
    };

    // 如果是 POST 请求，保留 content-type
    if (req.method !== 'GET' && req.headers['content-type']) {
      forwardHeaders['content-type'] = req.headers['content-type'];
    }

    // 移除 Shopify 特有的查询参数，避免传递给 Nuxt
    const cleanQuery = { ...req.query };
    delete cleanQuery.shop;
    delete cleanQuery.path_prefix;
    delete cleanQuery.timestamp;
    delete cleanQuery.signature;
    delete cleanQuery.logged_in_customer_id;

    // 转发请求到 guya-uniwigs-shop
    const response = await axios({
      method: req.method,
      url: targetUrl,
      params: Object.keys(cleanQuery).length > 0 ? cleanQuery : undefined,
      data: req.body,
      headers: forwardHeaders,
      maxRedirects: 5,
      validateStatus: () => true, // 接受所有状态码
      responseType: 'arraybuffer', // 处理各种类型的响应
      timeout: 30000, // 30秒超时
    });

    console.log('Nuxt 响应状态:', response.status);
    console.log('Nuxt 响应类型:', response.headers['content-type']);

    // 处理响应头
    const responseHeaders = { ...response.headers };
    
    // 删除可能导致问题的头
    delete responseHeaders['content-encoding'];
    delete responseHeaders['transfer-encoding'];
    delete responseHeaders['connection'];

    // 处理 HTML 响应 - 修改资源路径
    let responseData = response.data;
    const contentType = response.headers['content-type'] || '';
    
    if (contentType.includes('text/html')) {
      // 将 Buffer 转为字符串
      let html = responseData.toString('utf-8');
      
      // 修改资源路径，将 /_nuxt/ 改为 /apps/a/_nuxt/
      // 这样静态资源请求也会通过 Shopify 代理
      html = html.replace(/"\/_nuxt\//g, '"/apps/a/_nuxt/');
      html = html.replace(/'\/_nuxt\//g, "'/apps/a/_nuxt/");
      html = html.replace(/href="\//g, 'href="/apps/a/');
      html = html.replace(/src="\//g, 'src="/apps/a/');
      
      // 添加 base 标签（如果没有）
      if (!html.includes('<base')) {
        html = html.replace('<head>', '<head><base href="/apps/a/">');
      }
      
      responseData = html;
    }

    // 设置响应头
    Object.entries(responseHeaders).forEach(([key, value]) => {
      if (value) {
        res.setHeader(key, value);
      }
    });

    res.status(response.status).send(responseData);
    console.log('=== 代理请求完成 ===\n');

  } catch (error) {
    console.error('代理请求错误:', error.message);
    
    // 详细的错误信息
    if (error.code === 'ECONNREFUSED') {
      console.error('❌ 无法连接到 guya-uniwigs-shop，请确保 Nuxt 项目正在运行');
      console.error('   运行: cd guya-uniwigs-shop && npm run dev');
    }
    
    res.status(500).json({
      error: '代理请求失败',
      message: error.message,
      hint: error.code === 'ECONNREFUSED' 
        ? '请确保 guya-uniwigs-shop (Nuxt) 项目正在运行在端口 3003' 
        : null,
    });
  }
});

/**
 * 健康检查端点
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    config: {
      targetDomain: CONFIG.targetDomain,
      proxyPath: `/${CONFIG.proxyPrefix}/${CONFIG.proxySubpath}`,
    },
  });
});

/**
 * 首页 - 显示配置和状态
 */
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>test-sq - Shopify App Proxy</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .container {
          background: white;
          border-radius: 16px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          max-width: 800px;
          width: 100%;
          padding: 40px;
        }
        h1 {
          color: #2d3748;
          font-size: 28px;
          margin-bottom: 10px;
        }
        .status {
          display: inline-block;
          background: #48bb78;
          color: white;
          padding: 4px 12px;
          border-radius: 12px;
          font-size: 14px;
          font-weight: 600;
        }
        .card {
          background: #f7fafc;
          border-radius: 8px;
          padding: 20px;
          margin: 20px 0;
          border-left: 4px solid #667eea;
        }
        .card h2 {
          font-size: 18px;
          margin-bottom: 15px;
          color: #2d3748;
        }
        .config-item {
          display: flex;
          justify-content: space-between;
          padding: 10px 0;
          border-bottom: 1px solid #e2e8f0;
        }
        .config-item:last-child {
          border-bottom: none;
        }
        .config-label {
          color: #718096;
        }
        .config-value {
          font-family: 'Courier New', monospace;
          background: white;
          padding: 4px 10px;
          border-radius: 4px;
          color: #2d3748;
        }
        .flow {
          background: #ebf8ff;
          padding: 20px;
          border-radius: 8px;
          margin: 15px 0;
        }
        .flow-step {
          display: flex;
          align-items: center;
          margin: 8px 0;
          font-size: 14px;
        }
        .arrow {
          color: #4299e1;
          margin: 0 10px;
          font-weight: bold;
        }
        .endpoint {
          background: white;
          padding: 6px 12px;
          border-radius: 4px;
          font-family: monospace;
          flex: 1;
        }
        .warning {
          background: #fef3cd;
          border-left: 4px solid #f6ad55;
          padding: 15px;
          margin: 15px 0;
          border-radius: 4px;
        }
        code {
          background: #edf2f7;
          padding: 2px 6px;
          border-radius: 3px;
          font-family: monospace;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🔗 test-sq - Shopify App Proxy <span class="status">运行中</span></h1>
        
        <div class="card">
          <h2>📋 当前配置</h2>
          <div class="config-item">
            <span class="config-label">代理目标:</span>
            <span class="config-value">${CONFIG.targetDomain}</span>
          </div>
          <div class="config-item">
            <span class="config-label">目标项目:</span>
            <span class="config-value">guya-uniwigs-shop (Nuxt)</span>
          </div>
          <div class="config-item">
            <span class="config-label">Shopify 路径:</span>
            <span class="config-value">/${CONFIG.proxyPrefix}/${CONFIG.proxySubpath}</span>
          </div>
          <div class="config-item">
            <span class="config-label">代理服务器端口:</span>
            <span class="config-value">${PORT}</span>
          </div>
        </div>

        <div class="card">
          <h2>🔄 代理流程</h2>
          <div class="flow">
            <div class="flow-step">
              <span>1️⃣</span>
              <span class="arrow">→</span>
              <div class="endpoint">https://{shop}.myshopify.com/apps/a</div>
            </div>
            <div class="flow-step">
              <span>2️⃣</span>
              <span class="arrow">→</span>
              <div class="endpoint">http://localhost:${PORT}/proxy (此服务器)</div>
            </div>
            <div class="flow-step">
              <span>3️⃣</span>
              <span class="arrow">→</span>
              <div class="endpoint">${CONFIG.targetDomain} (guya-uniwigs-shop)</div>
            </div>
          </div>
        </div>

        <div class="warning">
          <strong>⚠️ 注意：</strong> 
          确保 <code>guya-uniwigs-shop</code> 项目正在运行！
          <br><br>
          <code>cd guya-uniwigs-shop && npm run dev</code>
        </div>

        <div class="card">
          <h2>🧪 测试端点</h2>
          <p><a href="/health">/health</a> - 健康检查</p>
          <p><a href="/proxy">/proxy</a> - 代理测试（需要 Nuxt 运行）</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

// 404 处理
app.use((req, res) => {
  res.status(404).json({
    error: '未找到路由',
    path: req.path,
  });
});

// 错误处理
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({
    error: '服务器内部错误',
    message: err.message,
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║           🚀 Shopify App Proxy Server 已启动              ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
  console.log(`📍 服务器地址: http://localhost:${PORT}`);
  console.log(`🎯 代理端点: http://localhost:${PORT}/proxy`);
  console.log(`🔗 目标域名: ${CONFIG.targetDomain}`);
  console.log(`📦 Shopify 路径: /${CONFIG.proxyPrefix}/${CONFIG.proxySubpath}\n`);
});
