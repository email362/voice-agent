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
render_dir="$(mktemp -d)"
trap 'rm -rf "$render_dir"' EXIT
deploy/install-user-services.sh --render-dir "$render_dir"
less "$render_dir/voice-agent-rvc.service"
less "$render_dir/voice-agent-web.service"
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

Perform these drills only during a maintenance window. Before each drill, open the private HTTPS URL in Safari on a live iPhone, start a conversation, and confirm microphone input and assistant audio work. After each drill, repeat both local health checks and `tailscale serve status`.

### Node restart

While the iPhone conversation is live, restart the web service from the Linux host:

```bash
systemctl --user restart voice-agent-web.service
systemctl --user status voice-agent-web.service
```

Success means iPhone Safari briefly reports the interruption, reconnects automatically without a tap, and resumes a working spoken turn without reloading the page.

### RVC restart

Stop RVC long enough to exercise degraded audio, speak a turn on the live iPhone, then start it again:

```bash
systemctl --user stop voice-agent-rvc.service
# Speak one turn on the iPhone while RVC is stopped.
systemctl --user start voice-agent-rvc.service
systemctl --user status voice-agent-rvc.service
```

Success means the stopped interval still plays the original audio instead of losing the response. After RVC health returns, a new spoken turn plays converted audio without restarting the Node service or reloading Safari.

### Wi-Fi interruption

With the iPhone conversation still open, turn Wi-Fi off on the Linux host, wait until Safari shows the connection loss, then turn Wi-Fi on. Success means Tailscale returns and iPhone Safari reconnects immediately without a reload or tap; a new spoken turn must complete with assistant audio. Also confirm both systemd units remain active and both local health endpoints respond.

### Safari background and foreground

During a live conversation, send Safari to the iPhone background long enough for iOS to suspend audio, then foreground the same tab. Success means microphone input, assistant playback, and the screen wake lock recover automatically. If iOS requires a user gesture, Safari must show **Tap to Resume**; one tap must restore the wake lock and audio and reconnect the conversation. The page must not remain silently disconnected.

### Unit diagnostics

If either unit repeatedly fails, keep diagnosis under systemd so the installed unit uses the repository `.env` through its `EnvironmentFile` directive:

```bash
journalctl --user -u voice-agent-web.service --since today
journalctl --user -u voice-agent-rvc.service --since today
systemctl --user restart voice-agent-rvc.service voice-agent-web.service
systemctl --user status voice-agent-rvc.service voice-agent-web.service
```

Do not substitute a hand-written foreground RVC command when diagnosing the installed service; it can omit settings loaded from `.env` and fail to reproduce the systemd environment.

### Reboot before login

Reboot the Linux host during a maintenance window, but do not log in locally or over SSH after it starts. From another tailnet device, wait for the private HTTPS health URL and app to return, then open the app in iPhone Safari and complete a spoken turn. Success means the web service, RVC conversion, and Tailscale HTTPS are available before an interactive login. This proves the linger setting, enabled units, and background Serve configuration restore unattended operation. Log in only after that external check if logs or local health details are needed.

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
