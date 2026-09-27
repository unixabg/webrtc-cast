#!/bin/sh
# webrtc-cast kiosk setup for Debian 13 (trixie).
#
# Run as root on an installed system:
#   sudo contrib/kiosk-install.sh
#
# Or from a d-i preseed late_command (runs inside the target chroot):
#   d-i preseed/late_command string \
#       in-target sh -c 'wget -qO /tmp/kiosk-install.sh https://raw.githubusercontent.com/unixabg/webrtc-cast/main/contrib/kiosk-install.sh \
#         && chmod +x /tmp/kiosk-install.sh \
#         && /tmp/kiosk-install.sh > /var/log/kiosk-setup.log 2>&1'; \
#       true

if [ "$(id -u)" != "0" ]; then
    echo "This script must be run as root (sudo contrib/kiosk-install.sh)."
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

echo "Updating and adding some packages ..."
apt-get update
apt-get -y upgrade

# Pre-answer the display-manager question so lightdm can't block on debconf
echo "lightdm shared/default-x-display-manager select lightdm" | debconf-set-selections

apt-get -y install \
    dmidecode curl git sudo openssl ca-certificates \
    chromium lightdm metacity \
    xserver-xorg x11-xserver-utils \
    nodejs npm alsa-utils

echo "Adding kiosk user ..."
adduser --quiet --disabled-password --shell /bin/bash \
        --home /home/kiosk --gecos "User" kiosk

echo "Changing kiosk user password ..."
echo "kiosk:kiosk_password" | chpasswd

echo "Adjusting /etc/hosts to know ws-server name ..."
cp /etc/hosts /etc/hosts.bak
sed -i 's/127.0.0.1\tlocalhost/127.0.0.1\tlocalhost cast/' /etc/hosts
#echo "192.168.11.1  webrtc-cast" >> /etc/hosts

echo "Ensure kiosk user has no sudo prompt ..."
echo "kiosk ALL=(ALL:ALL) NOPASSWD: ALL" > /etc/sudoers.d/kiosk
chmod 0440 /etc/sudoers.d/kiosk

echo "Setting up webrtc-cast repository ..."
runuser -l kiosk -c '
  if [ ! -d /home/kiosk/webrtc-cast ]; then
    echo "Cloning webrtc-cast repository..."
    git clone https://github.com/unixabg/webrtc-cast.git /home/kiosk/webrtc-cast
  else
    echo "webrtc-cast repository already exists, pulling latest updates..."
    cd /home/kiosk/webrtc-cast
    git pull
  fi
'

echo "Generating self-signed certificates ..."
runuser -l kiosk -c '
  cd /home/kiosk/webrtc-cast || exit 1
  if [ ! -f cert.pem ] || [ ! -f key.pem ]; then
    echo "Creating self-signed certificates..."
    openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem \
      -days 3650 -nodes -passout pass: \
      -subj "/C=US/ST=State/L=Locality/O=Organization/CN=localhost"
  else
    echo "Certificates already exist, skipping generation..."
  fi
'

echo "Installing Node.js dependencies ..."
runuser -l kiosk -c '
  cd /home/kiosk/webrtc-cast || exit 1
  npm install express
'

echo "Setting up the wrapper launcher ..."
cat > /usr/bin/kiosk << 'EOF'
#!/bin/sh

# Disable screen blanking and power saving features
setterm -blank 0 -powersave off -powerdown 0
xset -dpms
xset s off
xset s noblank

# Optionally pin the output resolution (see contrib/display-mode.sh)
sh /home/kiosk/webrtc-cast/contrib/display-mode.sh

# Start WebRTC-cast server
echo "Starting the WebRTC-cast services ..."
cd /home/kiosk/webrtc-cast
nodejs nodejs/ws.js &

# Clear Chromium cache and config
echo "Just for sanity let's drop the .cache and .config for kiosk."
rm -rf /home/kiosk/.cache/chromium
rm -rf /home/kiosk/.config/chromium
rm -f /var/cache/lightdm/dmrc/kiosk.dmrc

# Launch metacity window manager
/usr/bin/metacity &

# Launch Chromium in kiosk mode
chromium --disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies --autoplay-policy=no-user-gesture-required --ignore-certificate-errors --ignore-urlfetcher-cert-requests --ignore-websocket-cert-errors --kiosk https://localhost:8443/listening-chrome.html
EOF

echo "Make sure the kiosk script is 0755"
chmod 0755 /usr/bin/kiosk

echo "Setting up the .desktop for the display manager to kick off ..."
mkdir -p /usr/share/xsessions
cat > /usr/share/xsessions/kiosk.desktop << 'EOF'
[Desktop Entry]
Encoding=UTF-8
Name=Kiosk
Comment=This session logs you into a chromium kiosk session.
Exec=/usr/bin/kiosk
# no icon yet, only the top three are currently used
Icon=
Type=Application
EOF

echo "Adjusting lightdm to kickoff the kiosk ..."
# Drop-in instead of sed'ing lightdm.conf: survives package upgrades and does not
# depend on the shipped file still having those exact commented-out lines.
mkdir -p /etc/lightdm/lightdm.conf.d
cat > /etc/lightdm/lightdm.conf.d/50-kiosk.conf << 'EOF'
[Seat:*]
autologin-user=kiosk
autologin-session=kiosk
autologin-user-timeout=0
EOF

# Make sure lightdm actually comes up on first boot (enable is a no-op in chroot
# for the socket, but the symlink is what matters and it persists).
systemctl enable lightdm 2>/dev/null || true
systemctl set-default graphical.target 2>/dev/null || true

echo "Settings for kiosk done. Reboot to start the kiosk."
exit 0
