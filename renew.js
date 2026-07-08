const { connect } = require('puppeteer-real-browser');
const axios = require('axios');
const fs = require('fs');

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
    let xsrfValue = '';
    let sessionValue = '';

    // 优先从本地 cookies.json 加载
    if (fs.existsSync('cookies.json')) {
        try {
            const saved = JSON.parse(fs.readFileSync('cookies.json', 'utf-8'));
            xsrfValue = saved.xsrf;
            sessionValue = saved.session;
            console.log("Successfully loaded cookies from local cookies.json");
        } catch (e) {
            console.log("Failed to parse local cookies.json, fallback to env variables.");
        }
    }

    // 如果本地没有或读取失败，则使用环境变量（Secrets）
    if (!xsrfValue || !sessionValue) {
        if (!COOKIE_XSRF || !COOKIE_SESSION) {
            console.error("Missing cookies in environment variables!");
            await sendTelegramNotification("❌ Cookie setup is incomplete or missing in GitHub Secrets.");
            process.exit(1);
        }
        xsrfValue = cleanCookieValue(COOKIE_XSRF, 'XSRF-TOKEN');
        sessionValue = cleanCookieValue(COOKIE_SESSION, 'pelican_session');
        console.log("Using initial cookies from environment variables.");
    }

    console.log("Initializing puppeteer-real-browser with local SOCKS5 proxy...");
    
    let browser, page;
    try {
        const response = await connect({
            headless: false,
            turnstile: true,
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

        const currentUrl = page.url();
        console.log(`Current page URL: ${currentUrl}`);

        if (currentUrl.includes('/auth/login') || currentUrl.includes('/login') || !currentUrl.includes('/server/')) {
            console.log("Detected redirection to login page. Session is expired.");
            await sendTelegramNotification("⚠️ [Gaming4Free] Cookie 已过期或失效！请重新获取并更新您的 GitHub Secrets 配置。");
            await browser.close();
            process.exit(0); 
        }

        console.log("Successfully logged in!");

        const timeBefore = await getRemainingTime(page);
        console.log(`[Timer] Remaining time BEFORE click: ${timeBefore}`);

        const elements = await page.$$('button, span, a');
        let targetElement = null;
        for (const el of elements) {
            const isVisible = await page.evaluate(node => {
                if (!node) return false;
                const style = window.getComputedStyle(node);
                return style.display !== 'none' && style.visibility !== 'hidden' && node.offsetWidth > 0 && node.offsetHeight > 0;
            }, el);

            if (isVisible) {
                const rawText = await page.evaluate(node => node.textContent, el);
                const text = rawText.replace(/\s+/g, ' ').trim().toLowerCase();
                
                if (
                    text.includes('+ 90 min') || 
                    text.includes('+90 min') || 
                    text.includes('watch ad') || 
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

        const targetHtml = await page.evaluate(el => el.outerHTML, targetElement);
        console.log(`[Debug] Matched Target Element HTML: ${targetHtml}`);

        let clickableElement = targetElement;
        const tagName = await page.evaluate(el => el.tagName.toLowerCase(), targetElement);
        if (tagName !== 'button' && tagName !== 'a') {
            const parentButton = await page.evaluateHandle(el => el.closest('button, a'), targetElement);
            const hasParent = await page.evaluate(el => el !== null, parentButton);
            if (hasParent) {
                clickableElement = parentButton;
                const clickableHtml = await page.evaluate(el => el.outerHTML, clickableElement);
                console.log(`[Debug] Using parent clickable wrapper: ${clickableHtml}`);
            } else {
                console.log("[Debug] No parent <button> or <a> found, will click target directly.");
            }
        }

        console.log("Scrolling button into view...");
        await page.evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'center' }), clickableElement);
        await sleep(2000);

        await page.screenshot({ path: '1_before_click.png' });
        console.log("Saved screenshot: 1_before_click.png");

        const box = await clickableElement.boundingBox();
        if (box) {
            console.log(`[Debug] Bounding box found: x=${box.x}, y=${box.y}, w=${box.width}, h=${box.height}`);
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await sleep(500);
            await page.mouse.down();
            await sleep(100);
            await page.mouse.up();
            console.log("High-fidelity human mouse click complete.");
        } else {
            console.log("[Debug] Bounding box not found, falling back to Puppeteer click.");
            await clickableElement.click();
        }
        
        await sleep(3000);
        await page.screenshot({ path: '2_after_click.png' });
        console.log("Saved screenshot: 2_after_click.png");

        // 🌟 5. 广告弹窗监听与关闭逻辑 (重构核心)
        console.log("Detecting ad modal and waiting for rewards...");
        let modalDetected = false;
        
        for (let i = 0; i < 10; i++) {
            const hasModalText = await page.evaluate(() => {
                const text = document.body.innerText.toLowerCase();
                return text.includes('reward') || text.includes('seconds until') || text.includes('until reward');
            });
            if (hasModalText) {
                modalDetected = true;
                console.log("Ad modal detected successfully.");
                break;
            }
            await sleep(1000);
        }

        if (modalDetected) {
            console.log("Waiting for 'Reward Granted' status...");
            let rewardGranted = false;
            
            for (let i = 0; i < 45; i++) {
                const isGranted = await page.evaluate(() => {
                    const text = document.body.innerText;
                    return text.includes('Reward Granted');
                });
                if (isGranted) {
                    rewardGranted = true;
                    console.log("✨ 'Reward Granted' detected!");
                    break;
                }
                await sleep(1000);
            }

            if (rewardGranted) {
                await sleep(2000); // 留出充足渲染时间
                
                console.log("Attempting to close the ad modal...");
                
                // [优化 A] 精准定位关闭按钮，剔除视频内部控制元素的影响
                const closeResult = await page.evaluate(() => {
                    function findCloseElement() {
                        // 1. 寻找 "Reward Granted" 元素作为锚点
                        const anchor = Array.from(document.querySelectorAll('*')).find(el => {
                            return el.textContent && el.textContent.includes('Reward Granted') && el.offsetWidth > 0;
                        });
                        
                        if (anchor) {
                            let parent = anchor.parentElement;
                            // 往上找 4 层寻找包含整个顶部 Header 控制条的节点
                            for (let i = 0; i < 4; i++) {
                                if (!parent) break;
                                
                                // 查找该顶栏中的点击元素（排除视频播放器/控制台本身的 class）
                                const candidates = parent.querySelectorAll('[class*="close" i], button, svg, [role="button"]');
                                for (const candidate of candidates) {
                                    // 排除视频播放器内部控制类的干扰按钮（防止误点静音/暂停）
                                    if (candidate.closest('.vjs-control-bar, .video-player, [class*="video" i], [class*="player" i]')) {
                                        continue;
                                    }
                                    if (candidate !== anchor && !anchor.contains(candidate) && candidate.offsetWidth > 0) {
                                        return candidate;
                                    }
                                }
                                parent = parent.parentElement;
                            }
                        }

                        // 2. 备选方案：全局查找带有 "close" 属性或 "X" 文字的显式按钮
                        const commonSelectors = ['[class*="close" i]', '[aria-label*="close" i]', 'button'];
                        for (const selector of commonSelectors) {
                            const elements = document.querySelectorAll(selector);
                            for (const el of elements) {
                                if (el.closest('.vjs-control-bar, .video-player, [class*="video" i], [class*="player" i]')) {
                                    continue; // 依旧剔除视频内部元素
                                }
                                if (el.offsetWidth > 0 && el.offsetHeight > 0) {
                                    const text = (el.textContent || '').trim();
                                    if (text === '×' || text.toLowerCase() === 'x') {
                                        return el;
                                    }
                                }
                            }
                        }
                        return null;
                    }

                    const closeEl = findCloseElement();
                    if (closeEl) {
                        closeEl.scrollIntoView({ behavior: 'instant', block: 'center' });
                        if (typeof closeEl.click === 'function') {
                            closeEl.click();
                            return { success: true, elementHtml: closeEl.outerHTML || 'SVG/Path' };
                        } else {
                            const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
                            closeEl.dispatchEvent(ev);
                            return { success: true, elementHtml: 'Dispatched Event' };
                        }
                    }
                    return { success: false };
                });

                console.log(`Close button click attempt result: ${JSON.stringify(closeResult)}`);
                await sleep(2000);

                // [优化 B] 弹窗状态验证器：如果检测到弹窗依然没有消失，则自动执行物理鼠标坐标点击强行突破！
                const isModalStillOpen = await page.evaluate(() => {
                    return document.body.innerText.includes('Reward Granted');
                });

                if (isModalStillOpen) {
                    console.log("[Warning] Modal is still open after first click attempt. Executing coordinate fallback...");
                    const anchorBox = await page.evaluate(() => {
                        const anchor = Array.from(document.querySelectorAll('*')).find(el => {
                            return el.textContent && el.textContent.includes('Reward Granted') && el.offsetWidth > 0;
                        });
                        if (anchor) {
                            const rect = anchor.getBoundingClientRect();
                            return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
                        }
                        return null;
                    });

                    if (anchorBox) {
                        // 在 "Reward Granted" 蓝色药丸框的最右侧边缘向右偏移 45~55 像素，正好落在 X 关闭按钮的位置
                        const targetX = anchorBox.x + anchorBox.w + 48;
                        const targetY = anchorBox.y + anchorBox.h / 2;
                        console.log(`Clicking physical coordinate fallback: x=${targetX}, y=${targetY}`);
                        await page.mouse.click(targetX, targetY);
                        await sleep(3000);
                    } else {
                        console.log("No anchor found for coordinate click, clicking default modal close area...");
                        await page.mouse.click(740, 290);
                        await sleep(3000);
                    }
                } else {
                    console.log("Modal closed successfully after first click!");
                }
                
                await sleep(3000); // 留时间给页面完成刷新
            } else {
                console.log("Timed out waiting for 'Reward Granted'.");
            }
        } else {
            console.log("No ad modal detected. Falling back to default Turnstile wait.");
            await sleep(20000);
        }

        await page.screenshot({ path: '3_final_result.png' });
        console.log("Saved screenshot: 3_final_result.png");

        // 6. 获取点击后的剩余时间并对比
        const timeAfter = await getRemainingTime(page);
        console.log(`[Timer] Remaining time AFTER click: ${timeAfter}`);

        const secsBefore = timeStringToSeconds(timeBefore);
        const secsAfter = timeStringToSeconds(timeAfter);

        let executionSuccess = false;
        if (secsBefore > 0 && secsAfter > 0) {
            if (secsAfter > secsBefore + 600) {
                console.log(`🎉 Success! Time increased from ${timeBefore} to ${timeAfter}.`);
                executionSuccess = true;
            } else {
                console.log(`⚠️ Warning: Time did NOT increase. (Before: ${timeBefore} -> After: ${timeAfter}).`);
                await sendTelegramNotification(`⚠️ [Gaming4Free] 续期未成功：请下载 Action 的 Artifacts 里的 debug-screenshots.zip 解压，核对点击和验证过程。`);
            }
        } else {
            console.log("Failed to parse remaining time. Skipping delta verification.");
            executionSuccess = true; 
        }

        // 保存 Cookie
        if (executionSuccess) {
            const currentCookies = await page.cookies();
            const newXsrf = currentCookies.find(c => c.name === 'XSRF-TOKEN')?.value;
            const newSession = currentCookies.find(c => c.name === 'pelican_session')?.value;

            if (newXsrf && newSession) {
                const cookiePayload = {
                    xsrf: newXsrf,
                    session: newSession,
                    updatedAt: new Date().toISOString()
                };
                fs.writeFileSync('cookies.json', JSON.stringify(cookiePayload, null, 2));
                console.log("Saved fresh session cookies back to cookies.json");
            }
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
