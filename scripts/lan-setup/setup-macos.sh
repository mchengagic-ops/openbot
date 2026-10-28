#!/bin/bash
# OpenBot 局域网共享 —— MacBook 客户端一键安装
#
# 做三件事：
#   1. 信任共享的根证书（https 才能用）
#   2. 在桌面生成「OpenBot 共享」启动器（带好环境变量，双击即用）
#   3. 打开浏览器确认证书生效
#
# 用法（在 MacBook 的终端里粘一行）：
#   curl -fsS http://192.168.0.103:8899/setup-macos.sh | bash
set -u

SHARE="192.168.0.103"
API="https://$SHARE:3100"
SIGNAL="wss://$SHARE:3101/v1/signal"
CA_URL="http://$SHARE:8899/mkcert-rootCA.crt"
CA_FILE="/tmp/mkcert-rootCA.crt"
APP="/Applications/OpenBot.app"
LAUNCHER="$HOME/Desktop/OpenBot 共享.app"

echo "==> 1/3 安装根证书（需要输入本机密码）"
if ! curl -fsS -o "$CA_FILE" "$CA_URL"; then
    echo "❌ 下载证书失败：确认这台电脑和 $SHARE 在同一个局域网，并且共享已经打开"
    exit 1
fi
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$CA_FILE"
# 桌面 App 的账号请求由 Electron 主进程发出，走 Node 的 TLS。Node 默认只信任自己内置的根证书，
# 不看 macOS 钥匙串，所以再单独喂一份给 Node。
CA_STORE="$HOME/Library/Application Support/OpenBot-lan"
mkdir -p "$CA_STORE"
cp "$CA_FILE" "$CA_STORE/rootCA.pem"
echo "✅ 证书已加入系统信任，并放好一份给 Node：$CA_STORE/rootCA.pem"

echo "==> 2/3 生成桌面启动器"
if [ ! -d "$APP" ]; then
    echo "⚠️  没找到 $APP"
    echo "   先装 OpenBot for macOS：https://openbot.run"
    echo "   装好后再跑一次这个脚本。"
else
    SCRIPT_FILE="/tmp/openbot-share-client.applescript"
    # 先退出已经在跑的 OpenBot：App 有单实例锁，第二次启动只会把旧窗口切到前面，
    # 环境变量被忽略，于是它仍然连着官方账号服务。
    cat > "$SCRIPT_FILE" <<APPLESCRIPT
do shell script "pkill -x OpenBot > /dev/null 2>&1; sleep 1; OPENBOT_AUTH_API_URL=$API OPENBOT_REMOTE_SIGNAL_URL=$SIGNAL NODE_EXTRA_CA_CERTS=\"$HOME/Library/Application Support/OpenBot-lan/rootCA.pem\" nohup $APP/Contents/MacOS/OpenBot > /dev/null 2>&1 &"
APPLESCRIPT
    osacompile -o "$LAUNCHER" "$SCRIPT_FILE"
    echo "✅ 桌面已生成「OpenBot 共享」"
fi

echo "==> 3/3 验证"
if curl -fsS -o /dev/null --max-time 8 "$API/app"; then
    echo "✅ 共享可访问（证书已生效）：$API/app"
else
    echo "❌ curl 都连不上 $API"
    echo "   证书没装好，或者这台电脑不在 192.168.0.0/24 网段，或者共享没开"
fi

cat <<TIPS

下一步：
  1. 双击桌面「OpenBot 共享」打开客户端
  2. 登录邮箱填：openbot-dev-host@example.com
     验证码直接显示在登录页面上（不发送邮件）
  3. 连上后服务器列表里就是那台 Mac 上的 agent

浏览器也能用：$API/app
TIPS
