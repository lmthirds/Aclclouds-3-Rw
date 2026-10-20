#!/usr/bin/env node
import { chromium } from 'playwright';
import Tesseract from 'tesseract.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const rawBase = (process.env.ACL_BASE_URL || '').trim();
const BASE = (rawBase || 'https://aclclouds.com').replace(/\/+$/, '');
const USER = (process.env.ACL_USERNAME || process.env.ACL_EMAIL || '').trim();
const PASS = process.env.ACL_PASSWORD || '';
const SERVER_ID = (process.env.ACL_SERVER_ID || '').trim();
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const AUTH = path.resolve(process.env.ACL_AUTH_STATE || 'auth.json');
const SHOT = path.resolve('shots');

const VOCAB = [
  'Panel', 'VPS', 'Bot', 'Serveur', 'Server', 'Cloud', 'ACLClouds',
  'Minecraft', 'Discord', 'Housing', 'Tunnel', 'Dedicated',
  'Free', 'Upgrade', 'Renew', 'Game', 'Node', 'Credit', 'Support',
  'Host', 'Hosting', 'Container', 'Project', 'Database', 'Backup', 'Web'
];

const OCR_MIN_SCORE = Math.max(30, Math.min(100, Number.parseInt(process.env.ACL_CAPTCHA_OCR_MIN_SCORE || '50', 10)));
const CAPTCHA_MAX_ATTEMPTS = Math.max(1, Math.min(6, Number.parseInt(process.env.ACL_CAPTCHA_MAX_ATTEMPTS || '4', 10)));

fs.mkdirSync(SHOT, { recursive: true });
const shots = [];

function log(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function score(a, b) {
  a = norm(a);
  b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 82;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  const maxLen = Math.max(a.length, b.length);
  const ratioScore = Math.round((1 - dp[a.length][b.length] / maxLen) * 100);
  const fixedScore = 100 - dp[a.length][b.length] * 25;
  return Math.max(0, ratioScore, fixedScore);
}

function ocrScore(text, guess, prompt) {
  return Math.max(score(text, prompt), score(guess, prompt));
}

function decodeCaptchaOption(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function pickByOptionText(prompt, options = []) {
  const ranked = options
    .map((raw, i) => {
      const text = decodeCaptchaOption(raw);
      return { i, raw, text, s: score(text, prompt) };
    })
    .sort((a, b) => b.s - a.s);

  if (!ranked.length) return null;
  const top = ranked[0];
  const second = ranked[1]?.s ?? -1;
  const hasStrongMatch = top.s >= 80;
  const hasClearLead = top.s >= 65 && top.s - second >= 15;

  if (hasStrongMatch || hasClearLead) {
    return top;
  }
  return null;
}

async function shot(page, name) {
  try {
    const p = path.join(SHOT, name);
    await page.screenshot({ path: p, fullPage: true });
    shots.push(p);
    log('截图 ' + name);
    return p;
  } catch (e) {
    log('截图失败 ' + name + ': ' + e.message);
    return null;
  }
}

async function sendTgPhoto(chat, token, photoPath, caption) {
  token = String(token || '').trim();
  chat = String(chat || '').trim();
  if (!photoPath || !fs.existsSync(photoPath) || fs.statSync(photoPath).size < 100 || !token || !chat) return;
  try {
    const form = new FormData();
    form.append('chat_id', chat);
    form.append('photo', new Blob([fs.readFileSync(photoPath)], { type: 'image/png' }), path.basename(photoPath));
    if (caption) form.append('caption', caption);
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendPhoto', { method: 'POST', body: form });
    if (!r.ok) log('TG 图片发送失败 ' + path.basename(photoPath) + ': ' + (await r.text()));
    else log('TG 图片已发送: ' + path.basename(photoPath));
  } catch (e) {
    log('TG 图片发送异常: ' + e.message);
  }
}

async function tg(text, { photo = null } = {}) {
  const token = String(process.env.TG_BOT_TOKEN || '').trim();
  const chat = String(process.env.TG_CHAT_ID || '').trim();
  if (!token || !chat) {
    log('未配置 TG_BOT_TOKEN/TG_CHAT_ID,跳过通知');
    return;
  }
  try {
    const msg = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!msg.ok) {
      await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      });
    }
    log('TG 文本已发送');
  } catch (e) {
    log('TG 发送异常 (非致命): ' + e.message);
  }

  if (photo) {
    await sendTgPhoto(chat, token, photo);
  }
}

