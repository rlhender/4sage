#!/bin/bash
# 4sage.dev deployment script — run on VPS as openclaw with sudo

set -e

echo "=== Setting up 4sage.dev ==="

# 1. Create web root and copy files
echo "Creating /var/www/4sage.dev..."
sudo mkdir -p /var/www/4sage.dev
sudo cp /tmp/index.html /tmp/style.css /var/www/4sage.dev/
sudo chown -R www-data:www-data /var/www/4sage.dev

# 2. Create nginx config
echo "Creating nginx config..."
sudo tee /etc/nginx/sites-available/4sage.dev > /dev/null << 'NGINX'
server {
    listen 80;
    server_name 4sage.dev www.4sage.dev;

    root /var/www/4sage.dev;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
NGINX

# 3. Enable the site (skip if already linked)
if [ ! -L /etc/nginx/sites-enabled/4sage.dev ]; then
    echo "Enabling site..."
    sudo ln -s /etc/nginx/sites-available/4sage.dev /etc/nginx/sites-enabled/
else
    echo "Site already enabled."
fi

# 4. Test and reload nginx
echo "Testing nginx config..."
sudo nginx -t
echo "Reloading nginx..."
sudo systemctl reload nginx

echo ""
echo "=== Done! ==="
echo "Site should be live at http://4sage.dev"
echo ""
echo "Next step: run this to get HTTPS:"
echo "  sudo certbot --nginx -d 4sage.dev -d www.4sage.dev"
