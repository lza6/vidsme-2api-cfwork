// =================================================================================
//  项目: vidsme-2api (Cloudflare Worker 单文件版)
//  版本: 2.0.3 (代号: Chimera Synthesis - Robustness)
//  作者: 首席AI执行官 (Principal AI Executive Officer)
//  协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
//  日期: 2025-11-21
//
//  描述:
//  本文件是一个完全自包含、可一键部署的 Cloudflare Worker。它将 chatsweetie.ai (vidsme)
//  的图像生成服务，无损地转换为一个高性能、兼容 OpenAI 标准的 API。
//
//  v2.0.3 修正:
//  1. [Critical] 增加了对非 JSON 响应（如 HTML 错误页）的防御性处理，避免 "Unexpected token <" 崩溃。
//  2. [Security] 重写了 ASN.1 解析器，使其能动态读取 RSA 公钥结构，提高加密兼容性。
//  3. [Network] 优化了请求头伪装，降低被上游 WAF 拦截的概率。
//
// =================================================================================

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "vidsme-2api",
  PROJECT_VERSION: "2.0.3",
  
  // 安全配置 (请在部署后修改此密钥)
  API_MASTER_KEY: "1", 
  
  // 上游服务配置
  UPSTREAM_BASE_URL: "https://api.vidsme.com/api/texttoimg/v1",
  IMAGE_BASE_URL: "https://art-global.yimeta.ai/",
  
  // 签名参数
  UPSTREAM_APP_ID: "chatsweetie",
  UPSTREAM_STATIC_SALT: "NHGNy5YFz7HeFb",
  UPSTREAM_PUBLIC_KEY: `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDa2oPxMZe71V4dw2r8rHWt59gH
W5INRmlhepe6GUanrHykqKdlIB4kcJiu8dHC/FJeppOXVoKz82pvwZCmSUrF/1yr
rnmUDjqUefDu8myjhcbio6CnG5TtQfwN2pz3g6yHkLgp8cFfyPSWwyOCMMMsTU9s
snOjvdDb4wiZI8x3UwIDAQAB
-----END PUBLIC KEY-----`,

  // 轮询配置
  POLLING_INTERVAL: 3000, // 毫秒
  POLLING_TIMEOUT: 240000, // 毫秒

  // 模型列表
  MODELS: ["anime", "realistic", "hentai", "hassaku"],
  DEFAULT_MODEL: "anime",
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 预检请求处理
    if (request.method === 'OPTIONS') {
      return handleCorsPreflight();
    }

    if (url.pathname === '/') {
      return handleUI(request);
    } else if (url.pathname.startsWith('/v1/')) {
      return handleApi(request);
    } else {
      return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
    }
  }
};

// --- [第三部分: 核心逻辑与加密工具] ---

/**
 * Vidsme 签名生成器
 * 包含手写的 ASN.1 解析器和 RSA-PKCS1-v1.5 加密器 (BigInt 实现)
 */
class VidsmeSigner {
  constructor() {
    this.publicKey = CONFIG.UPSTREAM_PUBLIC_KEY;
  }