function formatTgMessage({ failed, results = [], errorMsg = '' }) {
  const beijingTime = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const hasRenewed = results.some((r) => r.ok && !r.skip);
  const allSkipped = results.length > 0 && results.every((r) => r.ok && r.skip);

  let title = '✅ <b>【ACLClouds 自动续期成功】</b>';
  let badge = '🎉 服务续期成功';
  if (failed) {
    title = '❌ <b>【ACLClouds 自动续期失败】</b>';
    badge = '⚠️ 续期任务异常';
  } else if (allSkipped) {
    title = '⏳ <b>【ACLClouds 续期检查 - 未到窗口】</b>';
    badge = 'ℹ️ 暂未到可续期时间';
  }

  const currentAccount = USER || '未设置';
  const lines = [
    title,
    '━━━━━━━━━━━━━━━━━━━━',
    '🕒 <b>执行时间</b>: ' + beijingTime + ' (北京时间)',
    '👤 <b>当前账号</b>: <code>' + currentAccount + '</code>',
    '📊 <b>任务状态</b>: ' + badge,
    '━━━━━━━━━━━━━━━━━━━━',
    '<b>服务详情</b>:',
  ];

  if (failed && errorMsg) {
    lines.push('• 异常原因: ' + errorMsg);
  }

  for (const r of results) {
    const icon = r.ok ? (r.skip ? '⏳' : '✅') : '❌';
    lines.push('• ' + icon + ' ' + r.text);
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━');
  if (failed) {
    lines.push('⚠️ 请及时查看 GitHub Actions 运行日志与失败截图排查。');
  } else if (hasRenewed) {
    lines.push('✨ 服务已成功延期，将在下次预定周期继续自动守护。');
  } else {
    lines.push('📌 站点限制到期前开放续期，下次执行将自动处理。');
  }

  return lines.join('\n');
}

async function ocrPick(dir, prompt, n) {
  const worker = await Tesseract.createWorker('eng');
  await worker.setParameters({
    tessedit_pageseg_mode: '7',
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  });
  const results = [];
  for (let i = 0; i < n; i++) {
    const file = path.join(dir, i + '.png');
    const r = await worker.recognize(file);
    const text = (r.data.text || '').replace(/\s+/g, '').trim();
    const best = VOCAB.map((v) => ({ v, s: score(text, v) })).sort((p, q) => q.s - p.s)[0];
    results.push({ i, text, guess: best.v, vsPrompt: ocrScore(text, best.v, prompt) });
  }
  await worker.terminate();
  results.sort((a, b) => b.vsPrompt - a.vsPrompt);

  const summaryStr = results
    .map((x) => {
      const label = x.text ? x.text : x.guess;
      return x.i + ':' + label + '(' + x.vsPrompt + ')';
    })
    .join(' ');
  log('OCR prompt=' + prompt + ' ' + summaryStr);

  if (!results[0]) throw new Error('OCR 无结果: ' + prompt);
  if (results[0].vsPrompt < OCR_MIN_SCORE) {
    const secondScore = results[1]?.vsPrompt ?? 0;
    if (results[0].vsPrompt >= 35 && results[0].vsPrompt - secondScore >= 15) {
      log('OCR 分数(' + results[0].vsPrompt + ')低于阈值(' + OCR_MIN_SCORE + ')但领先第二名,兜底选择 option ' + results[0].i);
      return results[0].i;
    }
    throw new Error('OCR 未匹配 ' + prompt + ' (阈值:' + OCR_MIN_SCORE + '): ' + JSON.stringify(results));
  }
  return results[0].i;
}

async function api(page, p, method = 'GET', body, extraHeaders = {}) {
  const fullUrl = p.startsWith('http') ? p : BASE + (p.startsWith('/') ? '' : '/') + p;
  return page.evaluate(
    async ({ fullUrl, method, body, extraHeaders }) => {
      try {
        const token = document.cookie
          .split('; ')
          .find((c) => c.startsWith('XSRF-TOKEN='))
          ?.split('=')[1];
        const metaCsrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');

        // 部分站点的 /api/* 接口不是靠 Cookie 会话鉴权，而是要求前端自己在登录后
        // 把拿到的 token 存进 localStorage/sessionStorage，再以 Authorization: Bearer 头带上。
        // 这里自动扫描常见命名的字段，尽量兼容这种情况。
        let bearerToken = null;
        let bearerKeyFound = null;
        const tokenKeyRe = /token|jwt|bearer/i;
        try {
          for (const store of [window.localStorage, window.sessionStorage]) {
            for (let i = 0; i < store.length; i++) {
              const k = store.key(i);
              if (!k || !tokenKeyRe.test(k) || /csrf|xsrf/i.test(k)) continue;
              let v = store.getItem(k);
              if (!v) continue;
              try {
                const parsed = JSON.parse(v);
                v = parsed.token || parsed.access_token || parsed.accessToken || parsed.api_token || v;
              } catch {}
              if (typeof v === 'string' && v.length > 10) {
                bearerToken = v;
                bearerKeyFound = k;
                break;
              }
            }
            if (bearerToken) break;
          }
        } catch {}

        const headers = {
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          ...(token ? { 'X-XSRF-TOKEN': decodeURIComponent(token) } : {}),
          ...(metaCsrf ? { 'X-CSRF-TOKEN': metaCsrf } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(bearerToken ? { Authorization: 'Bearer ' + bearerToken } : {}),
          ...extraHeaders,
        };

        const res = await fetch(fullUrl, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          credentials: 'include',
          redirect: 'follow',
        });
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = text.slice(0, 400);
        }

        // 401 时附带诊断信息 (只带字段名，不带值) 方便定位到底缺的是会话 Cookie 还是 Token
        let diag;
        if (res.status === 401) {
          diag = {
            cookieNames: document.cookie.split('; ').map((c) => c.split('=')[0]).filter(Boolean),
            localStorageKeys: Object.keys(window.localStorage || {}),
            sessionStorageKeys: Object.keys(window.sessionStorage || {}),
            usedBearerKey: bearerKeyFound,
          };
        }

        return { status: res.status, url: res.url, redirected: res.redirected, data, diag };
      } catch (err) {
        return { status: 0, url: fullUrl, redirected: false, data: { error: err.message } };
      }
    },
    { fullUrl, method, body, extraHeaders }
  );
}

async function logAuthStorageDiag(page, label) {
  try {
    const diag = await page.evaluate(() => ({
      cookieNames: document.cookie.split('; ').map((c) => c.split('=')[0]).filter(Boolean),
      localStorageKeys: Object.keys(window.localStorage || {}),
      sessionStorageKeys: Object.keys(window.sessionStorage || {}),
    }));
    log(
      '[' + label + '] 鉴权信息: cookie=[' + diag.cookieNames.join(',') +
        '] localStorage=[' + diag.localStorageKeys.join(',') +
        '] sessionStorage=[' + diag.sessionStorageKeys.join(',') + ']'
    );
  } catch (e) {
    log('[' + label + '] 读取鉴权诊断信息失败: ' + e.message);
  }
}

