const { connect } = require('puppeteer-real-browser');
const axios = require('axios');

const CONSOLE_URL = process.env.CONSOLE_URL || 'https://control.gaming4free.net/server/ad2c636e/console';
const COOKIE_XSRF = process.env.COOKIE_XSRF;
const COOKIE_SESSION = process.env.COOKIE_SESSION;

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
            turnstile: true, // 启用内置 Turnstile 自动检测与解决功能
            disableXvfb: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--proxy-server=socks5://127.0.0.1:10808' // 强制作业流通过 xray 本地代理
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
        console.log("Setting session cookies...");
        await page.setCookie(
            {
                name: 'XSRF-TOKEN',
                value: COOKIE_XSRF,
                domain: 'control.gaming4free.net',
                path: '/',
                secure: true,
                httpOnly: false
            },
            {
                name: 'pelican_session',
                value: COOKIE_SESSION,
                domain: 'control.gaming4free.net',
                path: '/',
                secure: true,
                httpOnly: true
            }
        );

        console.log(`Navigating to console URL: ${CONSOLE_URL}`);
        await page.goto(CONSOLE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await sleep(5000);

        // 检测是否成功登录
        const pageContent = await page.content();
        if (pageContent.includes('login') || pageContent.includes('Sign In') || !pageContent.includes('container@pterodactyl')) {
            console.log("Session might be expired or cookies are invalid.");
            await sendTelegramNotification("⚠️ [Gaming4Free] Cookie 已过期或失效！请更新您的 GitHub Secrets 配置。");
            await browser.close();
            process.exit(0); // 安全退出，不导致工作流直接标记为红色错误
        }

        console.log("Successfully logged in. Scanning for renewal button...");

        // 在页面中寻找匹配“+ 90 min”、“watch ad”、“+ top up 100h”文字的按钮
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
        
        // 留出时间给 puppeteer-real-browser 框架自动勾选并过检 Cloudflare Turnstile
        console.log("Waiting 20 seconds for Turnstile verification to auto-solve...");
        await sleep(20000);

        // 截图保存为 artifact 方便排查
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
