# Unattended CPU Deployment

This guide runs the RVC and web services as systemd user units, binds both services to loopback, and publishes the web service privately over Tailscale HTTPS. The deployment target for this host is CPU; it does not require or assume a CUDA GPU.

Run commands from the repository root unless a step says otherwise.

## 1. Prerequisites

Install the Node dependencies and create `.env`:

```bash
npm install
cp .env.example .env
# Edit .env and set DEEPGRAM_API_KEY. Keep RVC_DEVICE=cpu.
```

Create the real RVC environment with Python 3.10 and install its dependencies:

```bash
python3.10 -m venv rvc-service/.venv
rvc-service/.venv/bin/python -m pip install --upgrade pip
rvc-service/.venv/bin/python -m pip install -r rvc-service/requirements.txt
```

Confirm that the expected `.pth` model is discoverable (and, when available, its `.index` file). The post-start health check below must report the configured and effective device as `cpu` and the backend/model as ready before this host is considered healthy.

Install Tailscale, authenticate this host into the intended tailnet, and verify `tailscale status` reports it connected. Tailscale Serve must be allowed by the tailnet policy.

## 2. Inspect rendered units

Render the units into a temporary directory without installing them or calling systemd:

```bash
rm -rf /tmp/voice-agent-units
deploy/install-user-services.sh --render-dir /tmp/voice-agent-units
less /tmp/voice-agent-units/voice-agent-rvc.service
less /tmp/voice-agent-units/voice-agent-web.service
```

Verify that both services bind to `127.0.0.1`, the web service uses port `8787`, and the RVC service sets `RVC_DEVICE=cpu`.

## 3. Install the user units

Port `8787` must be free. Install the rendered units into the current user's systemd configuration and reload the user daemon:

```bash
deploy/install-user-services.sh --port 8787
```

The installer does not enable or start either service.

## 4. Enable boot persistence

Allow this user's services to start during boot without an interactive login session:

```bash
sudo loginctl enable-linger "$USER"
```

## 5. Start the services

Enable and start both units:

```bash
systemctl --user enable --now voice-agent-rvc.service voice-agent-web.service
systemctl --user status voice-agent-rvc.service voice-agent-web.service
```

## 6. Check local health

Check the RVC service first, then the web proxy:

```bash
curl http://127.0.0.1:5055/health
curl http://127.0.0.1:8787/health
```

Do not continue if either command fails. In the RVC response, confirm that `configured_device` and `effective_device` are `cpu`, the intended model paths are present, and backend readiness is healthy.

## 7. Publish private HTTPS with Tailscale

Create a persistent private reverse proxy to the loopback-only web service:

```bash
sudo tailscale serve --bg http://127.0.0.1:8787
tailscale serve status
```

Open the HTTPS URL printed by Tailscale from another authorized device in the same tailnet. This is Tailscale Serve, not Funnel; it does not intentionally publish the app to the public internet.

Per the [official Tailscale Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve), `--bg` keeps the Serve configuration persistent: sharing resumes after the Tailscale daemon restarts and after host reboots, until Serve is disabled.

## 8. Read logs

Follow each unit independently:

```bash
journalctl --user -u voice-agent-web.service -f
journalctl --user -u voice-agent-rvc.service -f
```

For recent non-following output, replace `-f` with `--since today`.

## 9. Failure drills

Perform these drills only during a maintenance window. After each drill, repeat both local health checks and `tailscale serve status`.

### Node restart

```bash
systemctl --user restart voice-agent-web.service
systemctl --user status voice-agent-web.service
```

### RVC restart

```bash
systemctl --user restart voice-agent-rvc.service
systemctl --user status voice-agent-rvc.service
```

### Wi-Fi interruption

Disconnect this host from Wi-Fi briefly, reconnect it, then verify both systemd units are still active, both local health endpoints respond, and Tailscale reconnects. Confirm the private HTTPS URL works from another tailnet device.

### Foreground recovery

If a unit repeatedly fails, stop that unit and run its command in the foreground to expose startup errors. For the web service:

```bash
systemctl --user stop voice-agent-web.service
HOST=127.0.0.1 PORT=8787 node server.js
# Press Ctrl+C after diagnosis, then restore managed operation:
systemctl --user start voice-agent-web.service
```

For RVC, use the CPU deployment target:

```bash
systemctl --user stop voice-agent-rvc.service
cd rvc-service
RVC_HOST=127.0.0.1 RVC_PORT=5055 RVC_DEVICE=cpu .venv/bin/python run.py
# Press Ctrl+C, return to the repository root, then restore managed operation:
cd ..
systemctl --user start voice-agent-rvc.service
```

### Linux reboot

Reboot during a maintenance window. After the host returns, verify the units with `systemctl --user status`, repeat both local health checks, run `tailscale serve status`, and test the private HTTPS URL. The linger setting, enabled units, and background Serve configuration should restore unattended operation.

## 10. Roll back

Stop and disable the units, remove the installed unit files, and reload the user daemon:

```bash
systemctl --user disable --now voice-agent-rvc.service voice-agent-web.service
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/voice-agent-rvc.service"
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/voice-agent-web.service"
systemctl --user daemon-reload
```

Disable the private Tailscale proxy:

```bash
sudo tailscale serve off
```

If this user no longer needs any unattended user services, optionally undo lingering with `sudo loginctl disable-linger "$USER"`.
