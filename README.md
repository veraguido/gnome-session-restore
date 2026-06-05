# GNOME Session Restore

A GNOME Shell extension that saves and restores your window session — positions, sizes, workspaces, maximized/minimized/fullscreen states — across logouts, reboots, and optionally suspend/resume cycles.

Supports **GNOME 45 through 50**, Wayland and X11.

---

## Features

- **Auto-save on logout** — session is captured when you log out, restart, or shut down
- **Auto-restore on login** — saved apps are relaunched and windows are repositioned on your next login
- **Manual save/restore** — keyboard shortcuts (`Super+Shift+S` / `Super+Shift+R`) trigger save or restore at any time
- **Suspend/resume support** — optionally re-apply window positions after waking from suspend (useful when monitor configuration changes)
- **Multi-workspace aware** — each window is restored to the workspace it was on; workspaces are created automatically if needed
- **Multi-monitor aware** — the monitor index is saved alongside position
- **Configurable via GNOME Extensions** preferences UI

---

## Requirements

- GNOME Shell 45–50
- `glib-compile-schemas` (part of `glib2` / `libglib2.0-bin`, usually already installed)
- `gnome-extensions` CLI (part of `gnome-shell`)

---

## Installation

```bash
git clone https://github.com/you/gnome-session-restore.git
cd gnome-session-restore
make install
make enable
```

On **Wayland** (which is the default on modern Fedora/Ubuntu), you must log out and back in after the first install for GNOME Shell to pick up the new extension. On **X11** you can run `make restart` instead.

To uninstall:

```bash
make uninstall
```

---

## Makefile targets

| Target | Description |
|---|---|
| `make install` | Compile schema and copy files to `~/.local/share/gnome-shell/extensions/` |
| `make uninstall` | Remove the extension directory |
| `make enable` | Enable the extension via `gnome-extensions` |
| `make disable` | Disable the extension |
| `make restart` | Restart GNOME Shell (X11 only; on Wayland, log out/in) |
| `make logs` | Stream extension log output from the journal |
| `make pack` | Create a distributable `session-restore@guido.local.zip` |
| `make clean` | Remove compiled schema and zip artifacts |

---

## How it works

### Why an extension and not a standalone app?

On **Wayland**, applications cannot read other windows' geometry or move windows belonging to other processes. Only the compositor itself has that access. GNOME Shell extensions run *inside* the compositor process (Mutter), so they have full access to `Meta.Window` — the internal representation of every window — including the ability to read and set positions, sizes, workspaces, and states. A standalone app cannot do this on Wayland.

### Save

When a save is triggered (logout or manual shortcut), the extension iterates over all `NORMAL`-type windows (skipping panels, docks, dialogs, etc.) and records:

- GTK application ID / Flatpak app ID / WM class — used to relaunch the app
- Window title
- Workspace index
- Monitor index
- Frame rectangle (x, y, width, height)
- Maximized flags (`Meta.MaximizeFlags`: none / horizontal / vertical / both)
- Minimized and fullscreen states

The result is written as JSON to `~/.local/share/gnome-session-restore/session.json`.

### Restore

On login, the extension waits 2 seconds for the desktop to settle, then — only if no normal windows are already open (i.e. it really is a fresh login) — reads `session.json` and:

1. **Launches** each saved app via `Shell.AppSystem` (searches by app ID, then WM class, then fuzzy name match)
2. **Listens** for `window-created` signals on the display
3. **Matches** each new window to a pending restoration by WM class (FIFO order for multiple windows of the same app)
4. **Applies** the saved state 600 ms after the window is created, giving the app time to finish its own initialization

### Suspend/resume

The extension subscribes to the `PrepareForSleep` signal from `org.freedesktop.login1` (systemd-logind). When `goingToSleep = false` (wake-up), it optionally re-runs the restore pass. This is most useful when monitors are connected or disconnected before resuming.

---

## Limitations

### Window positioning is best-effort

On Wayland, we apply the saved position 600 ms after the window appears. Apps that save and restore their own geometry (Firefox, many GTK apps, Electron apps) will typically override our position shortly after. There is no Wayland protocol that allows pre-positioning a window before it draws itself — this is a fundamental Wayland constraint, not a bug in the extension.

**Workaround**: For apps that fight the positioning, try disabling their own "remember window size" option in their settings.

### Apps need a `.desktop` entry

Relaunching an app requires finding it in the GNOME app registry. Apps without a `.desktop` file (custom scripts, some Electron apps, certain development tools) will have their state *saved* but cannot be *relaunched* automatically. A warning is logged to the journal in this case.

### Multiple windows of the same app

If you had three terminal windows open, they are restored in the order they were originally opened (FIFO). The extension has no way to distinguish "the terminal on the left" from "the terminal on the right" after a relaunch — they are matched purely by WM class.

### Third-party tiling extensions

[Pop Shell](https://github.com/pop-os/shell), [PaperWM](https://github.com/paperwm/PaperWM), [Auto Tiler](https://github.com/nicowillis/auto-tiler), etc. manage tiling in their own data structures. This extension saves and restores raw window geometry, which preserves GNOME's built-in snap-tiling (since it is just position + size), but does **not** restore the internal state of third-party tiling extensions.

---

## Session file format

`~/.local/share/gnome-session-restore/session.json`

```json
{
  "timestamp": "2025-06-05T10:30:00.000Z",
  "windows": [
    {
      "appId": "org.gnome.Nautilus",
      "wmClass": "Nautilus",
      "title": "Home",
      "workspace": 0,
      "monitor": 0,
      "x": 100,
      "y": 50,
      "width": 900,
      "height": 600,
      "maximized": 0,
      "minimized": false,
      "fullscreen": false
    }
  ]
}
```

You can edit this file manually or keep multiple named copies and swap them in before a manual restore.

---

## Configuration

Open **GNOME Extensions → Session Restore → Settings** or run:

```bash
gnome-extensions prefs session-restore@guido.local
```

| Setting | Default | Description |
|---|---|---|
| Auto-save on logout | On | Save session on logout / restart / shutdown |
| Auto-restore on login | On | Restore session on login (only on a fresh desktop with no open windows) |
| Restore on resume | Off | Re-apply positions after waking from suspend |
| Save shortcut | `Super+Shift+S` | Manually save the current session |
| Restore shortcut | `Super+Shift+R` | Manually restore the last saved session |

---

## Debugging

Stream live logs from the extension:

```bash
make logs
```

Or view the full GNOME Shell log:

```bash
journalctl -b /usr/bin/gnome-shell | grep SessionRestore
```
