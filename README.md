# gaming4free22-Run

VLESS_LINK             
CONSOLE_URL（例如：https://control.gaming4free.net/server/xxxxxxx/console）。             
COOKIE_XSRF          
COOKIE_SESSION          
TELEGRAM_BOT_TOKEN（可选）        
TELEGRAM_CHAT_ID（可选） 

为了解决 Cookie 频繁过期需要手动更新的痛点，我们可以通过以下思路来实现 Cookie 自动持久化和更新：

自动读取与保存：在运行脚本时，优先读取本地文件 cookies.json。如果该文件不存在，则降级读取您在 GitHub Secrets 中配置的初始值。
动态持久化：每次续期成功后，脚本会提取浏览器中最新的 Session Cookies，将其写入 cookies.json。
回写仓库（Git Commit）：GitHub Actions 执行成功后，自动将更新后的 cookies.json 提交并推送到您的 GitHub 仓库。下一次执行时，工作流就会自动拉取并使用上一次保存的最新 Cookie。


URL：输入下方 API 接口地址（将其中的用户名和项目名换成您自己的）：    
https://api.github.com/repos/fnos9527/gaming4free22-Run/dispatches 
   
Key: Authorization    
Value: Bearer 替换Token

Key: Accept    
Value: application/vnd.github+json    
  
Key: User-Agent   
Value: cron-job.org    

Request Body
```
{
  "event_type": "external-trigger"
}
```