async function solveCaptchaApi(page, context = 'login') {
  log('通过 API 求解验证码 (context: ' + context + ')...');
  let lastErr = null;

  for (let attempt = 1; attempt <= CAPTCHA_MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        log('API 验证码重试 ' + attempt + '/' + CAPTCHA_MAX_ATTEMPTS);
      }

      const challengeRes = await api(page, '/auth/captcha/challenge?context=' + encodeURIComponent(context));
      if (challengeRes.status !== 200 || !challengeRes.data?.id) {
        throw new Error('获取验证码 challenge 失败: HTTP ' + challengeRes.status + ' ' + JSON.stringify(challengeRes.data));
      }
      const chal = challengeRes.data;
      await page.waitForTimeout(1300);

      const initialVerify = await api(page, '/auth/captcha', 'POST', {
        context: chal.context || context,
        id: chal.id,
        ts: chal.ts,
        sig: chal.sig,
        elapsed: 1450,
      });

      if (initialVerify.status !== 200) {
        throw new Error('验证码初始验证失败: HTTP ' + initialVerify.status + ' ' + JSON.stringify(initialVerify.data));
      }

      const ver = initialVerify.data;
      if (ver.passed && ver.token) {
        log('API 验证码无感直通成功');
        return ver.token;
      }

      if (!ver.interactive || !ver.target || !Array.isArray(ver.options)) {
        throw new Error('验证码返回非交互态: ' + JSON.stringify(ver));
      }

      const target = String(ver.target)
        .replace(/^(?:Click on|Cliquez sur|Select|Choisissez)\s*(?:the|le|la|l')?\s*/i, '')
        .trim();
      const options = ver.options;
      const directPick = pickByOptionText(target, options);
      let pick = -1;

      if (directPick) {
        pick = directPick.i;
        log('验证码命中文本选项: prompt=' + target + ' option=' + directPick.text + ' score=' + directPick.s);
      } else {
        const dir = path.join(SHOT, 'captcha_api');
        fs.mkdirSync(dir, { recursive: true });

        for (let i = 0; i < options.length; i++) {
          const optStr = String(options[i]);
          const imgUrl = optStr.startsWith('http')
            ? optStr
            : optStr.startsWith('/')
            ? BASE + optStr
            : BASE + '/auth/captcha/image?t=' + encodeURIComponent(optStr);

          const bytes = await page.evaluate(async (u) => {
            const r = await fetch(u, { credentials: 'include' });
            return Array.from(new Uint8Array(await r.arrayBuffer()));
          }, imgUrl);
          fs.writeFileSync(path.join(dir, i + '.png'), Buffer.from(bytes));
        }

        pick = await ocrPick(dir, target, options.length);
      }

      const selectedOption = options[pick];
      await page.waitForTimeout(800);

      const submitVerify = await api(page, '/auth/captcha', 'POST', {
        context: ver.context || context,
        id: ver.id,
        ts: ver.ts,
        sig: ver.sig,
        answer: selectedOption,
        answer_sig: ver.answer_sig || '',
        target: ver.target,
        elapsed: 2400,
      });

      if (submitVerify.status === 200 && submitVerify.data?.passed && submitVerify.data?.token) {
        log('API 验证码成功解决: ' + target + ' -> token 获得');
        return submitVerify.data.token;
      }

      throw new Error('API 验证码选项提交未通过: ' + JSON.stringify(submitVerify.data));
    } catch (e) {
      lastErr = e;
      log('API 验证码第 ' + attempt + ' 次失败: ' + e.message);
      if (attempt < CAPTCHA_MAX_ATTEMPTS) {
        await page.waitForTimeout(1500);
      }
    }
  }

  const lastMsg = lastErr ? lastErr.message : '未知错误';
  throw new Error('API 验证码连续失败 ' + CAPTCHA_MAX_ATTEMPTS + ' 次: ' + lastMsg);
}

