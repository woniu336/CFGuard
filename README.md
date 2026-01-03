

### 部署脚本

```
curl -sS -O https://raw.githubusercontent.com/woniu336/open_shell/main/cfserver.sh && chmod +x cfserver.sh && ./cfserver.sh
```


修改令牌

```
cd /opt/cfserver && ./dns-server -reset-token
```

然后重启
```
cd /opt/cfserver && pkill dns-server && nohup ./dns-server > /dev/null 2>&1 &
```


### 部署说明：

1. 上传到 Linux 服务器

   ```bash
   # 将以下文件上传到服务器
   - dns-server (二进制文件)
   - web/ (整个目录)
   ```

2. __在服务器上设置__

   ```bash
   # 赋予执行权限
   chmod +x dns-server

   # 首次运行设置认证令牌
   ./dns-server -reset-token

   # 启动服务
   ./dns-server

   # 或后台运行
   nohup ./dns-server > cfserver.log 2>&1 &
   ```

3. 访问 Web 界面

   - 浏览器访问：http://服务器IP:8081
   
   - 使用设置的令牌登录
   
   - 在界面中配置 Cloudflare 凭证和监控策略
