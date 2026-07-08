# gaming4free22-Run

VLESS_LINK: 您的完整 vless:// 链接（支持 TLS + WS 形式）。           
CONSOLE_URL: 您的服务器控制台页面 URL（例如：https://control.gaming4free.net/server/xxxxxxx/console）。            
COOKIE_XSRF: 您的 XSRF-TOKEN 的 Cookie 原始字符串值[1]。          
COOKIE_SESSION: 您的 pelican_session 的 Cookie 原始字符串值[1]。           
TELEGRAM_BOT_TOKEN（可选）: 用于向您推送 cookie 失效通知的 Telegram Bot Token。         
TELEGRAM_CHAT_ID（可选）: 您的 Telegram 账号 Chat ID。     

为了解决 Cookie 频繁过期需要手动更新的痛点，我们可以通过以下思路来实现 Cookie 自动持久化和更新：

自动读取与保存：在运行脚本时，优先读取本地文件 cookies.json。如果该文件不存在，则降级读取您在 GitHub Secrets 中配置的初始值。
动态持久化：每次续期成功后，脚本会提取浏览器中最新的 Session Cookies，将其写入 cookies.json。
回写仓库（Git Commit）：GitHub Actions 执行成功后，自动将更新后的 cookies.json 提交并推送到您的 GitHub 仓库。下一次执行时，工作流就会自动拉取并使用上一次保存的最新 Cookie。