async function injectCaptchaToken(page, token) {
  await page.evaluate((tok) => {
    // 1. 注入页面所有可能存储 captcha token 的隐藏 input
    // (实测该站点真实字段名是 cap-token，不含 "captcha" 这个词，所以要显式加上，
    //  不能只靠 input[type="hidden"] 兜底 —— 如果它不是 type=hidden 就会漏掉)
    const inputs = document.querySelectorAll(
      'input[name*="captcha" i], input[id*="captcha" i], input[data-captcha], input[type="hidden"], input[name="cap-token" i]'
    );
    inputs.forEach((inp) => {
      const name = (inp.name || inp.id || '').toLowerCase();
      if (name.includes('captcha') || name.includes('token')) {
        if (name !== '_token' && name !== 'csrf_token') {
          inp.value = tok;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });

    // 2. 向所有 form 追加常见名称的隐藏字段
    document.querySelectorAll('form').forEach((form) => {
      for (const fieldName of ['cap-token', 'captcha_token', 'captcha', 'auth_captcha_token', 'g-recaptcha-response']) {
        let field = form.querySelector('input[name="' + fieldName + '"]');
        if (!field) {
          field = document.createElement('input');
          field.type = 'hidden';
          field.name = fieldName;
          form.appendChild(field);
        }
        field.value = tok;
      }
    });

    // 3. 将 checkbox 状态设为 true 并派发自定义事件
    const cb = document.querySelector("div[role='checkbox']");
    if (cb) {
      cb.setAttribute('aria-checked', 'true');
      cb.classList.add('checked', 'is-checked', 'verified', 'passed');
      cb.dispatchEvent(new CustomEvent('captcha-verified', { detail: { token: tok }, bubbles: true }));
      cb.dispatchEvent(new CustomEvent('verified', { detail: tok, bubbles: true }));
    }

    // 4. 强制解除所有提交按钮的 disabled 状态
    document.querySelectorAll("button[type='submit'], input[type='submit'], .auth-submit-btn").forEach((btn) => {
      btn.removeAttribute('disabled');
      btn.disabled = false;
      btn.setAttribute('aria-disabled', 'false');
    });

    window.__captchaToken = tok;
  }, token);
}

async function solveCaptcha(page, prefix = '', apiContext = 'login') {
  const root = prefix ? prefix + ' ' : '';

  // 尝试用原生鼠标坐标点击 checkbox，触发前端真實鼠标事件
  try {
    const cbLoc = page.locator(root + "div[role='checkbox'], " + root + '.auth-captcha-checkbox, ' + root + '.auth-captcha-box').first();
    if ((await cbLoc.count()) > 0) {
      const isChecked = await cbLoc.getAttribute('aria-checked').catch(() => null);
      if (isChecked === 'true') {
        log('UI 验证码已处于通过状态');
        return 'ui_already_passed';
      }
      await cbLoc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      const box = await cbLoc.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(120);
        await page.mouse.down();
        await page.waitForTimeout(80);
        await page.mouse.up();
      } else {
        await cbLoc.click({ force: true, timeout: 4000 }).catch(() => {});
      }
    }
  } catch (e) {
    log('点击验证码复选框异常: ' + e.message);
  }

  // 检查是否点击后 2 秒内直接无感通过
  const passedDirectly = await page
    .waitForFunction(
      (sel) => document.querySelector(sel)?.getAttribute('aria-checked') === 'true',
      root + "div[role='checkbox']",
      { timeout: 2000 }
    )
    .then(() => true)
    .catch(() => false);

  if (passedDirectly) {
    log('UI 验证码点击后直接无感通过');
    return 'ui_direct_passed';
  }

  // 等待验证码选项图片出现（最多等 5 秒，若不出现立即走 API 直通）
  const hasImg = await page
    .waitForSelector(root + '.auth-captcha-option-img', { timeout: 5000 })
    .then(() => true)
    .catch(() => false);

  if (!hasImg) {
    log('UI 验证码图片未弹出,切换为 API 验证码直通模式...');
    const token = await solveCaptchaApi(page, apiContext);
    await injectCaptchaToken(page, token);
    log('已通过 API 求解并向页面注入验证码 Token');
    return token;
  }

  await page.waitForFunction(
    (sel) => {
      const imgs = [...document.querySelectorAll(sel)];
      return imgs.length > 0 && imgs.every((i) => i.naturalWidth > 0 && i.clientHeight > 0);
    },
    root + '.auth-captcha-option-img',
    { timeout: 12000 }
  );

  const promptRaw = await page.locator(root + '.auth-captcha-prompt').first().innerText();
  const prompt = promptRaw
    .replace(/^(?:Click on|Cliquez sur|Select|Choisissez)\s*(?:the|le|la|l')?\s*/i, '')
    .replace(/[.:!?\s]+$/, '')
    .trim();

  const imgs = page.locator(root + '.auth-captcha-option-img');
  const n = await imgs.count();
  const dir = path.join(SHOT, 'captcha');
  fs.mkdirSync(dir, { recursive: true });

  for (let i = 0; i < n; i++) {
    const src = await imgs.nth(i).getAttribute('src');
    const url = src.startsWith('http') ? src : BASE + (src.startsWith('/') ? '' : '/') + src;
    const bytes = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      return Array.from(new Uint8Array(await r.arrayBuffer()));
    }, url);
    fs.writeFileSync(path.join(dir, i + '.png'), Buffer.from(bytes));
  }

  await shot(page, '02-captcha.png');
  const pick = await ocrPick(dir, prompt, n);
  await page.locator(root + '.auth-captcha-option').nth(pick).evaluate((el) => el.click());

  await page.waitForFunction(
    (sel) => {
      const cb = document.querySelector(sel);
      if (!cb) return true;
      return cb.getAttribute('aria-checked') === 'true';
    },
    root + "div[role='checkbox']",
    { timeout: 12000 }
  );
  log('UI 验证码通过: ' + prompt + ' -> option ' + (pick + 1));
  return 'ui_ocr_passed';
}

async function loggedIn(page) {
  const url = page.url();
  if (/\/dashboard/i.test(url) && !/\/auth\/login/i.test(url)) return true;
  const r = await api(page, '/api/client/account');
  if (r.status === 200 && (r.data?.object === 'user' || r.data?.attributes || r.data?.id || r.data?.username)) {
    return true;
  }
  const r2 = await api(page, '/api/client');
  return r2.status === 200 && typeof r2.data === 'object';
}

async function fillLoginCredentials(page) {
  const userLoc = page.locator('#username, input[name="username"], input[name="email"], input[type="email"], input[type="text"]').first();
  const passLoc = page.locator('#password, input[name="password"], input[type="password"]').first();
  await userLoc.waitFor({ state: 'visible', timeout: 15000 });
  await userLoc.fill(USER);
  await passLoc.fill(PASS);
}

async function submitLoginFallback(page, captchaToken) {
  log('执行直接登录提交 (携带验证码 Token)...');

  // 方式 A: 使用页面真实 Form 字段构造 URLSearchParams 提交 (兼容传统 Laravel/PHP/Node 表单登录)
  const formRes = await page.evaluate(
    async ({ user, pass, tok }) => {
      try {
        const form = document.querySelector('form');
        const action = form?.getAttribute('action') || window.location.href;
        const params = new URLSearchParams();
        const originalFieldNames = [];

        if (form) {
          const fd = new FormData(form);
          for (const [k, v] of fd.entries()) {
            params.set(k, String(v));
            originalFieldNames.push(k);
          }
        }

        // 确保账号密码与各类可能的字段名齐全
        const userInput = document.querySelector('#username, input[name="username"], input[name="email"], input[name="identity"]');
        const passInput = document.querySelector('#password, input[name="password"]');
        if (userInput?.name) params.set(userInput.name, user);
        if (passInput?.name) params.set(passInput.name, pass);
        params.set('username', user);
        params.set('email', user);
        params.set('identity', user);
        params.set('password', pass);

        if (tok && !tok.startsWith('ui_')) {
          params.set('cap-token', tok);
          params.set('captcha_token', tok);
          params.set('captcha', tok);
          params.set('token', tok);
          params.set('auth_captcha_token', tok);
        }

        const csrfMeta = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
        if (csrfMeta && !params.has('_token')) {
          params.set('_token', csrfMeta);
        }

        const xsrfCookie = document.cookie
          .split('; ')
          .find((c) => c.startsWith('XSRF-TOKEN='))
          ?.split('=')[1];

        const r = await fetch(action, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'text/html,application/xhtml+xml,application/json,*/*',
            ...(xsrfCookie ? { 'X-XSRF-TOKEN': decodeURIComponent(xsrfCookie) } : {}),
            ...(csrfMeta ? { 'X-CSRF-TOKEN': csrfMeta } : {}),
          },
          body: params.toString(),
          credentials: 'include',
          redirect: 'follow',
        });
        const bodyText = await r.text().catch(() => '');
        return {
          status: r.status,
          url: r.url,
          redirected: r.redirected,
          bodyText: bodyText.slice(0, 600),
          originalFieldNames,
        };
      } catch (e) {
        return { status: 0, error: e.message };
      }
    },
    { user: USER, pass: PASS, tok: captchaToken || '' }
  );

  log(
    '表单 POST 结果: status=' + formRes.status + ' url=' + (formRes.url || '') +
      ' 表单原始字段=[' + (formRes.originalFieldNames || []).join(',') + ']'
  );
  if (formRes.status !== 200 && formRes.status !== 302) {
    log('表单 POST 响应体: ' + (formRes.bodyText || formRes.error || ''));
  }
  if (formRes.url && /\/dashboard/i.test(formRes.url)) {
    await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    if (await loggedIn(page)) return true;
  }

  // 方式 B: JSON API POST 尝试常见登录端点
  const payload = {
    username: USER,
    email: USER,
    identity: USER,
    password: PASS,
    ...(captchaToken && !captchaToken.startsWith('ui_')
      ? {
          'cap-token': captchaToken,
          captcha_token: captchaToken,
          captcha: captchaToken,
          token: captchaToken,
          auth_captcha_token: captchaToken,
        }
      : {}),
  };

  for (const endpoint of ['/auth/login', '/api/auth/login', '/auth/login/submit']) {
    const r = await api(page, endpoint, 'POST', payload, {
      ...(captchaToken ? { 'X-Captcha-Token': captchaToken } : {}),
    });
    log('JSON 登录尝试 ' + endpoint + ': HTTP ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 300));
    if (r.status === 200 || r.status === 204 || r.status === 302 || (r.url && /\/dashboard/i.test(r.url))) {
      await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      if (await loggedIn(page)) return true;
    }
  }

  // 方式 C: 直接在 DOM 中调用 form.submit() 原生提交
  await page
    .evaluate(() => {
      const form = document.querySelector('form');
      if (form) HTMLFormElement.prototype.submit.call(form);
    })
    .catch(() => {});
  await page.waitForTimeout(3500);
  if (!page.url().includes('/dashboard')) {
    await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  }
  return await loggedIn(page);
}

