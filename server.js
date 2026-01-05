/**
 * Shopify App Proxy Server - 简化版
 * 
 * 使用 application/liquid 渲染模式
 * Nuxt 端负责返回内容片段，此服务器只做简单转发
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

const CONFIG = {
  targetDomain: process.env.TARGET_DOMAIN || 'http://localhost:3003',
  shopifyApiSecret: process.env.SHOPIFY_API_SECRET,
  proxyPrefix: process.env.PROXY_PREFIX || 'apps',
  proxySubpath: process.env.PROXY_SUBPATH || 'test',
};

// 中间件
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 请求日志
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

/**
 * 验证 Shopify App Proxy 签名
 */
function verifyShopifyProxySignature(query) {
  if (!CONFIG.shopifyApiSecret) {
    console.warn('警告: SHOPIFY_API_SECRET 未设置，跳过签名验证');
    return true;
  }

  const { signature, ...params } = query;
  if (!signature) return false;

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
 * 主代理路由
 * 简单转发请求到 Nuxt，由 Nuxt 决定返回什么内容
 */
app.all('/proxy*', async (req, res) => {
  try {
    console.log('\n=== App Proxy Request ===');
    console.log('Path:', req.path);
    
    const shopifyParams = {
      shop: req.query.shop,
      path_prefix: req.query.path_prefix,
      timestamp: req.query.timestamp,
      signature: req.query.signature,
      logged_in_customer_id: req.query.logged_in_customer_id,
    };

    // 生产环境验证签名
    if (process.env.NODE_ENV === 'production') {
      if (!verifyShopifyProxySignature(req.query)) {
        return res.status(401).json({ error: '无效签名' });
      }
    }

    // 构建目标 URL
    const proxyPath = req.path.replace(/^\/proxy/, '') || '/';
    const targetUrl = `${CONFIG.targetDomain}${proxyPath}`;
    
    console.log('Target:', targetUrl);

    // 清理 Shopify 参数，传递给 Nuxt
    const cleanQuery = { ...req.query };
    delete cleanQuery.signature;
    delete cleanQuery.timestamp;
    // 保留 shop 和 logged_in_customer_id 给 Nuxt 使用

    // 转发请求
    const response = await axios({
      method: req.method,
      url: targetUrl,
      params: Object.keys(cleanQuery).length > 0 ? cleanQuery : undefined,
      data: req.body,
      headers: {
        'accept': req.headers.accept || '*/*',
        'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
        'user-agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'content-type': req.headers['content-type'],
        // 传递 Shopify 信息给 Nuxt
        'x-shopify-shop': shopifyParams.shop || '',
        'x-shopify-customer-id': shopifyParams.logged_in_customer_id || '',
        'x-shopify-proxy-path': `/${CONFIG.proxyPrefix}/${CONFIG.proxySubpath}`,
      },
      maxRedirects: 5,
      validateStatus: () => true,
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    console.log('Response:', response.status, response.headers['content-type']);

    // 直接转发 Nuxt 的响应
    const contentType = response.headers['content-type'] || '';
    
    // 复制响应头
    const skipHeaders = ['content-encoding', 'transfer-encoding', 'connection'];
    Object.entries(response.headers).forEach(([key, value]) => {
      if (value && !skipHeaders.includes(key)) {
        res.setHeader(key, value);
      }
    });

    // 如果 Nuxt 返回的是 HTML，但没有设置 application/liquid
    // 我们帮它设置（这样 Nuxt 不用改任何代码）
    if (contentType.includes('text/html')) {
      res.setHeader('Content-Type', 'application/liquid');
    }

    res.status(response.status).send(response.data);
    console.log('=== Done ===\n');

  } catch (error) {
    console.error('Proxy Error:', error.message);
    
    res.setHeader('Content-Type', 'application/liquid');
    res.status(500).send(`
      <div style="padding: 40px; text-align: center;">
        <h2>⚠️ 服务暂时不可用</h2>
        <p style="color: #718096;">请稍后再试</p>
      </div>
    `);
  }
});

/**
 * 健康检查
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    target: CONFIG.targetDomain,
    proxyPath: `/${CONFIG.proxyPrefix}/${CONFIG.proxySubpath}`,
  });
});

/**
 * Liquid 测试页
 */
app.get('/test-liquid', (req, res) => {
  res.setHeader('Content-Type', 'application/liquid');
  res.send(`
    <div style="padding: 40px; max-width: 800px; margin: 0 auto;">
      <h1>🎉 Liquid 渲染测试</h1>
      <ul>
        <li><strong>店铺:</strong> {{ shop.name }}</li>
        <li><strong>客户:</strong> {{ customer.name | default: '未登录' }}</li>
        <li><strong>购物车:</strong> {{ cart.item_count }} 件</li>
      </ul>
    </div>
  `);
});

/**
 * 首页
 */
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>App Proxy Server</title>
      <style>
        body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; }
        .card { background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0; }
        code { background: #e0e0e0; padding: 2px 6px; border-radius: 4px; }
      </style>
    </head>
    <body>
      <h1>🔗 App Proxy Server</h1>
      <div class="card">
        <p><strong>目标:</strong> ${CONFIG.targetDomain}</p>
        <p><strong>Shopify 路径:</strong> /${CONFIG.proxyPrefix}/${CONFIG.proxySubpath}</p>
      </div>
      <p>
        <a href="/health">/health</a> - 健康检查<br>
        <a href="/test-liquid">/test-liquid</a> - Liquid 测试
      </p>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`\n🚀 App Proxy Server running on http://localhost:${PORT}`);
  console.log(`🎯 Target: ${CONFIG.targetDomain}`);
  console.log(`📦 Path: /${CONFIG.proxyPrefix}/${CONFIG.proxySubpath}\n`);
});