  generateRandomKey(length = 16) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < length; i++) {
      result += chars[randomValues[i] % chars.length];
    }
    return result;
  }

  // 动态 ASN.1 解析器 (更健壮)
  parsePem(pem) {
    const b64 = pem.replace(/(-----(BEGIN|END) PUBLIC KEY-----|\n)/g, '');
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    let offset = 0;

    function readLen() {
      let len = bytes[offset++];
      if (len & 0x80) {
        let n = len & 0x7f;
        len = 0;
        for (let i = 0; i < n; i++) len = (len << 8) | bytes[offset++];
      }
      return len;
    }

    function readTag() {
      return bytes[offset++];
    }

    // 遍历 ASN.1 结构找到 Modulus 和 Exponent
    // Structure: SEQUENCE -> SEQUENCE (AlgId) -> BIT STRING -> SEQUENCE (Key) -> INTEGER (n) -> INTEGER (e)
    
    readTag(); readLen(); // Outer SEQUENCE
    
    readTag(); let algLen = readLen(); offset += algLen; // AlgorithmIdentifier
    
    readTag(); readLen(); offset++; // BIT STRING + unused bits
    
    readTag(); readLen(); // Inner SEQUENCE (RSAPublicKey)
    
    // Read Modulus (n)
    readTag(); // INTEGER
    let nLen = readLen();
    if (bytes[offset] === 0) { offset++; nLen--; } // Skip leading zero
    let nHex = '';
    for (let i = 0; i < nLen; i++) nHex += bytes[offset++].toString(16).padStart(2, '0');
    
    // Read Exponent (e)
    readTag(); // INTEGER
    let eLen = readLen();
    let eHex = '';
    for (let i = 0; i < eLen; i++) eHex += bytes[offset++].toString(16).padStart(2, '0');

    return { n: BigInt('0x' + nHex), e: BigInt('0x' + eHex) };
  }

  // RSA-PKCS1-v1.5 加密
  rsaEncrypt(data) {
    const { n, e } = this.parsePem(this.publicKey);
    const k = 128; // 1024 bit key
    const msgBytes = new TextEncoder().encode(data);
    
    if (msgBytes.length > k - 11) throw new Error("Message too long");

    // Padding
    const psLen = k - 3 - msgBytes.length;
    const ps = new Uint8Array(psLen);
    crypto.getRandomValues(ps);
    for(let i=0; i<psLen; i++) if(ps[i] === 0) ps[i] = 1;

    const padded = new Uint8Array(k);
    padded[0] = 0x00;
    padded[1] = 0x02;
    padded.set(ps, 2);
    padded[2 + psLen] = 0x00;
    padded.set(msgBytes, 2 + psLen + 1);

    // BigInt Modular Exponentiation
    let mInt = BigInt('0x' + [...padded].map(b => b.toString(16).padStart(2, '0')).join(''));
    let cInt = 1n;
    let base = mInt;
    let exp = e;
    while (exp > 0n) {
        if (exp % 2n === 1n) cInt = (cInt * base) % n;
        base = (base * base) % n;
        exp /= 2n;
    }

    let cHex = cInt.toString(16);
    if (cHex.length % 2) cHex = '0' + cHex;
    const cBytes = new Uint8Array(cHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    
    const finalBytes = new Uint8Array(128);
    finalBytes.set(cBytes, 128 - cBytes.length);

    return btoa(String.fromCharCode(...finalBytes));
  }

  // AES-CBC 加密
  async aesEncrypt(data, keyStr, ivStr) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(keyStr), { name: "AES-CBC" }, false, ["encrypt"]
    );
    const iv = enc.encode(ivStr);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-CBC", iv: iv },
      key,
      enc.encode(data)
    );
    return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
  }

  async generateSignature() {
    const randomKey = this.generateRandomKey(16);
    const secretKey = this.rsaEncrypt(randomKey);
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomUUID();
    
    const messageToSign = `${CONFIG.UPSTREAM_APP_ID}:${CONFIG.UPSTREAM_STATIC_SALT}:${timestamp}:${nonce}:${secretKey}`;
    const sign = await this.aesEncrypt(messageToSign, randomKey, randomKey);

    return {
      app_id: CONFIG.UPSTREAM_APP_ID,
      t: timestamp.toString(),
      nonce: nonce,
      sign: sign,
      secret_key: secretKey
    };
  }
}

// --- [第四部分: API 代理逻辑] ---

async function handleApi(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || authHeader.substring(7) !== CONFIG.API_MASTER_KEY) {
    return createErrorResponse('无效的 API Key', 401, 'unauthorized');
  }

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModels();
  } else if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  } else if (url.pathname === '/v1/images/generations') {
    return handleImageGenerations(request, requestId);
  } else {
    return createErrorResponse('不支持的 API 路径', 404, 'not_found');
  }
}