async function login(page) {
  log('登录 ' + BASE + ' as ' + USER);
  await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1000);

  if (await loggedIn(page)) {
    log('已有有效会话,跳过登录验证码');
    await page.context().storageState({ path: AUTH }).catch(() => {});
    await logAuthStorageDiag(page, '复用会话');
    return;
  }

  if (fs.existsSync(AUTH)) {
    log('缓存会话已失效,清理并重新登录');
    try { fs.unlinkSync(AUTH); } catch {}
  }

  await page.goto(BASE + '/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1000);

  // 诊断结果显示登录后只有 XSRF-TOKEN 一个 Cookie、localStorage 里也没有任何 token 字段，
  // 这是典型的 Laravel Sanctum "SPA 鉴权" 场景: 必须先 GET /sanctum/csrf-cookie 预热，
  // 登录时产生的会话才会被 Sanctum 标记为 stateful，后续 /api/* 请求才会被认成已登录；
  // 否则即使登录表单提交成功、网页能正常打开，所有 API 调用也会一直是 401。
  const csrfPrime = await api(page, '/sanctum/csrf-cookie').catch(() => ({ status: 0 }));
  log('预热 Sanctum CSRF 端点 /sanctum/csrf-cookie: HTTP ' + csrfPrime.status);
  await page.waitForTimeout(300);

  await fillLoginCredentials(page);
  await shot(page, '01-login.png');

  let authed = false;
  let captchaToken = null;
  for (let i = 0; i < 4 && !authed; i++) {
    try {
      captchaToken = await solveCaptcha(page, '', 'login');
      authed = true;
    } catch (e) {
      log('登录验证码失败(' + (i + 1) + '/4): ' + e.message);
      await shot(page, '01-login-fail-' + (i + 1) + '.png');
      await page.goto(BASE + '/auth/login', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);
      await fillLoginCredentials(page);
    }
  }
  if (!authed) throw new Error('登录验证码连续 4 次失败');

  // 尝试点击提交按钮（移除 disabled 后使用 evaluate 点击 + 5秒短超时，绝不卡死）
  const submitBtn = page.locator("button[type='submit'], input[type='submit'], .auth-submit-btn").first();
  await submitBtn
    .evaluate((el) => {
      el.removeAttribute('disabled');
      el.disabled = false;
      el.click();
    })
    .catch(() => {});

  const redirected = await page
    .waitForFunction(() => !window.location.pathname.includes('/auth/login'), { timeout: 6000 })
    .then(() => true)
    .catch(() => false);

  if (!redirected && !(await loggedIn(page))) {
    if (!captchaToken || captchaToken.startsWith('ui_')) {
      captchaToken = await solveCaptchaApi(page, 'login').catch(() => '');
      if (captchaToken) await injectCaptchaToken(page, captchaToken);
    }
    await submitLoginFallback(page, captchaToken);
  }

  if (!(await loggedIn(page))) {
    const errText = await page.locator('.alert, .error, [role="alert"], .text-red-500').first().innerText().catch(() => '');
    const extra = errText ? ' (' + errText.trim() + ')' : '';
    throw new Error('登录后仍未进入 dashboard' + extra);
  }

  await page.context().storageState({ path: AUTH });
  log('登录成功,会话写入 ' + AUTH);
  await logAuthStorageDiag(page, '新登录');

  // 不信任 URL 跳转，直接拿 /api/client/account 验证这个会话对 API 到底是不是真的已鉴权
  const verify = await api(page, '/api/client/account').catch((e) => ({ status: 0, data: { error: e.message } }));
  log('登录后直接验证 /api/client/account: HTTP ' + verify.status + ' ' + JSON.stringify(verify.data).slice(0, 300));
}

