const { connect } = require('puppeteer-real-browser');
const axios = require('axios');

const CONSOLE_URL = process.env.CONSOLE_URL || 'https://control.gaming4free.net/server/ad2c636e/console';
const COOKIE_XSRF = process.env.COOKIE_XSRF;
const COOKIE_SESSION = process.env.COOKIE_SESSION;

// 自动清洗 Cookie 数据的安全过滤函数
function cleanCookieValue(rawInput, cookieName) {
    if (!rawInput) return '';
    let cleaned = rawInput.trim();
    
    // 如果不小心复制了 "Set-Cookie:" 开头，将其切除
    if (cleaned.toLowerCase().startsWith('set-cookie:')) {
        cleaned = cleaned.substring(11).trim();
    }
    
    // 如果包含等号，尝试提取指定名称对应的 Value 值
    if (cleaned.includes('=')) {
        const parts = cleaned.split(';');
        for (let part of parts) {
            part = part.trim();
            if (part.startsWith(cookieName + '=')) {
                return part.substring(cookieName.length + 1);
            }
        }
        // 如果没有分号但有等号，判断是否是单纯的 "NAME=VALUE" 形式
        const eqIndex = cleaned.indexOf('=');
        const key = cleaned.substring(0, eqIndex).trim();
        if (key.toLowerCase() === cookieName.toLowerCase()) {
            return cleaned.substring(eqIndex + 1).trim();
        }
    }
    
    // 移除尾部可能带有的分号
    if (cleaned.endsWith(';')) {
        cleaned = cleaned.slice(0, -1);
    }
    
    return cleaned;
}

async function sendTelegramNotification(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        console.log("Telegram credentials missing, skipping notification.");
        return;
    }
    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: message
        });
        console.log("Telegram notification sent successfully.");
    } catch (error) {
        console.error("Failed to send Telegram notification:", error.message);
    }
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    if (!COOKIE_XSRF || !COOKIE_SESSION) {
        console.error("Missing cookies in environment variables!");
        await sendTelegramNotification("❌ Cookie setup is incomplete or missing in GitHub Secrets.");
        process.exit(1);
    }

    console.log("Initializing puppeteer-real-browser with local SOCKS5 proxy...");
    
    let browser, page;
    try {
        const response = await connect({
            headless: false,
            turnstile: true, // 启用内置 Turnstile 自动绕过功能
            disableXvfb: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--proxy-server=socks5://127.0.0.1:10808' // 使用 xray 本地代理
            ]
        });
        browser = response.browser;
        page = response.page;
    } catch (error) {
        console.error("Failed to launch browser:", error);
        await sendTelegramNotification(`❌ Failed to start automation browser: ${error.message}`);
        process.exit(1);
    }

    try {
        // 清洗并提取纯净的 Cookie 值
        const xsrfValue = cleanCookieValue(COOKIE_XSRF, 'XSRF-TOKEN');
        const sessionValue = cleanCookieValue(COOKIE_SESSION, 'pelican_session');

        console.log(`Setting session cookies... (XSRF Length: ${xsrfValue.length}, Session Length: ${sessionValue.length})`);
        
        // 逐个设置 Cookie 避免格式冲突
        await page.setCookie({
            name: 'XSRF-TOKEN',
            value: xsrfValue,
            domain: 'control.gaming4free.net',
            path: '/',
            secure: true,
            httpOnly: false
        });

        await page.setCookie({
            name: 'pelican_session',
            value: sessionValue,
            domain: 'control.gaming4free.net',
            path: '/',
            secure: true,
            httpOnly: true
        });

        console.log(`Navigating to console URL: ${CONSOLE_URL}`);
        await page.goto(CONSOLE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await sleep(5000);

        // 检测是否成功登录
        const pageContent = await page.content();
        if (pageContent.includes('login') || pageContent.includes('Sign In') || !pageContent.includes('container@pterodactyl')) {
            console.log("Session might be expired or cookies are invalid.");
            await sendTelegramNotification("⚠️ [Gaming4Free] Cookie 已过期或失效！请更新您的 GitHub Secrets 配置。");
            await browser.close();
            process.exit(0); 
        }

        console.log("Successfully logged in. Scanning for renewal button...");

        // 寻找匹配“+ 90 min”等字样的按钮
        const elements = await page.$$('button, span, div, a');
        let targetElement = null;
        for (const el of elements) {
            const text = await page.evaluate(node => node.textContent, el);
            if (
                text.includes('+ 90 min') || 
                text.includes('+90 min') || 
                text.includes('watch ad · +90 min') || 
                text.includes('+ top up 100h')
            ) {
                targetElement = el;
                break;
            }
        }

        if (!targetElement) {
            console.log("Could not find the renewal button. Checking if it is currently in CD...");
            if (pageContent.includes('cd')) {
                console.log("The renewal is currently on cooldown.");
            } else {
                console.log("Renewal button is missing for an unknown reason.");
            }
            await browser.close();
            return;
        }

        console.log("Renewal button found. Clicking to trigger Turnstile...");
        await targetElement.click();
        
        console.log("Waiting 20 seconds for Turnstile verification to auto-solve...");
        await sleep(20000);

        // 截图保存
        await page.screenshot({ path: 'verification_result.png' });
        console.log("Screenshot saved as verification_result.png");

        // 验证剩余时间
        const updatedContent = await page.evaluate(() => document.body.innerText);
        const match = updatedContent.match(/(\d{2}:\d{2}:\d{2})\s*remaining/);
        if (match) {
            console.log(`Successfully completed! Detected remaining session time: ${match[1]}`);
        } else {
            console.log("Successfully triggered renewal click. (Remaining time element not immediately found)");
        }

    } catch (error) {
        console.error("An error occurred during execution:", error);
        await sendTelegramNotification(`❌ Renewal workflow encountered an error: ${error.message}`);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

main();
