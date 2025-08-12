# PatchProof Deployment on DigitalOcean Droplets

This guide sets up a hardened production deploy on a DO Droplet with:
- Secrets in a root-only env file at /etc/patchproof/patchproof.env
- Node app managed by systemd
- Optional Nginx reverse proxy with TLS termination
- One-liner deploy script that restarts the service and runs a health check

## 1) Secrets as a secure env file
Create and lock down an env file owned by root.

```bash
sudo mkdir -p /etc/patchproof
sudo nano /etc/patchproof/patchproof.env
```

Recommended variables:

```
NODE_ENV=production
PORT=3001
MONGODB_URI=mongodb+srv://...
JWT_SECRET=...
API_KEY=...
WOC_NETWORK=main
REDIS_URL=redis://localhost:6379
DEPLOY_SHA=<git-commit-sha>
KMS_SIGN_URL=https://kms.example.com/sign
KMS_API_KEY=<kms-api-key>
ISSUER_KEY_IDENTIFIER=<issuer-key-id>
SVD_USE_KMS=1
SVD_KMS_KID=svd-kms
```

Permissions:

```bash
sudo chown root:root /etc/patchproof/patchproof.env
sudo chmod 600 /etc/patchproof/patchproof.env
```

## 2) systemd service
Copy ops/systemd/patchproof.service to /etc/systemd/system/patchproof.service and adjust paths if needed.

```bash
sudo cp /opt/patchproof/ops/systemd/patchproof.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable patchproof
sudo systemctl start patchproof
sudo systemctl status patchproof
sudo journalctl -u patchproof -f
```

## 3) Optional: Nginx reverse proxy + TLS
Copy ops/nginx/patchproof.conf to /etc/nginx/sites-available/patchproof and replace your_domain.com.

```bash
sudo ln -s /etc/nginx/sites-available/patchproof /etc/nginx/sites-enabled/patchproof
sudo nginx -t
sudo systemctl reload nginx
```

Use certbot to provision certificates, then configure ssl_certificate paths.

## 4) One-liner deploy script
Place ops/deploy.sh on the server and run it to pull latest code, update DEPLOY_SHA, restart, and health check.

```bash
sudo bash /opt/patchproof/ops/deploy.sh
```

## 5) Lockfile hygiene (run once locally/CI)
Pin exact dependency versions to prevent drift:

```bash
npm config set save-exact true
rm -rf node_modules package-lock.json
npm install
```

## 6) Rotation and health runbook
- Edit /etc/patchproof/patchproof.env with new secrets and a fresh DEPLOY_SHA, then restart:
  ```bash
  sudo systemctl restart patchproof
  ```
- Verify new kid and canary:
  - GET /api/svd/kid should show the new kid
  - GET /api/svd/canary with API key → ok: true, kid matches

Troubleshooting: `sudo journalctl -u patchproof -n 100 --no-pager`
