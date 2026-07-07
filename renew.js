const { connect } = require('puppeteer-real-browser');
const axios = require('axios');

const CONSOLE_URL = process.env.CONSOLE_URL || 'https://control.gaming4free.net/server/ad2c636e/console';
const COOKIE_XSRF = process.env.COOKIE_XSRF;
const COOKIE_SESSION = process.env.COOKIE_SESSION;

// 提取纯净 Cookie 的安全清洗函数
function cleanCookieValue(rawInput, cookieName) {
    if (!rawInput) return '';
    let cleaned = rawInput.trim();
    if (cleaned.toLowerCase().startsWith('set-cookie:')) {
        cleaned = cleaned.substring(11).trim();
    }
    if (cleaned.includes('=')) {
        const parts = cleaned.split(';');
        for (let part of parts) {
            part = part.trim();
            if (part.startsWith(cookieName + '=')) {
                return part.substring(cookieName.length + 1);
            }
        }
        const eqIndex = cleaned.indexOf('=');
        const key = cleaned.substring(0, eqIndex).trim();
        if (key.toLowerCase() === cookieName.toLowerCase()) {
            return cleaned.substring(eqIndex + 1).trim();
        }
    }
    if (cleaned.endsWith(';')) {
        cleaned = cleaned.slice(0, -1);
    }
    return cleaned;
}

// 提取页面上的“剩余时间”数据
async function getRemainingTime(page) {
    try {
        const content = await page.evaluate(() => document.body.innerText);
        const match = content.match(/(\d{2}:\d{2}:\d{2})\s*remaining/);
        return match ? match[1] : null;
    } catch (e) {
        return null;
    }
}

// 将 "HH:MM:SS" 时间字符串转换为总秒数以便对比
function timeStringToSeconds(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.split(':').map(Number);
    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 0;
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
            turnstile: true, // 开启自动绕过
            disableXvfb: false,
            connectOption: {
                defaultViewport: null
            },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--proxy-server=socks5://127.0.0.1:10808',
                '--window-size=1280,1200'
            ]
        });
        browser = response.browser;
        page = response.page;

        await page.setViewport({ width: 1280, height: 1200 });

    } catch (error) {
        console.error("Failed to launch browser:", error);
        await sendTelegramNotification(`❌ Failed to start automation browser: ${error.message}`);
        process.exit(1);
    }

    try {
        const xsrfValue = cleanCookieValue(COOKIE_XSRF, 'XSRF-TOKEN');
        const sessionValue = cleanCookieValue(COOKIE_SESSION, 'pelican_session');

        console.log(`Setting session cookies... (XSRF Length: ${xsrfValue.length}, Session Length: ${sessionValue.length})`);
        
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

        // 验证状态
        const currentUrl = page.url();
        console.log(`Current page URL: ${currentUrl}`);

        if (currentUrl.includes('/auth/login') || currentUrl.includes('/login') || !currentUrl.includes('/server/')) {
            console.log("Detected redirection to login page or failed to load the server page. Session is expired.");
            await sendTelegramNotification("⚠️ [Gaming4Free] Cookie 已过期或失效！请重新获取并更新您的 GitHub Secrets 配置。");
            await browser.close();
            process.exit(0); 
        }

        console.log("Successfully logged in!");

        // 1. 获取点击前的剩余时间
        const timeBefore = await getRemainingTime(page);
        console.log(`[Timer] Remaining time BEFORE click: ${timeBefore}`);

        // 2. 扫描包含文本的活动元素
        const elements = await page.$$('button, span, div, a');
        let targetElement = null;
        for (const el of elements) {
            const isVisible = await page.evaluate(node => {
                if (!node) return false;
                const style = window.getComputedStyle(node);
                return style.display !== 'none' && style.visibility !== 'hidden' && node.offsetWidth > 0 && node.offsetHeight > 0;
            }, el);

            if (isVisible) {
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
        }

        const pageContent = await page.content();
        if (!targetElement) {
            console.log("Could not find any active/visible renewal button. Checking if it is currently on CD...");
            if (pageContent.includes('cd')) {
                console.log("The renewal is currently on cooldown (CD). Skipping.");
            } else {
                console.log("Renewal button is missing for an unknown reason.");
            }
            await page.screenshot({ path: '1_before_click.png' });
            await browser.close();
            return;
        }

        // 3. 智能寻找父级点击对象：如果是 span/div 等文本标签，自动提取最近的外层真实 button 标签
        let clickableElement = targetElement;
        const tagName = await page.evaluate(el => el.tagName.toLowerCase(), targetElement);
        if (tagName !== 'button' && tagName !== 'a') {
            const parentButton = await page.evaluateHandle(el => el.closest('button, a'), targetElement);
            if (parentButton && await page.evaluate(el => el !== null, parentButton)) {
                clickableElement = parentButton;
                console.log("Successfully matched and extracted parent clickable <button> element wrapper.");
            }
        }

        console.log("Scrolling button into view...");
        await page.evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'center' }), clickableElement);
        await sleep(2000);

        // 🌟 阶段 1 截图：点击之前的初始状态
        await page.screenshot({ path: '1_before_click.png' });
        console.log("Saved screenshot: 1_before_click.png");

        console.log("Clicking the main button...");
        await clickableElement.click();
        
        // 🌟 阶段 2 截图：点击 3 秒后（验证码弹窗出现的瞬间）
        await sleep(3000);
        await page.screenshot({ path: '2_after_click.png' });
        console.log("Saved screenshot: 2_after_click.png");

        console.log("Waiting 20 seconds for Turnstile verification to auto-solve...");
        await sleep(20000);

        // 🌟 阶段 3 截图：最终过检后的界面状态
        await page.screenshot({ path: '3_final_result.png' });
        console.log("Saved screenshot: 3_final_result.png");

        // 4. 获取点击后的剩余时间并对比
        const timeAfter = await getRemainingTime(page);
        console.log(`[Timer] Remaining time AFTER click: ${timeAfter}`);

        const secsBefore = timeStringToSeconds(timeBefore);
        const secsAfter = timeStringToSeconds(timeAfter);

        if (secsBefore > 0 && secsAfter > 0) {
            if (secsAfter > secsBefore + 600) {
                console.log(`🎉 Success! Time increased from ${timeBefore} to ${timeAfter}.`);
            } else {
                console.log(`⚠️ Warning: Time did NOT increase. (Before: ${timeBefore} -> After: ${timeAfter}).`);
                await sendTelegramNotification(`⚠️ [Gaming4Free] 续期未成功：请下载 Action 的 Artifacts 里的 debug-screenshots.zip 解压，核对点击和验证过程。`);
            }
        } else {
            console.log("Failed to parse remaining time. Skipping delta verification.");
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
