import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const SESSION_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-session-restore']);
const SESSION_FILE = GLib.build_filenamev([SESSION_DIR, 'session.json']);

// Delay after login before attempting restore, to let the desktop settle.
const LOGIN_RESTORE_DELAY_MS = 2000;
// Delay after a window is created before applying saved state, to let the app
// finish its own initialization and painting.
const WINDOW_READY_DELAY_MS = 800;

export default class SessionRestoreExtension extends Extension {
    _settings = null;
    _windowCreatedId = null;
    _suspendSubId = null;
    _indicator = null;
    // Map of wmClass (lowercase) -> Array<savedWindowState>, consumed as windows open.
    _pendingRestorations = new Map();

    enable() {
        this._settings = this.getSettings();

        this._windowCreatedId = global.display.connect(
            'window-created',
            (_display, window) => this._onWindowCreated(window)
        );

        this._setupSuspendListener();
        this._bindShortcuts();
        this._addPanelIndicator();

        if (this._settings.get_boolean('auto-restore-on-login')) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, LOGIN_RESTORE_DELAY_MS, () => {
                // Only auto-restore on a fresh login (no normal windows open yet).
                const hasWindows = global.get_window_actors().some(
                    a => a.get_meta_window().window_type === Meta.WindowType.NORMAL
                );
                if (!hasWindows)
                    this._restoreSession();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    disable() {
        // disable() is called on logout/restart/shutdown as well as manual disabling.
        // Saving here covers the logout case; it is harmless on manual disable.
        if (this._settings?.get_boolean('auto-save-on-logout'))
            this._saveSession();

        Main.wm.removeKeybinding('save-session-shortcut');
        Main.wm.removeKeybinding('restore-session-shortcut');

        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = null;
        }

        if (this._suspendSubId) {
            Gio.DBus.system.signal_unsubscribe(this._suspendSubId);
            this._suspendSubId = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._pendingRestorations.clear();
        this._settings = null;
    }

    // -------------------------------------------------------------------------
    // Panel indicator
    // -------------------------------------------------------------------------

    _addPanelIndicator() {
        this._indicator = new PanelMenu.Button(0.0, 'Session Restore', false);

        const icon = new St.Icon({
            icon_name: 'view-restore-symbolic',
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(icon);

        const saveItem = new PopupMenu.PopupMenuItem('Save Session');
        saveItem.connect('activate', () => this._saveSession());
        this._indicator.menu.addMenuItem(saveItem);

        const restoreItem = new PopupMenu.PopupMenuItem('Restore Session');
        restoreItem.connect('activate', () => this._restoreSession());
        this._indicator.menu.addMenuItem(restoreItem);

        Main.panel.addToStatusArea('session-restore', this._indicator);
    }

    // -------------------------------------------------------------------------
    // Save
    // -------------------------------------------------------------------------

    _saveSession() {
        const windows = [];

        for (const actor of global.get_window_actors()) {
            const win = actor.get_meta_window();
            if (win.window_type !== Meta.WindowType.NORMAL || win.is_skip_taskbar())
                continue;

            const rect = win.get_frame_rect();
            windows.push({
                appId: win.get_gtk_application_id() ?? win.get_sandboxed_app_id() ?? null,
                wmClass: win.get_wm_class() ?? '',
                title: win.get_title() ?? '',
                workspace: win.get_workspace()?.index() ?? 0,
                monitor: win.get_monitor(),
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                // Meta.MaximizeFlags: 0=none, 1=horizontal, 2=vertical, 3=both
                maximized: (win.maximized_horizontally ? Meta.MaximizeFlags.HORIZONTAL : 0) |
                    (win.maximized_vertically ? Meta.MaximizeFlags.VERTICAL : 0),
                minimized: win.minimized,
                fullscreen: win.fullscreen,
            });
        }

        try {
            GLib.mkdir_with_parents(SESSION_DIR, 0o755);
            const payload = JSON.stringify({ timestamp: new Date().toISOString(), windows }, null, 2);
            GLib.file_set_contents(SESSION_FILE, payload);
            Main.notify('Session Restore', `Session saved — ${windows.length} window${windows.length !== 1 ? 's' : ''}`);
        } catch (e) {
            const msg = e.message ?? String(e);
            console.error('[SessionRestore] Failed to save session:', msg);
            Main.notify('Session Restore', `Failed to save session: ${msg}`);
        }
    }

    // -------------------------------------------------------------------------
    // Restore
    // -------------------------------------------------------------------------

    _restoreSession() {
        const file = Gio.File.new_for_path(SESSION_FILE);
        if (!file.query_exists(null)) {
            Main.notify('Session Restore', 'No saved session found');
            return;
        }

        let session;
        try {
            const [, bytes] = file.load_contents(null);
            session = JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            const msg = e.message ?? String(e);
            console.error('[SessionRestore] Failed to parse session file:', msg);
            Main.notify('Session Restore', `Failed to load session file: ${msg}`);
            return;
        }

        // Index all currently open normal windows by WM class so we can
        // reposition them in place rather than launching duplicate instances.
        const openByClass = new Map(); // wmClass (lower) -> MetaWindow[]
        for (const actor of global.get_window_actors()) {
            const win = actor.get_meta_window();
            if (win.window_type !== Meta.WindowType.NORMAL || win.skip_taskbar)
                continue;
            const key = win.get_wm_class()?.toLowerCase();
            if (!key) continue;
            if (!openByClass.has(key)) openByClass.set(key, []);
            openByClass.get(key).push(win);
        }

        let repositioned = 0;
        let launched = 0;

        for (const state of session.windows) {
            const key = state.wmClass.toLowerCase();
            const existing = openByClass.get(key);

            if (existing?.length) {
                // Reuse an already-open window — apply saved state to it directly.
                const win = existing.shift();
                if (existing.length === 0) openByClass.delete(key);
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, WINDOW_READY_DELAY_MS, () => {
                    this._applyWindowState(win, state);
                    return GLib.SOURCE_REMOVE;
                });
                repositioned++;
            } else {
                // No existing window — launch a new instance and queue its state.
                if (!this._pendingRestorations.has(key))
                    this._pendingRestorations.set(key, []);
                this._pendingRestorations.get(key).push(state);
                this._launchApp(state);
                launched++;
            }
        }

        const parts = [];
        if (repositioned > 0) parts.push(`${repositioned} repositioned`);
        if (launched > 0) parts.push(`${launched} launched`);
        Main.notify('Session Restore', `Session restored — ${parts.join(', ')}`);
    }

    _launchApp(state) {
        const appSystem = Shell.AppSystem.get_default();

        // Try increasingly broad strategies to find the app's Shell.App entry.
        const candidates = [
            state.appId ? `${state.appId}.desktop` : null,
            state.appId,
            state.wmClass ? `${state.wmClass}.desktop` : null,
            state.wmClass,
        ].filter(Boolean);

        for (const id of candidates) {
            const app = appSystem.lookup_app(id);
            if (app) {
                app.open_new_window(-1);
                return;
            }
        }

        // Last resort: fuzzy match against all installed apps by name or id.
        const needle = state.wmClass.toLowerCase();
        for (const app of appSystem.get_installed()) {
            const id = app.get_id()?.toLowerCase() ?? '';
            const name = app.get_name()?.toLowerCase() ?? '';
            if (id.includes(needle) || name === needle) {
                app.open_new_window(-1);
                return;
            }
        }

        console.log(`[SessionRestore] No launcher found for: ${state.wmClass} (appId: ${state.appId})`);
    }

    _onWindowCreated(window, retries = 0) {
        if (this._pendingRestorations.size === 0)
            return;

        const key = window.get_wm_class()?.toLowerCase();
        if (!key) {
            // wm_class not set yet — retry once after a short delay
            if (retries < 3) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                    this._onWindowCreated(window, retries + 1);
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }

        const pending = this._pendingRestorations.get(key);
        if (!pending?.length)
            return;

        // Consume the oldest pending entry for this WM class (FIFO).
        const state = pending.shift();
        if (pending.length === 0)
            this._pendingRestorations.delete(key);

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, WINDOW_READY_DELAY_MS, () => {
            this._applyWindowState(window, state);
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyWindowState(window, state) {
        if (!window.get_compositor_private())
            return;

        const restoreWorkspace = this._settings.get_boolean('restore-workspace');
        const restorePosition  = this._settings.get_boolean('restore-position');
        const restoreSize      = this._settings.get_boolean('restore-size');

        if (restoreWorkspace) {
            const wsManager = global.workspace_manager;
            while (wsManager.n_workspaces <= state.workspace)
                wsManager.append_new_workspace(false, global.get_current_time());
            window.change_workspace_by_index(state.workspace, false);
        }

        // Move to the correct monitor before geometry adjustments.
        if (restorePosition && state.monitor !== undefined && state.monitor !== window.get_monitor())
            window.move_to_monitor(state.monitor);

        if (state.fullscreen) {
            window.make_fullscreen();
        } else {
            // Unmaximize first so move_resize_frame takes effect.
            if ((restorePosition || restoreSize) &&
                (window.maximized_horizontally || window.maximized_vertically))
                window.unmaximize(Meta.MaximizeFlags.BOTH);

            const x      = restorePosition ? state.x      : window.get_frame_rect().x;
            const y      = restorePosition ? state.y      : window.get_frame_rect().y;
            const width  = restoreSize     ? state.width  : window.get_frame_rect().width;
            const height = restoreSize     ? state.height : window.get_frame_rect().height;

            if (restorePosition || restoreSize)
                window.move_resize_frame(true, x, y, width, height);

            if ((restorePosition || restoreSize) && state.maximized)
                window.maximize(state.maximized);
        }

        if (state.minimized)
            window.minimize();
    }

    // -------------------------------------------------------------------------
    // Keyboard shortcuts
    // -------------------------------------------------------------------------

    _bindShortcuts() {
        // Remove first in case a previous enable() left them registered.
        Main.wm.removeKeybinding('save-session-shortcut');
        Main.wm.removeKeybinding('restore-session-shortcut');
        Main.wm.addKeybinding(
            'save-session-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => this._saveSession()
        );
        Main.wm.addKeybinding(
            'restore-session-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => this._restoreSession()
        );
    }

    // -------------------------------------------------------------------------
    // Suspend / resume
    // -------------------------------------------------------------------------

    _setupSuspendListener() {
        this._suspendSubId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.login1',
            'org.freedesktop.login1.Manager',
            'PrepareForSleep',
            '/org/freedesktop/login1',
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [goingToSleep] = params.unpack();
                if (!goingToSleep && this._settings?.get_boolean('restore-on-resume')) {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, LOGIN_RESTORE_DELAY_MS, () => {
                        this._restoreSession();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            }
        );
    }
}