function handleModels() {
  return new Response(JSON.stringify({
    object: 'list',
    data: CONFIG.MODELS.map(id => ({
      id, object: 'model', created: Math.floor(Date.now()/1000), owned_by: 'vidsme-2api'
    }))
  }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

// 辅助函数：安全的 Fetch，处理非 JSON 响应
async function safeFetch(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    // 如果解析失败，说明返回的不是 JSON (可能是 HTML 错误页)
    throw new Error(`Upstream Error (${response.status}): ${text.substring(0, 200)}...`);
  }

  return { response, data };
}

// 核心：图像生成逻辑
async function generateImage(prompt, model, size = "2:3", userId = null) {
  const signer = new VidsmeSigner();
  // 确保 user_id 长度 >= 64
  const finalUserId = userId || (crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''));
  
  // 1. 提交任务
  const authParams = await signer.generateSignature();
  const apiModel = model === "hassaku" ? "hassaku(hentai)" : model;
  
  const sizeMap = { "1:1": [512, 512], "3:2": [768, 512], "2:3": [512, 768] };
  const [width, height] = sizeMap[size] || [512, 768];

  const payload = {
    prompt: `(masterpiece), best quality, expressiveeyes, perfect face, ${prompt}`,
    model: apiModel,
    user_id: finalUserId,
    height, width
  };

  const submitUrl = `${CONFIG.UPSTREAM_BASE_URL}/task?` + new URLSearchParams(authParams).toString();
  
  // 使用 safeFetch 捕获 HTML 错误
  const { data: submitData } = await safeFetch(submitUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': 'https://chatsweetie.ai',
      'Referer': 'https://chatsweetie.ai/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    body: JSON.stringify(payload)
  });

  if (submitData.code !== 200 || !submitData.data?.job_id) {
    throw new Error(`任务提交失败: ${submitData.msg || JSON.stringify(submitData)}`);
  }

  const jobId = submitData.data.job_id;
  
  // 2. 轮询结果
  const startTime = Date.now();
  while (Date.now() - startTime < CONFIG.POLLING_TIMEOUT) {
    await new Promise(r => setTimeout(r, CONFIG.POLLING_INTERVAL));
    
    const pollAuth = await signer.generateSignature();
    pollAuth.user_id = finalUserId;
    pollAuth.job_id = jobId;
    
    const pollUrl = `${CONFIG.UPSTREAM_BASE_URL}/task?` + new URLSearchParams(pollAuth).toString();
    
    const { data: pollData } = await safeFetch(pollUrl, {
      headers: {
        'Origin': 'https://chatsweetie.ai',
        'Referer': 'https://chatsweetie.ai/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    
    if (pollData.code !== 200) continue;
    
    const statusData = pollData.data || {};
    if (statusData.generate_url) {
      return CONFIG.IMAGE_BASE_URL + statusData.generate_url;
    }
    if (statusData.status === 'failed') {
      throw new Error("上游任务处理失败");
    }
  }
  throw new Error("任务轮询超时");
}

// 处理 Chat 接口
async function handleChatCompletions(request, requestId) {
  try {
    const body = await request.json();
    const messages = body.messages || [];
    const lastMsg = messages.reverse().find(m => m.role === 'user');
    
    if (!lastMsg) throw new Error("未找到用户消息");
    
    const prompt = lastMsg.content;
    const model = body.model || CONFIG.DEFAULT_MODEL;
    
    const imageUrl = await generateImage(prompt, model);
    
    const responseContent = `![${prompt.substring(0, 20)}](${imageUrl})`;
    
    const response = {
      id: requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: responseContent },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };

    return new Response(JSON.stringify(response), {
      headers: corsHeaders({ 'Content-Type': 'application/json' })
    });

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// 处理 Image 接口
async function handleImageGenerations(request, requestId) {
  try {
    const body = await request.json();
    const prompt = body.prompt;
    const model = body.model || CONFIG.DEFAULT_MODEL;
    const size = body.size || "2:3";
    
    const imageUrl = await generateImage(prompt, model, size);
    
    return new Response(JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: [{ url: imageUrl }]
    }), {
      headers: corsHeaders({ 'Content-Type': 'application/json' })
    });
  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), { status, headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

function handleCorsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- [第五部分: 开发者驾驶舱 UI] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root {
        --bg-color: #121212; --sidebar-bg: #1E1E1E; --main-bg: #121212;
        --border-color: #333; --text-color: #E0E0E0; --text-secondary: #888;
        --primary-color: #FFBF00; --primary-hover: #FFD700; --input-bg: #2A2A2A;
        --error-color: #CF6679; --success-color: #66BB6A;
        --font-family: 'Segoe UI', sans-serif; --font-mono: 'Fira Code', monospace;
      }
      * { box-sizing: border-box; }
      body { font-family: var(--font-family); margin: 0; background: var(--bg-color); color: var(--text-color); height: 100vh; display: flex; overflow: hidden; }
      .skeleton { background: linear-gradient(90deg, #2a2a2a, #3a3a3a, #2a2a2a); background-size: 200% 100%; animation: sk-load 1.5s infinite; border-radius: 4px; }
      @keyframes sk-load { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    </style>
</head>
<body>
    <main-layout></main-layout>

    <template id="main-layout-template">
      <style>
        .layout { display: flex; width: 100%; height: 100%; }
        .sidebar { width: 380px; background: var(--sidebar-bg); border-right: 1px solid var(--border-color); padding: 20px; display: flex; flex-direction: column; }
        .main-content { flex: 1; padding: 20px; display: flex; flex-direction: column; }
        .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 15px; border-bottom: 1px solid var(--border-color); margin-bottom: 15px; }
        h1 { margin: 0; font-size: 20px; } .version { font-size: 12px; color: var(--text-secondary); margin-left: 8px; }
        details { margin-top: 20px; } summary { cursor: pointer; font-weight: bold; margin-bottom: 10px; }
      </style>
      <div class="layout">
        <aside class="sidebar">
          <header class="header">
            <h1>${CONFIG.PROJECT_NAME}<span class="version">v${CONFIG.PROJECT_VERSION}</span></h1>
            <status-indicator></status-indicator>
          </header>
          <info-panel></info-panel>
          <details open><summary>⚙️ 客户端集成指南</summary><client-guides></client-guides></details>
        </aside>
        <main class="main-content">
          <live-terminal></live-terminal>
        </main>
      </div>
    </template>

    <template id="status-indicator-template">
      <style>
        .indicator { display: flex; align-items: center; gap: 8px; font-size: 12px; }
        .dot { width: 10px; height: 10px; border-radius: 50%; }
        .dot.grey { background: #555; } .dot.green { background: var(--success-color); } .dot.red { background: var(--error-color); }
        .dot.yellow { background: var(--primary-color); animation: pulse 2s infinite; }
        @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(255,191,0,0.4); } 70% { box-shadow: 0 0 0 10px rgba(0,0,0,0); } }
      </style>
      <div class="indicator"><div id="dot" class="dot grey"></div><span id="text">初始化...</span></div>
    </template>

    <template id="info-panel-template">
      <style>
        .panel { display: flex; flex-direction: column; gap: 12px; }
        label { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; display: block; }
        .val { background: var(--input-bg); padding: 8px; border-radius: 4px; font-family: var(--font-mono); font-size: 13px; color: var(--primary-color); display: flex; justify-content: space-between; align-items: center; }
        .val.pass { -webkit-text-security: disc; } .val.show { -webkit-text-security: none; }
        button { background: none; border: none; color: #888; cursor: pointer; } button:hover { color: #fff; }
      </style>
      <div class="panel">
        <div><label>API 端点</label><div id="url" class="val skeleton"></div></div>
        <div><label>API 密钥</label><div id="key" class="val pass skeleton"></div></div>
        <div><label>默认模型</label><div id="model" class="val skeleton"></div></div>
      </div>
    </template>

    <template id="client-guides-template">
       <style>
        .tabs { display: flex; border-bottom: 1px solid var(--border-color); margin-bottom: 10px; }
        .tab { padding: 8px 12px; cursor: pointer; border: none; background: none; color: #888; }
        .tab.active { color: var(--primary-color); border-bottom: 2px solid var(--primary-color); }
        pre { background: var(--input-bg); padding: 10px; border-radius: 4px; font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; position: relative; }
        .copy { position: absolute; top: 5px; right: 5px; background: #444; border: 1px solid #555; color: #ccc; border-radius: 3px; cursor: pointer; font-size: 10px; padding: 2px 6px; }
       </style>
       <div><div class="tabs"></div><div class="content"></div></div>
    </template>

    <template id="live-terminal-template">
      <style>
        .term { display: flex; flex-direction: column; height: 100%; background: var(--sidebar-bg); border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; }
        .out { flex: 1; padding: 15px; overflow-y: auto; font-size: 14px; line-height: 1.6; }
        .in { border-top: 1px solid var(--border-color); padding: 15px; display: flex; gap: 10px; }
        textarea { flex: 1; background: var(--input-bg); border: 1px solid var(--border-color); color: var(--text-color); padding: 10px; resize: none; border-radius: 4px; }
        button { background: var(--primary-color); border: none; border-radius: 4px; padding: 0 20px; font-weight: bold; cursor: pointer; }
        .msg { margin-bottom: 10px; } .msg.user { color: var(--primary-color); font-weight: bold; } .msg.img img { max-width: 100%; border-radius: 4px; margin-top: 5px; }
      </style>
      <div class="term">
        <div class="out"><p style="color:#888">输入提示词开始生成图像 (例如: "A cute cat")...</p></div>
        <div class="in"><textarea id="input" rows="1" placeholder="输入指令..."></textarea><button id="send">发送</button></div>
      </div>
    </template>

    <script>
      const CFG = { ORIGIN: '${origin}', KEY: '${CONFIG.API_MASTER_KEY}', MODEL: '${CONFIG.DEFAULT_MODEL}', MODELS: '${CONFIG.MODELS.join(',')}' };
      
      class Base extends HTMLElement {
        constructor(id) { super(); this.attachShadow({mode:'open'}).appendChild(document.getElementById(id).content.cloneNode(true)); }
      }

      customElements.define('main-layout', class extends Base { constructor(){super('main-layout-template')} });
      
      customElements.define('status-indicator', class extends Base {
        constructor(){super('status-indicator-template'); this.d=this.shadowRoot.getElementById('dot'); this.t=this.shadowRoot.getElementById('text');}
        set(s,m){ this.d.className='dot '+s; this.t.textContent=m; }
      });

      customElements.define('info-panel', class extends Base {
        constructor(){super('info-panel-template');}
        connectedCallback(){
          const set=(id,v,p)=>{
            const el=this.shadowRoot.getElementById(id); el.classList.remove('skeleton');
            el.innerHTML=\`<span>\${v}</span><div>\${p?'<button onclick="this.closest(\\\'.val\\\').classList.toggle(\\\'show\\\')">👁️</button>':''}<button onclick="navigator.clipboard.writeText('\${v}')">📋</button></div>\`;
          };
          set('url', CFG.ORIGIN+'/v1', false); set('key', CFG.KEY, true); set('model', CFG.MODEL, false);
        }
      });

      customElements.define('client-guides', class extends Base {
        constructor(){super('client-guides-template');}
        connectedCallback(){
          const tabs=this.shadowRoot.querySelector('.tabs'), cont=this.shadowRoot.querySelector('.content');
          const g={
            'cURL': \`<pre><code>curl \${CFG.ORIGIN}/v1/images/generations \\\\
  -H "Authorization: Bearer \${CFG.KEY}" \\\\
  -H "Content-Type: application/json" \\\\
  -d '{
    "prompt": "A futuristic city",
    "model": "\${CFG.MODEL}",
    "size": "2:3"
  }'</code><button class="copy" onclick="navigator.clipboard.writeText(this.previousSibling.innerText)">复制</button></pre>\`,
            'Python': \`<pre><code>import openai
client = openai.OpenAI(api_key="\${CFG.KEY}", base_url="\${CFG.ORIGIN}/v1")

# 方式1: 聊天接口 (推荐)
resp = client.chat.completions.create(
  model="\${CFG.MODEL}",
  messages=[{"role": "user", "content": "A cute cat"}]
)
print(resp.choices[0].message.content) # 返回 Markdown 图片链接

# 方式2: 图像接口
img = client.images.generate(
  prompt="A cute cat",
  model="\${CFG.MODEL}"
)
print(img.data[0].url)</code><button class="copy" onclick="navigator.clipboard.writeText(this.previousSibling.innerText)">复制</button></pre>\`
          };
          Object.keys(g).forEach((k,i)=>{
            const b=document.createElement('button'); b.className='tab '+(i===0?'active':''); b.textContent=k;
            b.onclick=()=>{this.shadowRoot.querySelectorAll('.tab').forEach(t=>t.classList.remove('active')); b.classList.add('active'); cont.innerHTML=g[k];};
            tabs.appendChild(b);
          });
          cont.innerHTML=g['cURL'];
        }
      });

      customElements.define('live-terminal', class extends Base {
        constructor(){super('live-terminal-template'); this.out=this.shadowRoot.querySelector('.out'); this.inp=this.shadowRoot.getElementById('input'); this.btn=this.shadowRoot.getElementById('send');}
        connectedCallback(){
          this.btn.onclick=()=>this.send();
          this.inp.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();this.send();}};
        }
        add(cls, html){ const d=document.createElement('div'); d.className='msg '+cls; d.innerHTML=html; this.out.appendChild(d); this.out.scrollTop=this.out.scrollHeight; return d; }
        async send(){
          const p=this.inp.value.trim(); if(!p)return;
          this.inp.value=''; this.btn.disabled=true; this.btn.textContent='生成中...';
          this.add('user', p);
          const loading=this.add('sys', '正在提交任务并轮询结果 (约10-30秒)...');
          
          try {
            const res = await fetch(CFG.ORIGIN+'/v1/chat/completions', {
              method:'POST', headers:{'Authorization':'Bearer '+CFG.KEY, 'Content-Type':'application/json'},
              body: JSON.stringify({model:CFG.MODEL, messages:[{role:'user', content:p}]})
            });
            const data = await res.json();
            loading.remove();
            if(!res.ok) throw new Error(data.error?.message||'Error');
            const content = data.choices[0].message.content; // ![prompt](url)
            const url = content.match(/\\((.*?)\\)/)[1];
            this.add('img', \`<img src="\${url}" onclick="window.open(this.src)">\`);
          } catch(e) {
            loading.textContent = '错误: '+e.message; loading.style.color='var(--error-color)';
          } finally {
            this.btn.disabled=false; this.btn.textContent='发送';
          }
        }
      });

      // Init
      document.addEventListener('DOMContentLoaded', async ()=>{
        const ind = document.querySelector('main-layout').shadowRoot.querySelector('status-indicator');
        ind.set('yellow', '检查服务...');
        try {
          const res = await fetch(CFG.ORIGIN+'/v1/models', {headers:{'Authorization':'Bearer '+CFG.KEY}});
          if(res.ok) ind.set('green', '系统就绪'); else throw new Error();
        } catch(e) { ind.set('red', '服务异常'); }
      });
    </script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