function formatRemaining(expiresAt) {
  if (!expiresAt) return null;
  const target = new Date(expiresAt).getTime();
  const diff = target - Date.now();
  if (isNaN(diff)) return null;
  if (diff <= 0) return '已到期 (可立即续期)';
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const expStr = new Date(target).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return d + '天' + h + '小时 (到期: ' + expStr + ')';
}

async function discover(page) {
  const map = new Map();
  const addServer = (s) => {
    if (!s || !s.id) return;
    const id = String(s.id).trim();
    if (!id || id === 'undefined' || id === 'null') return;
    const existing = map.get(id) || {};
    map.set(id, {
      id,
      uuid: s.uuid || existing.uuid || id,
      name: s.name && s.name !== id ? s.name : existing.name || id,
      expiresAt: s.expiresAt || existing.expiresAt || null,
      canRenew: Boolean(s.canRenew || existing.canRenew),
    });
  };

  if (SERVER_ID) {
    addServer({ id: SERVER_ID, uuid: SERVER_ID, name: SERVER_ID });
  }

  // 途径 1: 扫描 /dashboard 首页的 "Upcoming renewals" 表格 (对应 ID: 39326029, Model: Cibsapoas)
  if (!page.url().includes('/dashboard')) {
    await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await page.waitForTimeout(1500);

  const dashboardItems = await page
    .evaluate(() => {
      const results = [];
      document.querySelectorAll('table tbody tr, tr').forEach((tr) => {
        const tds = [...tr.querySelectorAll('td')];
        if (tds.length >= 2) {
          const idText = (tds[0].innerText || '').trim();
          if (/^[a-z0-9_-]{4,20}$/i.test(idText) && !/^id$/i.test(idText)) {
            const modelLines = (tds[1].innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
            const name = modelLines[0] || idText;
            const rowText = (tr.innerText || '').trim();
            const canRenew = /Available:\s*Now|Renew|Renouveler/i.test(rowText);
            results.push({ id: idText, name, canRenew });
          }
        }
      });
      return results;
    })
    .catch(() => []);

  for (const item of dashboardItems) {
    addServer(item);
  }

  // 途径 2: /api/client
  const r1 = await api(page, '/api/client');
  if (r1.status === 200) {
    const list = Array.isArray(r1.data?.data) ? r1.data.data : Array.isArray(r1.data?.servers) ? r1.data.servers : [];
    for (const item of list) {
      const attr = item.attributes || item;
      const id = attr.identifier || attr.server_identifier || attr.id || attr.uuid;
      if (id) {
        addServer({
          id,
          uuid: attr.uuid || id,
          name: attr.name || attr.project_name || String(id),
          expiresAt: attr.expires_at || attr.renews_at || null,
          canRenew: Boolean(attr.can_renew),
        });
      }
    }
  }

  // 途径 3: /api/client/credits/subscriptions
  const r2 = await api(page, '/api/client/credits/subscriptions');
  if (r2.status === 200) {
    const rawList = Array.isArray(r2.data?.data)
      ? r2.data.data
      : Array.isArray(r2.data?.subscriptions)
      ? r2.data.subscriptions
      : Array.isArray(r2.data)
      ? r2.data
      : [];
    for (const item of rawList) {
      const attr = item.attributes || item.server || item;
      const id =
        attr.server_identifier ||
        attr.identifier ||
        attr.server_id ||
        item.server_identifier ||
        item.identifier ||
        attr.id;
      if (id) {
        addServer({
          id,
          uuid: attr.uuid || id,
          name: attr.name || attr.server_name || item.name || String(id),
          expiresAt: attr.expires_at || item.expires_at || attr.renews_at || null,
          canRenew: Boolean(attr.can_renew ?? item.can_renew),
        });
      }
    }
  }

  // 途径 4: 扫描 /dashboard/projects 页面 DOM 属性与链接
  await page.goto(BASE + '/dashboard/projects', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);

  const domIds = await page
    .evaluate(() => {
      const found = [];
      document.querySelectorAll('[data-server-id], [data-server], [data-identifier]').forEach((el) => {
        const val =
          el.getAttribute('data-server-id') ||
          el.getAttribute('data-server') ||
          el.getAttribute('data-identifier');
        if (val) found.push(val.trim());
      });
      document.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/(?:server|servers|projects)\/([a-z0-9]{6,16})(?:\/|$|\?)/i);
        if (m && !['create', 'new', 'deploy'].includes(m[1].toLowerCase())) {
          found.push(m[1]);
        }
      });
      const html = document.documentElement.innerHTML;
      const regex = /"identifier"\s*:\s*"([a-z0-9]{6,16})"/gi;
      let match;
      while ((match = regex.exec(html)) !== null) {
        found.push(match[1]);
      }
      return [...new Set(found)];
    })
    .catch(() => []);

  for (const id of domIds) {
    if (!map.has(id)) {
      addServer({ id, uuid: id, name: id });
    }
  }

  let servers = [...map.values()];
  if (SERVER_ID) {
    const matched = servers.filter((s) => s.id === SERVER_ID || s.uuid === SERVER_ID);
    if (matched.length > 0) servers = matched;
  }

  if (!servers.length) {
    // 未发现任何服务时，落盘当前页面 HTML 以便排查抓取/选择器是否失效
    try {
      const html = await page.content();
      fs.writeFileSync(path.join(SHOT, 'dashboard-debug.html'), html);
      log('未发现任何服务，已保存页面 HTML 至 shots/dashboard-debug.html 以便排查');
    } catch (e) {
      log('保存调试 HTML 失败: ' + e.message);
    }
    if (!SERVER_ID) {
      log('提示: 未设置 ACL_SERVER_ID，且自动抓取未发现任何服务 - 请在仓库 Secrets 中设置 ACL_SERVER_ID');
    }
  }

  const serverLogStr = servers
    .map((s) => {
      const exp = s.expiresAt ? s.expiresAt : s.canRenew ? '现在可续期' : '未知';
      return s.name + '(' + s.id + ') 状态:' + exp;
    })
    .join(', ');
  log('发现服务: ' + (serverLogStr ? serverLogStr : '(无)'));
  return servers;
}

