import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SessionRestorePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('Settings'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // --- Behavior group ---
        const behaviorGroup = new Adw.PreferencesGroup({ title: _('Session Behavior') });
        page.add(behaviorGroup);

        const saveRow = new Adw.SwitchRow({
            title: _('Auto-save on logout'),
            subtitle: _('Save the session when logging out, restarting, or shutting down'),
        });
        settings.bind('auto-save-on-logout', saveRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(saveRow);

        const restoreRow = new Adw.SwitchRow({
            title: _('Auto-restore on login'),
            subtitle: _('Reopen applications and restore window layout on login'),
        });
        settings.bind('auto-restore-on-login', restoreRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(restoreRow);

        const resumeRow = new Adw.SwitchRow({
            title: _('Restore on resume from suspend'),
            subtitle: _('Re-apply window positions after waking from suspend'),
        });
        settings.bind('restore-on-resume', resumeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(resumeRow);

        // --- Restore properties group ---
        const restoreGroup = new Adw.PreferencesGroup({ title: _('What to Restore') });
        page.add(restoreGroup);

        const positionRow = new Adw.SwitchRow({
            title: _('Position'),
            subtitle: _('Move windows back to their saved screen position'),
        });
        settings.bind('restore-position', positionRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        restoreGroup.add(positionRow);

        const sizeRow = new Adw.SwitchRow({
            title: _('Size'),
            subtitle: _('Resize windows to their saved dimensions'),
        });
        settings.bind('restore-size', sizeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        restoreGroup.add(sizeRow);

        const workspaceRow = new Adw.SwitchRow({
            title: _('Workspace'),
            subtitle: _('Move windows to their saved workspace'),
        });
        settings.bind('restore-workspace', workspaceRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        restoreGroup.add(workspaceRow);

        // --- Named sessions / default group ---
        const sessionNames = this._listSessionNames();

        const namedGroup = new Adw.PreferencesGroup({ title: _('Named Sessions') });
        page.add(namedGroup);

        const sessionModel = new Gtk.StringList();
        sessionModel.append(_('Last Session'));
        sessionNames.forEach(n => sessionModel.append(n));

        const currentDefault = settings.get_string('default-session');
        const defaultIdx = currentDefault
            ? Math.max(0, sessionNames.indexOf(currentDefault) + 1)
            : 0;

        const defaultRow = new Adw.ComboRow({
            title: _('Restore by default'),
            subtitle: _('Used for auto-restore on login and the Restore keyboard shortcut'),
            model: sessionModel,
            selected: defaultIdx,
        });
        defaultRow.connect('notify::selected', () => {
            const idx = defaultRow.selected;
            settings.set_string('default-session', idx === 0 ? '' : sessionNames[idx - 1]);
        });
        namedGroup.add(defaultRow);

        // --- Shortcuts group ---
        const shortcutsGroup = new Adw.PreferencesGroup({
            title: _('Keyboard Shortcuts'),
            description: _('Default: Super+Shift+S to save, Super+Shift+R to restore'),
        });
        page.add(shortcutsGroup);

        shortcutsGroup.add(this._makeShortcutRow(
            _('Save session'),
            settings,
            'save-session-shortcut'
        ));
        shortcutsGroup.add(this._makeShortcutRow(
            _('Restore session'),
            settings,
            'restore-session-shortcut'
        ));
    }

    _listSessionNames() {
        const sessionsDir = GLib.build_filenamev([
            GLib.get_user_data_dir(), 'gnome-session-restore', 'sessions',
        ]);
        try {
            const dir = Gio.File.new_for_path(sessionsDir);
            if (!dir.query_exists(null)) return [];
            const iter = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            const names = [];
            let info;
            while ((info = iter.next_file(null)) !== null) {
                const fname = info.get_name();
                if (fname.endsWith('.json')) names.push(fname.slice(0, -5));
            }
            iter.close(null);
            return names.sort((a, b) => a.localeCompare(b));
        } catch (_e) {
            return [];
        }
    }

    _makeShortcutRow(title, settings, key) {
        const row = new Adw.ActionRow({ title });
        const label = new Adw.ShortcutLabel({
            valign: 1, // Gtk.Align.CENTER
            disabled_text: _('Disabled'),
        });

        const updateLabel = () => {
            const shortcuts = settings.get_strv(key);
            label.accelerator = shortcuts[0] ?? '';
        };
        updateLabel();
        settings.connect(`changed::${key}`, updateLabel);

        row.add_suffix(label);
        return row;
    }
}
