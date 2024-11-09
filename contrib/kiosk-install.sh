#!/bin/sh

echo "Updating and adding some packages ..."
apt update
apt upgrade -y
apt install dmidecode curl chromium git lightdm metacity nodejs npm sudo -y

echo "Adding kiosk user ..."
adduser --quiet --disabled-password --shell /bin/bash --home /home/kiosk --gecos "User" kiosk

echo "Changing kiosk user password ..."
echo "kiosk:kiosk_password" | chpasswd

echo "Adjusting /etc/hosts to know ws-server name ..."
cp /etc/hosts /etc/hosts.bak
sed -i 's/127.0.0.1\tlocalhost/127.0.0.1	localhost cast/' /etc/hosts
#echo "192.168.11.1  webrtc-cast" >> /etc/hosts

echo "Ensure kiosk user has no sudo prompt ..."
echo "kiosk ALL=(ALL:ALL) NOPASSWD: ALL" > /etc/sudoers.d/kiosk

echo "Setting hostname to cast ..."
echo cast > /etc/hostname

echo "Setting up webrtc-cast repository ..."
su - kiosk -c "
  if [ ! -d /home/kiosk/webrtc-cast ]; then
    echo 'Cloning webrtc-cast repository...'
    git clone https://github.com/unixabg/webrtc-cast.git /home/kiosk/webrtc-cast
  else
    echo 'webrtc-cast repository already exists, pulling latest updates...'
    cd /home/kiosk/webrtc-cast
    git pull
  fi
"

echo "Generating self-signed certificates ..."
su - kiosk -c "
  cd /home/kiosk/webrtc-cast
  if [ ! -f cert.pem ] || [ ! -f key.pem ]; then
    echo 'Creating self-signed certificates...'
    openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -passout pass: -subj '/C=US/ST=State/L=Locality/O=Organization/CN=localhost'
  else
    echo 'Certificates already exist, skipping generation...'
  fi
"

echo "Installing Node.js dependencies ..."
su - kiosk -c "
  cd /home/kiosk/webrtc-cast
  npm install express
"

echo "Setting up the wrapper launcher ..."
cat > /usr/bin/kiosk << EOF
#!/bin/sh

# Disable screen blanking and power saving features
setterm -blank 0 -powersave off -powerdown 0
xset -dpms
xset s off
xset s noblank

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
cat > /usr/share/xsessions/kiosk.desktop << EOF
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
cp /etc/lightdm/lightdm.conf /etc/lightdm/lightdm.conf.bak
sed -i 's/#autologin-user=/autologin-user=kiosk/' /etc/lightdm/lightdm.conf
sed -i 's/#autologin-session=/autologin-session=kiosk/' /etc/lightdm/lightdm.conf

echo "Settings for kiosk done. Type reboot to reboot the computer and test."