function classifyRenew(r) {
  if (r.status === 200) {
    const exp = r.data?.expires_at ? ' (到期: ' + r.data.expires_at + ')' : '';
    const msg = r.data?.message ? r.data.message : JSON.stringify(r.data).slice(0, 120);
    return {
      ok: true,
      skip: false,
      captcha: false,
      text: '续期成功' + exp + ' ' + msg,
    };
  }
  const blob = JSON.stringify(r.data || {});
  if (
    r.status === 400 &&
    (r.data?.error === 'renewal_not_available' ||
      r.data?.code === 'renewal_not_available' ||
      /renewal_not_available|not_available|pas encore disponible/i.test(blob))
  ) {
    const rem = r.data?.days_remaining ?? r.data?.hours_remaining ?? '?';
    return {
      ok: true,
      skip: true,
      captcha: false,
      text: '未到续期窗口 剩余 ' + rem + ' 天/小时',
    };
  }
  if ((r.status === 403 || r.status === 400 || r.status === 422) && /captcha_required|captcha/i.test(blob)) {
    return { ok: false, skip: false, captcha: true, text: 'HTTP ' + r.status + ' captcha_required' };
  }
  if (r.status === 401) {
    return {
      ok: false,
      skip: false,
      captcha: false,
      text: 'HTTP 401 鉴权失败 - 页面会话对该 API 无效,可能需要单独的 Token (详见上方 "API 401 诊断" 日志)',
    };
  }
  return { ok: false, skip: false, captcha: false, text: 'HTTP ' + r.status + ' ' + blob.slice(0, 180) };
}

function looksLikeRenewAction(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return false;
  if (s.includes('?') || s.includes('renewal') || s.includes('renouvellement')) return false;
  if (s.length > 90) return false;
  return /\brenew\b/.test(s) || /\brenouveler\b/.test(s) || /\bextend\b/.test(s) || /续期|延长/.test(s);
}

async function findVisibleRenewButton(page, server) {
  const locator = page.locator('button, a, [role="button"]');
  const count = await locator.count();
  const scored = [];

  for (let i = 0; i < count; i++) {
    const item = locator.nth(i);
    const info = await item
      .evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const text = [
          el.innerText,
          el.textContent,
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.getAttribute('value'),
        ]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        const card = el.closest(
          '[data-server], [data-server-id], article, li, tr, .card, .client-card, .server, .project'
        );
        const cardText = (card?.innerText || card?.textContent || '').replace(/\s+/g, ' ').trim();
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
        const busy = el.getAttribute('aria-busy') === 'true';
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          style.opacity !== '0';
        return { text, cardText, disabled, busy, visible, top: rect.top, left: rect.left };
      })
      .catch(() => null);

    if (!info || !looksLikeRenewAction(info.text) || info.disabled || info.busy || !info.visible) continue;

    const haystack = (info.cardText + ' ' + info.text).toLowerCase();
    let s = 100;
    if (server?.id && haystack.includes(String(server.id).toLowerCase())) s += 50;
    if (server?.uuid && haystack.includes(String(server.uuid).toLowerCase())) s += 40;
    if (server?.name && haystack.includes(String(server.name).toLowerCase())) s += 30;
    if (/^\s*(renew|renouveler|extend|续期|延长)\s*$/i.test(info.text)) s += 20;
    s -= Math.max(0, info.top) / 1000;
    scored.push({ item, info, score: s });
  }

  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  log('选择可见续期按钮: ' + JSON.stringify(scored[0].info.text).slice(0, 120));
  return scored[0].item;
}

async function clickRenewUiOnPage(page, url, server) {
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const btn = await findVisibleRenewButton(page, server);
  if (!btn) return false;
  await btn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await btn.click({ timeout: 8000 });
  await page.waitForTimeout(2000);
  return true;
}

async function tryRenew(page, server) {
  const id = server.id;
  const name = server.name || id;
  log('开始检查续期: ' + name + ' (' + id + ')');

  if (DRY_RUN) return { id, ok: true, skip: true, text: '[DRY_RUN] ' + name + ' (' + id + ') 跳过实际提交' };

  let uiRenewRes = null;
  const responseHandler = async (res) => {
    const u = res.url();
    if ((u.includes('/renew') || u.includes('/upgrade')) && res.request().method() === 'POST') {
      try {
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        uiRenewRes = { status: res.status(), data };
      } catch {}
    }
  };
  page.on('response', responseHandler);

  try {
    let clicked = await clickRenewUiOnPage(page, BASE + '/dashboard', server);
    if (!clicked) {
      clicked = await clickRenewUiOnPage(page, BASE + '/dashboard/projects', server);
    }

    if (clicked) {
      log('已点击可见 UI 续期按钮,等待结果...');

      const modal = page.locator("[role='dialog'], .modal, .dialog");
      if ((await modal.count()) > 0 && (await modal.first().isVisible().catch(() => false))) {
        log('检测到防机器人人机验证弹窗,开始过盾...');
        try {
          await solveCaptcha(page, "[role='dialog']", 'renewal_gate');
          const confirmBtn = modal
            .locator("button[type='submit'], button:has-text('Renew'), button:has-text('Renouveler'), button:has-text('Confirm'), button:has-text('Valider')")
            .first();
          if ((await confirmBtn.count()) > 0) {
            await confirmBtn
              .evaluate((el) => {
                el.removeAttribute('disabled');
                el.disabled = false;
                el.click();
              })
              .catch(() => {});
          }
          await page.waitForTimeout(3500);
        } catch (e) {
          log('弹窗验证码处理异常: ' + e.message);
        }
      }

      if (uiRenewRes) {
        const c = classifyRenew(uiRenewRes);
        if (c.ok) {
          log('UI 触发 API 响应成功: ' + c.text);
          return { id, ok: true, skip: c.skip, text: name + ' (' + id + '): ' + c.text };
        }
      }

      const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (
        /Expire dans\s+[2-9]j/i.test(bodyText) ||
        /renouvellement sera disponible/i.test(bodyText) ||
        /renewed successfully|renewal successful/i.test(bodyText)
      ) {
        const match = bodyText.match(/Expire dans\s+([0-9]+j(?:\s+[0-9]+h)?)/i);
        const exp = match ? '剩余 ' + match[1] : '成功延期';
        log('UI 续期验证成功: ' + exp);
        return { id, ok: true, skip: false, text: name + ' (' + id + '): 续期成功 (' + exp + ')' };
      }
      log('UI 点击后未确认续期成功,继续尝试 API 续期接口');
    }
  } catch (e) {
    log('UI 续期按钮点击失败,改走 API 续期: ' + e.message);
    await shot(page, 'ui-click-fallback-' + id + '.png').catch(() => {});
  } finally {
    page.off('response', responseHandler);
  }

  log('尝试 API 续期接口...');
  const candidatePaths = [
    '/api/client/servers/' + id + '/upgrade/renew',
    '/api/client/projects/' + id + '/renew',
    '/api/client/credits/subscriptions/' + id + '/renew',
    '/dashboard/projects/' + id + '/renew',
  ];

  let r = { status: 404, data: {} };
  let activePath = candidatePaths[0];

  for (const p of candidatePaths) {
    const res = await api(page, p, 'POST', {});
    if (res.status === 401 && res.diag) {
      log(
        'API 401 诊断[' + p + ']: cookie=[' + res.diag.cookieNames.join(',') +
          '] localStorage=[' + res.diag.localStorageKeys.join(',') +
          '] sessionStorage=[' + res.diag.sessionStorageKeys.join(',') +
          '] 已尝试的Token字段=' + (res.diag.usedBearerKey || '无')
      );
    }
    if (res.status !== 404) {
      r = res;
      activePath = p;
      break;
    }
  }

  let c = classifyRenew(r);

  if (c.captcha) {
    log('检测到 captcha_required,获取 renewal_gate 验证码凭据...');
    try {
      let token;
      try {
        token = await solveCaptchaApi(page, 'renewal_gate');
      } catch (errGate) {
        log('renewal_gate 获取失败(' + errGate.message + '),尝试 login 上下文...');
        token = await solveCaptchaApi(page, 'login');
      }
      r = await api(
        page,
        activePath,
        'POST',
        { captcha_token: token, captcha: token, token },
        { 'X-Captcha-Token': token }
      );
      c = classifyRenew(r);
    } catch (e) {
      c = { ok: false, skip: false, captcha: false, text: '验证码求解失败: ' + e.message };
    }
  }

  let resultText = name + ' (' + id + '): ' + c.text;
  const exactRemaining = formatRemaining(server.expiresAt);
  if (c.skip && exactRemaining) {
    resultText = name + ' (' + id + '): 未到续期窗口，剩余 ' + exactRemaining;
  }

  log('API 续期结果: ' + resultText);
  return { id, ok: c.ok, skip: c.skip, text: resultText };
}

function resolveExecutablePath() {
  const paths = [
    process.env.CHROME_PATH,
    'D:\\PlaywrightBrowsers\\chromium-1217\\chrome-win64\\chrome.exe',
  ].filter(Boolean);
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

async function main() {
  if (!USER || !PASS) throw new Error('缺少 ACL_USERNAME / ACL_PASSWORD 环境变量');
  const execPath = resolveExecutablePath();
  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    ...(execPath ? { executablePath: execPath } : {}),
  };
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    storageState: fs.existsSync(AUTH) ? AUTH : undefined,
  });
  const page = await context.newPage();
  let summary = '';
  let failed = false;
  const results = [];

  try {
    await login(page);
    await shot(page, '03-dashboard.png');

    const servers = await discover(page);
    await shot(page, '04-projects.png');

    for (const server of servers) {
      const res = await tryRenew(page, server);
      results.push(res);
    }

    if (!results.length) {
      failed = true;
      summary = '未找到可续期服务 (请检查账号下是否有活跃服务或设置 ACL_SERVER_ID)';
    } else {
      summary = results.map((r) => r.text).join('\n');
      failed = results.some((r) => !r.ok);
    }

    const hasRenewed = results.some((r) => r.ok && !r.skip);
    if (hasRenewed) {
      await shot(page, '06-result.png');
    }
    if (failed) {
      await shot(page, '99-error.png');
    }
  } catch (e) {
    failed = true;
    summary = '执行失败: ' + e.message;
    log(summary);
    await shot(page, '99-error.png');
  } finally {
    await browser.close().catch(() => {});
  }
  log(summary);

  let photoToSend = null;
  if (failed) {
    const errPic = path.join(SHOT, '99-error.png');
    if (fs.existsSync(errPic)) photoToSend = errPic;
  } else if (results.some((r) => r.ok && !r.skip)) {
    const donePic = path.join(SHOT, '06-result.png');
    if (fs.existsSync(donePic)) photoToSend = donePic;
  }

  const tgMessage = formatTgMessage({
    failed,
    results,
    errorMsg: failed && !results.length ? summary : '',
  });

  await tg(tgMessage, { photo: photoToSend });
  if (failed) process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(async (e) => {
    log(e.stack || e.message);
    const failPic = path.join(SHOT, '99-error.png');
    const tgMessage = formatTgMessage({
      failed: true,
      results: [],
      errorMsg: e.message,
    });
    await tg(tgMessage, { photo: fs.existsSync(failPic) ? failPic : null });
    process.exit(1);
  });
}

export { score, ocrScore, classifyRenew };
